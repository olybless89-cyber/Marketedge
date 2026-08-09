import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import {
  transactions, ledger, plans as plansT, investments, traders as tradersT,
  copyFollows, copyPositions, notifications, bots as botsT,
} from '../db/schema.js';
import { requireUser } from '../lib/auth.js';
import { render, eta } from '../lib/view.js';
import { portfolio, balance, traderStats, myCopyPositions, unreadCount } from '../lib/stats.js';
import * as fmt from '../lib/money.js';

export const dash = new Hono();
dash.use('*', requireUser);

const svg = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">${d}</svg>`;
const NAV = [
  { label: 'Overview', items: [
    { href: '/dashboard',            label: 'Dashboard',        icon: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>') },
    { href: '/dashboard/statement',  label: 'Account statement', icon: svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>') },
  ]},
  { label: 'Trading', items: [
    { href: '/dashboard/markets', label: 'Live markets', icon: svg('<path d="M3 17l5-6 4 4 6-8"/><path d="M3 21h18"/>'), tag: 'Live' },
    { href: '/dashboard/copy',    label: 'Copy trading', icon: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 012-2h11"/>'), tag: 'Pro' },
    { href: '/dashboard/bots',    label: 'Strategies',   icon: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>'), tag: 'Auto' },
  ]},
  { label: 'Portfolio', items: [
    { href: '/dashboard/invest',      label: 'Investment plans', icon: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>') },
    { href: '/dashboard/deposit',     label: 'Deposit',          icon: svg('<path d="M12 3v13M6 11l6 6 6-6M4 21h16"/>') },
    { href: '/dashboard/withdraw',    label: 'Withdraw',         icon: svg('<path d="M12 21V8M6 13l6-6 6 6M4 3h16"/>') },
  ]},
];

const shell = async (c, view, data, title) => {
  const u = c.get('user');
  const [bal, unread] = await Promise.all([balance(u.id), unreadCount(u.id)]);
  const body = eta.render(view, { ...fmt, ...data, user: u, csrf: c.get('csrf') });
  return render(c, 'layouts/app', { body, title, nav: NAV, bal, unread });
};

/* ---------------- overview ---------------- */
dash.get('/dashboard', async (c) => {
  const u = c.get('user');
  const [pf, copies, recent, invs] = await Promise.all([
    portfolio(u.id),
    myCopyPositions(u.id),
    db.select().from(ledger).where(eq(ledger.userId, u.id)).orderBy(desc(ledger.createdAt)).limit(8),
    sql`select i.*, p.name plan_name, p.roi_percent::text roi
        from investments i join plans p on p.id = i.plan_id
        where i.user_id = ${u.id} and i.status = 'active'
        order by i.started_at desc limit 5`,
  ]);
  return shell(c, 'dashboard/overview', { pf, copies, recent, invs }, 'Dashboard');
});

dash.get('/dashboard/partials/balance', async (c) => {
  const bal = await balance(c.get('user').id);
  return c.html(`<span>Available balance</span><b class="num" data-watch>${fmt.usd(bal.available)}</b>`);
});

/* ---------------- statement ---------------- */
dash.get('/dashboard/statement', async (c) => {
  const u = c.get('user');
  const rows = await db.select().from(ledger)
    .where(eq(ledger.userId, u.id)).orderBy(desc(ledger.createdAt)).limit(200);
  const pf = await portfolio(u.id);
  return shell(c, 'dashboard/statement', { rows, pf }, 'Account statement');
});

/* ---------------- deposit ---------------- */
dash.get('/dashboard/deposit', async (c) => {
  const u = c.get('user');
  const rows = await db.select().from(transactions)
    .where(and(eq(transactions.userId, u.id), eq(transactions.type, 'deposit')))
    .orderBy(desc(transactions.createdAt)).limit(25);
  return shell(c, 'dashboard/deposit', { rows, sent: c.req.query('sent') }, 'Deposit');
});

dash.post('/dashboard/deposit', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const amount = Number(b.amount);
  if (!(amount > 0)) return c.text('Enter an amount greater than zero.', 400);

  await db.insert(transactions).values({
    userId: u.id, type: 'deposit', method: String(b.method || 'usdt_trc20'),
    amount: String(amount), status: 'pending',
  });
  // No ledger row yet — funds only exist once an admin approves.
  await db.insert(notifications).values({
    userId: u.id, kind: 'info', title: 'Deposit submitted',
    body: `We received your ${fmt.usd(amount)} deposit request. It posts to your balance once confirmed.`,
  });
  return c.redirect('/dashboard/deposit?sent=1');
});

/* ---------------- withdraw ---------------- */
dash.get('/dashboard/withdraw', async (c) => {
  const u = c.get('user');
  const [rows, bal] = await Promise.all([
    db.select().from(transactions)
      .where(and(eq(transactions.userId, u.id), eq(transactions.type, 'withdrawal')))
      .orderBy(desc(transactions.createdAt)).limit(25),
    balance(u.id),
  ]);
  return shell(c, 'dashboard/withdraw', { rows, bal, sent: c.req.query('sent'), error: c.req.query('e') }, 'Withdraw');
});

dash.post('/dashboard/withdraw', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const amount = Number(b.amount);
  const bal = await balance(u.id);

  if (!(amount > 0)) return c.redirect('/dashboard/withdraw?e=' + encodeURIComponent('Enter an amount greater than zero.'));
  if (amount > bal.available)
    return c.redirect('/dashboard/withdraw?e=' + encodeURIComponent(`You can withdraw up to ${fmt.usd(bal.available)} right now.`));

  await db.insert(transactions).values({
    userId: u.id, type: 'withdrawal', method: String(b.method || 'usdt_trc20'),
    amount: String(amount), address: String(b.address || ''), status: 'pending',
  });
  // Hold the funds immediately so they can't be spent twice while pending.
  await db.insert(ledger).values({
    userId: u.id, account: 'main', kind: 'withdrawal_hold', amount: String(-amount),
    refType: 'withdrawal', memo: 'Held pending withdrawal review',
  });
  return c.redirect('/dashboard/withdraw?sent=1');
});

/* ---------------- investment plans ---------------- */
dash.get('/dashboard/invest', async (c) => {
  const u = c.get('user');
  const [plans, mine, bal] = await Promise.all([
    db.select().from(plansT).where(eq(plansT.active, true)).orderBy(plansT.sortOrder),
    sql`select i.*, p.name plan_name, p.roi_percent::text roi, p.period_hours, p.duration_periods
        from investments i join plans p on p.id = i.plan_id
        where i.user_id = ${u.id} order by i.started_at desc limit 20`,
    balance(u.id),
  ]);
  return shell(c, 'dashboard/invest', {
    plans, mine, bal, preset: c.req.query('plan'), error: c.req.query('e'), ok: c.req.query('ok'),
  }, 'Investment plans');
});

dash.post('/dashboard/invest', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const amount = Number(b.amount);
  const [plan] = await db.select().from(plansT).where(eq(plansT.id, Number(b.planId))).limit(1);
  const fail = (m) => c.redirect('/dashboard/invest?e=' + encodeURIComponent(m));

  if (!plan || !plan.active) return fail('That plan is no longer available.');
  const bal = await balance(u.id);
  if (!(amount > 0)) return fail('Enter an amount greater than zero.');
  if (amount < Number(plan.minAmount)) return fail(`${plan.name} starts at ${fmt.usd(plan.minAmount, 0)}.`);
  if (amount > Number(plan.maxAmount)) return fail(`${plan.name} accepts up to ${fmt.usd(plan.maxAmount, 0)}.`);
  if (amount > bal.available) return fail(`You have ${fmt.usd(bal.available)} available. Fund your account first.`);

  const maturesAt = new Date(Date.now() + plan.durationPeriods * plan.periodHours * 3600e3);
  const [inv] = await db.insert(investments).values({
    userId: u.id, planId: plan.id, principal: String(amount), maturesAt,
  }).returning();

  await db.insert(ledger).values([
    { userId: u.id, account: 'main',   kind: 'investment_open', amount: String(-amount), refType: 'investment', refId: inv.id, memo: `Opened ${plan.name}` },
    { userId: u.id, account: 'locked', kind: 'investment_open', amount: String(amount),  refType: 'investment', refId: inv.id, memo: `${plan.name} principal` },
  ]);
  return c.redirect('/dashboard/invest?ok=1');
});

/* ---------------- copy trading ---------------- */
dash.get('/dashboard/copy', async (c) => {
  const u = c.get('user');
  const [mine, all, bal] = await Promise.all([myCopyPositions(u.id), traderStats(), balance(u.id)]);
  const followed = new Set(mine.map((m) => m.traderId));
  return shell(c, 'dashboard/copy', {
    mine, all: all.filter((t) => !followed.has(t.id)), bal,
    error: c.req.query('e'), ok: c.req.query('ok'),
  }, 'Copy trading');
});

dash.post('/dashboard/copy/follow', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const alloc = Number(b.allocation);
  const [t] = await db.select().from(tradersT).where(eq(tradersT.id, Number(b.traderId))).limit(1);
  const fail = (m) => c.redirect('/dashboard/copy?e=' + encodeURIComponent(m));

  if (!t || !t.active) return fail('That strategy is not accepting new followers.');
  const bal = await balance(u.id);
  if (alloc < Number(t.minCopy)) return fail(`${t.displayName} requires at least ${fmt.usd(t.minCopy, 0)}.`);
  if (alloc > bal.available) return fail(`You have ${fmt.usd(bal.available)} available to allocate.`);

  const [f] = await db.insert(copyFollows).values({
    userId: u.id, traderId: t.id, allocation: String(alloc),
  }).returning();

  await db.insert(ledger).values([
    { userId: u.id, account: 'main',   kind: 'copy_open', amount: String(-alloc), refType: 'follow', refId: f.id, memo: `Allocated to ${t.displayName}` },
    { userId: u.id, account: 'locked', kind: 'copy_open', amount: String(alloc),  refType: 'follow', refId: f.id, memo: `${t.displayName} allocation` },
  ]);
  return c.redirect('/dashboard/copy?ok=1');
});

dash.post('/dashboard/copy/stop', async (c) => {
  const u = c.get('user');
  const id = Number(c.get('body').followId);
  const [f] = await db.select().from(copyFollows)
    .where(and(eq(copyFollows.id, id), eq(copyFollows.userId, u.id))).limit(1);
  if (!f || f.status !== 'active') return c.redirect('/dashboard/copy');

  // Close open slices at their entry price — no phantom P&L on stop.
  const [{ pnl }] = await sql`
    select coalesce(sum(pnl), 0)::text pnl from copy_positions
    where follow_id = ${id} and status = 'closed'`;
  await sql`update copy_positions set status = 'closed', closed_at = now(), pnl = coalesce(pnl, 0)
            where follow_id = ${id} and status = 'open'`;
  await db.update(copyFollows).set({ status: 'stopped', stoppedAt: new Date() }).where(eq(copyFollows.id, id));

  const alloc = Number(f.allocation);
  await db.insert(ledger).values([
    { userId: u.id, account: 'locked', kind: 'copy_close', amount: String(-alloc), refType: 'follow', refId: id, memo: 'Allocation released' },
    { userId: u.id, account: 'main',   kind: 'copy_close', amount: String(alloc + Number(pnl)), refType: 'follow', refId: id, memo: `Copy closed, P&L ${fmt.signedUsd(pnl)}` },
  ]);
  return c.redirect('/dashboard/copy?ok=stopped');
});

/* ---------------- markets, bots, notifications, settings ---------------- */
dash.get('/dashboard/markets', async (c) =>
  shell(c, 'dashboard/markets', {}, 'Live markets'));

dash.get('/dashboard/bots', async (c) => {
  const u = c.get('user');
  const [list, bal] = await Promise.all([
    db.select().from(botsT).where(eq(botsT.active, true)),
    balance(u.id),
  ]);
  return shell(c, 'dashboard/bots', { list, bal }, 'Strategies');
});

dash.get('/dashboard/notifications', async (c) => {
  const u = c.get('user');
  const rows = await sql`select * from notifications
    where user_id = ${u.id} or user_id is null order by created_at desc limit 50`;
  await sql`update notifications set read_at = now()
    where (user_id = ${u.id} or user_id is null) and read_at is null`;
  return shell(c, 'dashboard/notifications', { rows }, 'Notifications');
});

dash.get('/dashboard/settings', async (c) =>
  shell(c, 'dashboard/settings', { ok: c.req.query('ok'), error: c.req.query('e') }, 'Settings'));
