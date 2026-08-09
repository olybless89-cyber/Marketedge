import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import {
  users, transactions, ledger, plans as plansT, traders as tradersT,
  traderTrades, notifications, investments,
} from '../db/schema.js';
import { requireAdmin } from '../lib/auth.js';
import { render, eta } from '../lib/view.js';
import { traderStats, balance, unreadCount } from '../lib/stats.js';
import * as fmt from '../lib/money.js';

export const admin = new Hono();
admin.use('*', requireAdmin);

const svg = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">${d}</svg>`;
const NAV = [
  { label: 'Overview', items: [
    { href: '/admin', label: 'Dashboard', icon: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>') },
  ]},
  { label: 'Money', items: [
    { href: '/admin/deposits',    label: 'Deposits',    icon: svg('<path d="M12 3v13M6 11l6 6 6-6M4 21h16"/>') },
    { href: '/admin/withdrawals', label: 'Withdrawals', icon: svg('<path d="M12 21V8M6 13l6-6 6 6M4 3h16"/>') },
    { href: '/admin/plans',       label: 'Plans',       icon: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>') },
  ]},
  { label: 'People', items: [
    { href: '/admin/users',   label: 'Users',   icon: svg('<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.9"/>') },
    { href: '/admin/traders', label: 'Traders', icon: svg('<path d="M3 17l5-6 4 4 6-8"/><path d="M3 21h18"/>') },
  ]},
];

const shell = async (c, view, data, title) => {
  const u = c.get('user');
  const [bal, unread] = await Promise.all([balance(u.id), unreadCount(u.id)]);
  const body = eta.render(view, { ...fmt, ...data, user: u, csrf: c.get('csrf') });
  return render(c, 'layouts/app', { body, title, nav: NAV, bal, unread });
};

/* ---------------- overview ---------------- */
admin.get('/admin', async (c) => {
  const [k] = await sql`
    select (select count(*) from users where role='user')                                   users,
           (select count(*) from users where role='user' and created_at > now()-interval '7 days') new_users,
           (select coalesce(sum(amount),0) from transactions where type='deposit' and status='approved')::text deposits,
           (select coalesce(sum(amount),0) from transactions where type='withdrawal' and status='approved')::text withdrawals,
           (select count(*) from transactions where status='pending')                       pending,
           (select coalesce(sum(amount),0) from transactions where status='pending')::text  pending_value,
           (select count(*) from investments where status='active')                         active_plans,
           (select coalesce(sum(principal),0) from investments where status='active')::text staked,
           (select count(*) from trader_trades where status='open')                         open_trades`;

  const queue = await sql`
    select t.*, u.first_name, u.last_name, u.email
    from transactions t join users u on u.id = t.user_id
    where t.status = 'pending' order by t.created_at asc limit 12`;

  return shell(c, 'admin/overview', { k, queue }, 'Admin');
});

/* ---------------- transaction review ---------------- */
const listTx = (type) => async (c) => {
  const status = c.req.query('status') || 'pending';
  const rows = await sql`
    select t.*, u.first_name, u.last_name, u.email
    from transactions t join users u on u.id = t.user_id
    where t.type = ${type} ${status === 'all' ? sql`` : sql`and t.status = ${status}`}
    order by t.created_at desc limit 100`;
  return shell(c, 'admin/transactions', { rows, type, status }, type === 'deposit' ? 'Deposits' : 'Withdrawals');
};
admin.get('/admin/deposits', listTx('deposit'));
admin.get('/admin/withdrawals', listTx('withdrawal'));

admin.post('/admin/transactions/:id/:action', async (c) => {
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');           // approve | reject
  const me = c.get('user');
  const note = String(c.get('body')?.note || '');

  const [t] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
  if (!t) return c.notFound();
  if (t.status !== 'pending') return c.redirect(`/admin/${t.type}s`);

  const amount = Number(t.amount);

  if (action === 'approve') {
    await db.update(transactions).set({
      status: 'approved', reviewedBy: me.id, reviewedAt: new Date(), adminNote: note,
    }).where(eq(transactions.id, id));

    if (t.type === 'deposit') {
      // Deposit posts to the ledger only now — this is the single place
      // where money enters the system.
      await db.insert(ledger).values({
        userId: t.userId, account: 'main', kind: 'deposit', amount: String(amount),
        refType: 'transaction', refId: id, memo: `Deposit via ${t.method} confirmed`,
      });
    }
    // Withdrawals were already held at request time; approving just settles it.

    await db.insert(notifications).values({
      userId: t.userId, kind: 'success',
      title: t.type === 'deposit' ? 'Deposit confirmed' : 'Withdrawal sent',
      body: `${fmt.usd(amount)} ${t.type === 'deposit' ? 'is now available in your account.' : 'has been sent to your destination address.'}`,
    });

  } else {
    await db.update(transactions).set({
      status: 'rejected', reviewedBy: me.id, reviewedAt: new Date(), adminNote: note,
    }).where(eq(transactions.id, id));

    if (t.type === 'withdrawal') {
      // Release the hold placed when the request was made.
      await db.insert(ledger).values({
        userId: t.userId, account: 'main', kind: 'withdrawal_release', amount: String(amount),
        refType: 'transaction', refId: id, memo: 'Withdrawal declined, funds returned',
      });
    }
    await db.insert(notifications).values({
      userId: t.userId, kind: 'warn',
      title: `${t.type === 'deposit' ? 'Deposit' : 'Withdrawal'} declined`,
      body: note || 'Contact support for details.',
    });
  }

  return c.redirect(`/admin/${t.type}s`);
});

/* ---------------- users ---------------- */
admin.get('/admin/users', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const rows = await sql`
    select u.id, u.first_name, u.last_name, u.email, u.country, u.status, u.role,
           u.kyc_status, u.created_at,
           coalesce((select sum(amount) from ledger where user_id = u.id), 0)::text balance,
           coalesce((select sum(amount) from transactions
                     where user_id = u.id and type='deposit' and status='approved'), 0)::text deposited
    from users u
    ${q ? sql`where u.email ilike ${'%' + q + '%'} or u.first_name ilike ${'%' + q + '%'} or u.last_name ilike ${'%' + q + '%'}` : sql``}
    order by u.created_at desc limit 100`;
  return shell(c, 'admin/users', { rows, q }, 'Users');
});

admin.post('/admin/users/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const to = String(c.get('body').status) === 'suspended' ? 'suspended' : 'active';
  if (id === c.get('user').id) return c.redirect('/admin/users');   // don't lock yourself out
  await db.update(users).set({ status: to }).where(eq(users.id, id));
  return c.redirect('/admin/users');
});

/* Manual balance correction. Writes a ledger line like everything else,
   so it shows up in the client's statement and can be explained. */
admin.post('/admin/users/:id/adjust', async (c) => {
  const id = Number(c.req.param('id'));
  const b = c.get('body');
  const amount = Number(b.amount);
  const memo = String(b.memo || '').trim();
  if (!amount || !memo) return c.redirect('/admin/users?e=' + encodeURIComponent('An adjustment needs both an amount and a reason.'));

  await db.insert(ledger).values({
    userId: id, account: 'main', kind: 'adjustment', amount: String(amount),
    memo: `${memo} (by ${c.get('user').email})`,
  });
  await db.insert(notifications).values({
    userId: id, kind: 'info', title: 'Balance adjusted',
    body: `${fmt.signedUsd(amount)} — ${memo}`,
  });
  return c.redirect('/admin/users');
});

/* ---------------- traders ---------------- */
admin.get('/admin/traders', async (c) => {
  const rows = await traderStats();
  return shell(c, 'admin/traders', { rows, ok: c.req.query('ok') }, 'Traders');
});

admin.post('/admin/traders', async (c) => {
  const b = c.get('body');
  const name = String(b.displayName || '').trim();
  if (!name) return c.redirect('/admin/traders');
  await db.insert(tradersT).values({
    displayName: name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6),
    strategy: String(b.strategy || 'Discretionary'),
    bio: String(b.bio || ''),
    minCopy: String(Number(b.minCopy) || 100),
    riskScore: Math.max(1, Math.min(10, Number(b.riskScore) || 5)),
  });
  return c.redirect('/admin/traders?ok=1');
});

admin.post('/admin/traders/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  await sql`update traders set active = not active where id = ${id}`;
  return c.redirect('/admin/traders');
});

/* ---------------- plans ---------------- */
admin.get('/admin/plans', async (c) => {
  const rows = await db.select().from(plansT).orderBy(plansT.sortOrder);
  return shell(c, 'admin/plans', { rows, ok: c.req.query('ok') }, 'Plans');
});

admin.post('/admin/plans', async (c) => {
  const b = c.get('body');
  const name = String(b.name || '').trim();
  if (!name) return c.redirect('/admin/plans');
  await db.insert(plansT).values({
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    roiPercent: String(Number(b.roiPercent) || 1),
    periodHours: Number(b.periodHours) || 24,
    durationPeriods: Number(b.durationPeriods) || 30,
    minAmount: String(Number(b.minAmount) || 100),
    maxAmount: String(Number(b.maxAmount) || 10000),
    features: ['Principal returned at maturity', 'Withdraw accrued returns anytime', 'Full charting access', '24/7 support'],
    sortOrder: Number(b.sortOrder) || 0,
  });
  return c.redirect('/admin/plans?ok=1');
});

admin.post('/admin/plans/:id/toggle', async (c) => {
  await sql`update plans set active = not active where id = ${Number(c.req.param('id'))}`;
  return c.redirect('/admin/plans');
});
