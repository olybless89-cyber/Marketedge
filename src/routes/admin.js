import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import {
  users, transactions, ledger, plans as plansT, traders as tradersT,
  traderTrades, notifications, investments, kycSubmissions, mailLog,
} from '../db/schema.js';
import { requireAdmin } from '../lib/auth.js';
import { render, eta } from '../lib/view.js';
import { traderStats } from '../lib/stats.js';
import { getWallets, setWallets, getSiteConfig, setSiteConfig } from '../lib/settings.js';
import {
  mailDepositConfirmed, mailDepositDeclined, mailWithdrawalSent, mailWithdrawalDeclined,
  mailKycApproved, mailKycRejected, mailAdminMessage,
  getMailConfig, setMailConfig, sendTestMail,
} from '../lib/mail.js';
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
    { href: '/admin/wallets',     label: 'Wallets',     icon: svg('<rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M16 12h4M2 10h20"/>') },
  ]},
  { label: 'People', items: [
    { href: '/admin/users',   label: 'Users',   icon: svg('<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.9"/>') },
    { href: '/admin/kyc',     label: 'KYC review', icon: svg('<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>') },
    { href: '/admin/traders', label: 'Traders', icon: svg('<path d="M3 17l5-6 4 4 6-8"/><path d="M3 21h18"/>') },
  ]},
  { label: 'System', items: [
    { href: '/admin/mail', label: 'Mail outbox', icon: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>') },
    { href: '/admin/mail/compose', label: 'Send mail', icon: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>') },
    { href: '/admin/mail/settings', label: 'Mail settings', icon: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>') },
    { href: '/admin/site', label: 'Site settings', icon: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18 15 15 0 010-18"/>') },
  ]},
];

const shell = async (c, view, data, title) => {
  const u = c.get('user');
  const body = eta.render(view, { ...fmt, ...data, user: u, csrf: c.get('csrf') });
  // Longest-prefix match so /admin/mail/compose lights "Send mail", not "Mail outbox".
  const p = c.req.path;
  const activeHref = NAV.flatMap((g) => g.items).map((i) => i.href)
    .filter((h) => p === h || p.startsWith(h + '/'))
    .sort((a, b) => b.length - a.length)[0] || null;
  return render(c, 'layouts/admin', { body, title, nav: NAV, activeHref });
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

  const [u] = await db.select().from(users).where(eq(users.id, t.userId)).limit(1);
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

    // Deposit/withdrawal mail.
    if (u) (t.type === 'deposit' ? mailDepositConfirmed : mailWithdrawalSent)(u, t)
      .catch((e) => console.error('[mail] tx approve failed:', e.message));

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

    // Decline mail.
    if (u) (t.type === 'deposit' ? mailDepositDeclined : mailWithdrawalDeclined)(u, t, note)
      .catch((e) => console.error('[mail] tx reject failed:', e.message));
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

/* ---------------- plan edit ---------------- */
admin.post('/admin/plans/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const b = c.get('body');
  const [plan] = await db.select().from(plansT).where(eq(plansT.id, id)).limit(1);
  if (!plan) return c.notFound();

  const name = String(b.name || '').trim();
  if (!name) return c.redirect('/admin/plans?e=' + encodeURIComponent('Plan name is required.'));

  await db.update(plansT).set({
    name,
    roiPercent: String(Number(b.roiPercent) || plan.roiPercent),
    periodHours: Number(b.periodHours) || plan.periodHours,
    durationPeriods: Number(b.durationPeriods) || plan.durationPeriods,
    minAmount: String(Number(b.minAmount) || plan.minAmount),
    maxAmount: String(Number(b.maxAmount) || plan.maxAmount),
    sortOrder: Number(b.sortOrder ?? plan.sortOrder),
  }).where(eq(plansT.id, id));
  return c.redirect('/admin/plans?ok=edit');
});

/* ---------------- user edit ---------------- */
admin.get('/admin/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const [u] = await sql`
    select u.id, u.first_name, u.last_name, u.email, u.country, u.phone, u.role,
           u.status, u.kyc_status, u.referral_code, u.created_at,
           coalesce((select sum(amount) from ledger where user_id = u.id), 0)::text balance
    from users u where u.id = ${id}`;
  if (!u) return c.notFound();
  return shell(c, 'admin/user', { u, ok: c.req.query('ok'), error: c.req.query('e') }, 'Edit user');
});

admin.post('/admin/users/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const b = c.get('body');
  const me = c.get('user');
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!u) return c.notFound();

  const email = String(b.email || '').trim().toLowerCase();
  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const role = b.role === 'admin' ? 'admin' : 'user';
  const status = b.status === 'suspended' ? 'suspended' : 'active';

  if (!firstName || !lastName) return c.redirect(`/admin/users/${id}?e=` + encodeURIComponent('Name is required.'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return c.redirect(`/admin/users/${id}?e=` + encodeURIComponent('Enter a valid email.'));

  // Don't let an admin demote or suspend themselves.
  if (id === me.id && (role !== u.role || status !== u.status))
    return c.redirect(`/admin/users/${id}?e=` + encodeURIComponent("You can't change your own role or status."));

  // Email uniqueness check.
  if (email !== u.email) {
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (dupe) return c.redirect(`/admin/users/${id}?e=` + encodeURIComponent('That email is already in use.'));
  }

  await db.update(users).set({
    firstName, lastName, email,
    country: String(b.country || '').trim() || null,
    phone: String(b.phone || '').trim() || null,
    role, status,
  }).where(eq(users.id, id));
  return c.redirect(`/admin/users/${id}?ok=1`);
});

/* ---------------- wallet addresses ---------------- */
admin.get('/admin/wallets', async (c) =>
  shell(c, 'admin/wallets', { wallets: await getWallets(), ok: c.req.query('ok') }, 'Wallet addresses'));

admin.post('/admin/wallets', async (c) => {
  const b = c.get('body');
  await setWallets({
    usdt_trc20: String(b.usdt_trc20 || ''),
    btc: String(b.btc || ''),
    eth: String(b.eth || ''),
    bank: String(b.bank || ''),
  });
  return c.redirect('/admin/wallets?ok=1');
});

/* ---------------- KYC review ---------------- */
admin.get('/admin/kyc', async (c) => {
  const status = c.req.query('status') || 'pending';
  const rows = await sql`
    select k.*, u.first_name, u.last_name, u.email, u.country user_country
    from kyc_submissions k join users u on u.id = k.user_id
    ${status === 'all' ? sql`` : sql`where k.status = ${status}`}
    order by k.created_at desc limit 100`;
  return shell(c, 'admin/kyc', { rows, status }, 'KYC review');
});

admin.post('/admin/kyc/:id/:action', async (c) => {
  const id = Number(c.req.param('id'));
  const action = c.req.param('action');   // approve | reject
  const me = c.get('user');
  const note = String(c.get('body')?.note || '');

  const [k] = await db.select().from(kycSubmissions).where(eq(kycSubmissions.id, id)).limit(1);
  if (!k) return c.notFound();
  if (k.status !== 'pending') return c.redirect('/admin/kyc');

  const [u] = await db.select().from(users).where(eq(users.id, k.userId)).limit(1);

  if (action === 'approve') {
    await db.update(kycSubmissions).set({
      status: 'approved', adminNote: note, reviewedBy: me.id, reviewedAt: new Date(),
    }).where(eq(kycSubmissions.id, id));
    await db.update(users).set({ kycStatus: 'verified' }).where(eq(users.id, k.userId));
    await db.insert(notifications).values({
      userId: k.userId, kind: 'success', title: 'Identity verified',
      body: 'Your identity has been verified. Your account is fully activated.',
    });
    if (u) mailKycApproved(u).catch((e) => console.error('[mail] kyc approved failed:', e.message));
  } else {
    await db.update(kycSubmissions).set({
      status: 'rejected', adminNote: note, reviewedBy: me.id, reviewedAt: new Date(),
    }).where(eq(kycSubmissions.id, id));
    await db.update(users).set({ kycStatus: 'unverified' }).where(eq(users.id, k.userId));
    await db.insert(notifications).values({
      userId: k.userId, kind: 'warn', title: 'Identity review — action needed',
      body: note || 'Please resubmit your documents with clearer images.',
    });
    if (u) mailKycRejected(u, note).catch((e) => console.error('[mail] kyc rejected failed:', e.message));
  }
  return c.redirect('/admin/kyc');
});

/* ---------------- mail outbox ---------------- */
admin.get('/admin/mail', async (c) => {
  const rows = await sql`
    select m.*, u.first_name, u.last_name
    from mail_log m left join users u on u.id = m.user_id
    order by m.created_at desc limit 100`;
  return shell(c, 'admin/mail', { rows }, 'Mail outbox');
});

/* ---------------- mail settings (SMTP / Gmail) ---------------- */
admin.get('/admin/mail/settings', async (c) => {
  const cfg = await getMailConfig() || {
    host: 'smtp.gmail.com', port: 465, secure: true,
    user: 'marketedgesupport@gmail.com', pass: '',
    fromName: 'Marketedge Support', fromAddress: 'marketedgesupport@gmail.com',
  };
  const hasPass = !!(cfg.pass && cfg.pass.length);
  return shell(c, 'admin/mail-settings', {
    cfg, hasPass,
    ok: c.req.query('ok'),
    testStatus: c.req.query('test'),
    testMsg: c.req.query('msg') ? decodeURIComponent(c.req.query('msg')) : '',
  }, 'Mail settings');
});

admin.post('/admin/mail/settings', async (c) => {
  const b = c.get('body');
  const port = Number(b.port);
  const secure = b.secure === 'on' || b.secure === 'true' || port === 465;
  await setMailConfig({
    host: String(b.host || ''),
    port: port || 465,
    secure,
    user: String(b.user || ''),
    pass: String(b.pass || ''),
    fromName: String(b.fromName || ''),
    fromAddress: String(b.fromAddress || ''),
  });
  return c.redirect('/admin/mail/settings?ok=1');
});

admin.post('/admin/mail/test', async (c) => {
  const b = c.get('body');
  const to = String(b.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(to))
    return c.redirect('/admin/mail/settings?test=invalid&msg=' + encodeURIComponent('Enter a valid email address.'));
  const r = await sendTestMail(to);
  const msg = r.status === 'sent'
    ? `Test email sent to ${to}. Check the inbox (and spam folder).`
    : (r.error || 'Send failed.');
  return c.redirect('/admin/mail/settings?test=' + r.status + '&msg=' + encodeURIComponent(msg));
});

/* ---------------- compose & send mail ---------------- */
admin.get('/admin/mail/compose', async (c) => {
  const rows = await sql`
    select id, first_name, last_name, email from users
    where role = 'user' and status = 'active' order by email asc limit 1000`;
  return shell(c, 'admin/mail-compose', {
    rows,
    to: c.req.query('to') || '',
    subject: c.req.query('subject') || '',
    ok: c.req.query('ok'), n: c.req.query('n'), error: c.req.query('e'),
  }, 'Send mail');
});

admin.post('/admin/mail/compose', async (c) => {
  const b = c.get('body');
  const audience = b.audience === 'all' ? 'all' : 'one';
  const subject = String(b.subject || '').trim().slice(0, 180);
  const message = String(b.message || '').trim().slice(0, 8000);
  const fail = (m) => c.redirect('/admin/mail/compose?e=' + encodeURIComponent(m));

  if (!subject) return fail('Subject is required.');
  if (!message) return fail('Write a message first.');

  if (audience === 'one') {
    const email = String(b.to || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return fail('Enter a valid recipient email.');
    const [row] = await sql`select id, first_name, email from users where email = ${email} limit 1`;
    const u = row && { id: row.id, firstName: row.first_name, email: row.email };
    await mailAdminMessage(u || { email }, subject, message);
    // In-app copy too when the recipient is a registered user.
    if (u) await db.insert(notifications).values({ userId: u.id, kind: 'info', title: subject, body: message.slice(0, 500) });
    return c.redirect('/admin/mail/compose?ok=1&n=1');
  }

  // Broadcast: every active client. Sequential sends keep the SMTP
  // connection (and Gmail's rate limits) happy.
  const rows = await sql`select id, first_name, email from users where role = 'user' and status = 'active'`;
  for (const row of rows) {
    const u = { id: row.id, firstName: row.first_name, email: row.email };
    await mailAdminMessage(u, subject, message);
    await db.insert(notifications).values({ userId: u.id, kind: 'info', title: subject, body: message.slice(0, 500) });
  }
  return c.redirect('/admin/mail/compose?ok=1&n=' + rows.length);
});

/* ---------------- site settings (support email, live chat) ---------------- */
admin.get('/admin/site', async (c) =>
  shell(c, 'admin/site', { site: await getSiteConfig(), ok: c.req.query('ok') }, 'Site settings'));

admin.post('/admin/site', async (c) => {
  const b = c.get('body');
  await setSiteConfig({
    supportEmail: String(b.supportEmail || ''),
    smartsuppKey: String(b.smartsuppKey || ''),
  });
  return c.redirect('/admin/site?ok=1');
});
