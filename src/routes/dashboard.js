import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db, sql } from '../db/client.js';
import {
  transactions, ledger, plans as plansT, investments, traders as tradersT,
  copyFollows, copyPositions, notifications, bots as botsT,
  users, kycSubmissions, spotPositions,
} from '../db/schema.js';
import { requireUser, hash, verify } from '../lib/auth.js';
import { render, eta } from '../lib/view.js';
import { portfolio, balance, traderStats, myCopyPositions, unreadCount, livePrices } from '../lib/stats.js';
import { mailPlanActivated } from '../lib/mail.js';
import { getWallets } from '../lib/settings.js';
import * as fmt from '../lib/money.js';

export const dash = new Hono();
dash.use('*', requireUser);

const svg = (d) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">${d}</svg>`;
const NAV = [
  { label: 'Overview', items: [
    { href: '/dashboard',            label: 'Dashboard',        icon: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>') },
    { href: '/dashboard/portfolio',  label: 'Portfolio',         icon: svg('<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>'), tag: 'New' },
    { href: '/dashboard/statement',  label: 'Account statement', icon: svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>') },
  ]},
  { label: 'Trading', items: [
    { href: '/dashboard/trade',   label: 'Trade',       icon: svg('<path d="M7 17l4-4 3 3 5-6"/><path d="M3 21h18"/><rect x="3" y="3" width="18" height="18" rx="2"/>'), tag: 'New' },
    { href: '/dashboard/markets', label: 'Live markets', icon: svg('<path d="M3 17l5-6 4 4 6-8"/><path d="M3 21h18"/>'), tag: 'Live' },
    { href: '/dashboard/copy',    label: 'Copy trading', icon: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 012-2h11"/>'), tag: 'Pro' },
    { href: '/dashboard/bots',    label: 'Strategies',   icon: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>'), tag: 'Auto' },
  ]},
  { label: 'Portfolio', items: [
    { href: '/dashboard/invest',      label: 'Investment plans', icon: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>') },
    { href: '/dashboard/deposit',     label: 'Deposit',          icon: svg('<path d="M12 3v13M6 11l6 6 6-6M4 21h16"/>') },
    { href: '/dashboard/withdraw',    label: 'Withdraw',         icon: svg('<path d="M12 21V8M6 13l6-6 6 6M4 3h16"/>') },
    { href: '/dashboard/kyc',         label: 'Verification',     icon: svg('<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>') },
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
  const [rows, wallets] = await Promise.all([
    db.select().from(transactions)
      .where(and(eq(transactions.userId, u.id), eq(transactions.type, 'deposit')))
      .orderBy(desc(transactions.createdAt)).limit(25),
    getWallets(),
  ]);
  return shell(c, 'dashboard/deposit', { rows, wallets, sent: c.req.query('sent') }, 'Deposit');
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

  // Plan activation mail.
  mailPlanActivated(u, plan.name, amount, maturesAt)
    .catch((e) => console.error('[mail] plan activated failed:', e.message));

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

/* ---------------- KYC verification ---------------- */
dash.get('/dashboard/kyc', async (c) => {
  const u = c.get('user');
  const rows = await db.select().from(kycSubmissions)
    .where(eq(kycSubmissions.userId, u.id))
    .orderBy(desc(kycSubmissions.createdAt)).limit(10);
  return shell(c, 'dashboard/kyc', {
    rows, ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Identity verification');
});

dash.post('/dashboard/kyc', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const documentType = String(b.documentType || '').trim();
  const back = (msg) => c.redirect('/dashboard/kyc?e=' + encodeURIComponent(msg));

  if (!['passport', 'national_id', 'drivers_license'].includes(documentType)) return back('Choose a document type.');
  if (u.kycStatus === 'verified') return back('Your identity is already verified.');

  // Block a second submission while one is pending.
  const [pending] = await db.select().from(kycSubmissions)
    .where(and(eq(kycSubmissions.userId, u.id), eq(kycSubmissions.status, 'pending'))).limit(1);
  if (pending) return back('A submission is already under review. We\'ll notify you when it\'s done.');

  await db.insert(kycSubmissions).values({
    userId: u.id,
    documentType,
    documentNumber: String(b.documentNumber || '').trim() || null,
    country: String(b.country || u.country || '').trim() || null,
    frontUrl: String(b.frontUrl || '').trim() || null,
    backUrl: String(b.backUrl || '').trim() || null,
    selfieUrl: String(b.selfieUrl || '').trim() || null,
  });
  await db.update(users).set({ kycStatus: 'pending' }).where(eq(users.id, u.id));
  await db.insert(notifications).values({
    userId: u.id, kind: 'info', title: 'Verification submitted',
    body: 'We received your documents. Review usually takes under 24 hours.',
  });
  return c.redirect('/dashboard/kyc?ok=1');
});

/* ---------------- spot trading ---------------- */
/* Open positions joined to the live prices table for mark-to-market. */
async function mySpotPositions(userId) {
  return sql`
    select s.id, s.symbol, s.qty::text, s.entry_price::text, s.cost::text,
           s.status, s.pnl::text, s.exit_price::text, s.opened_at, s.closed_at,
           coalesce(p.price, s.entry_price)::text mark,
           coalesce(p.change_24h, 0)::text chg
    from spot_positions s
    left join prices p on p.symbol = s.symbol
    where s.user_id = ${userId}
    order by s.opened_at desc limit 50`;
}

dash.get('/dashboard/trade', async (c) => {
  const u = c.get('user');
  const [prices, positions, bal] = await Promise.all([
    livePrices(24), mySpotPositions(u.id), balance(u.id),
  ]);
  return shell(c, 'dashboard/trade', {
    prices, positions, bal,
    ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Trade');
});

dash.post('/dashboard/trade', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const symbol = String(b.symbol || '').toUpperCase();
  const amount = Number(b.amount);            // USD to spend
  const action = String(b.action || 'buy');
  const back = (m) => c.redirect('/dashboard/trade?e=' + encodeURIComponent(m));

  if (action === 'sell') return sellSpot(c, u, b, back);

  if (!(amount > 0)) return back('Enter an amount greater than zero.');
  const [p] = await sql`select price::text from prices where symbol = ${symbol}`;
  if (!p) return back('That market is not available right now.');
  const price = Number(p.price);
  if (!(price > 0)) return back('No live price for that symbol.');

  const bal = await balance(u.id);
  if (amount > bal.available) return back(`You have ${fmt.usd(bal.available)} available to trade.`);

  const qty = amount / price;
  const [pos] = await db.insert(spotPositions).values({
    userId: u.id, symbol, qty: String(qty),
    entryPrice: String(price), cost: String(amount),
  }).returning();

  await db.insert(ledger).values({
    userId: u.id, account: 'main', kind: 'trade_buy', amount: String(-amount),
    refType: 'spot', refId: pos.id, memo: `Bought ${fmt.num(qty, 8)} ${symbol.replace(/USDT$/, '')} @ ${fmt.usd(price)}`,
  });
  await db.insert(notifications).values({
    userId: u.id, kind: 'info', title: 'Position opened',
    body: `Bought ${fmt.num(qty, 8)} ${symbol.replace(/USDT$/, '')} for ${fmt.usd(amount)} at ${fmt.usd(price)}.`,
  });
  return c.redirect('/dashboard/trade?ok=1');
});

async function sellSpot(c, u, b, back) {
  const id = Number(b.positionId);
  const [pos] = await db.select().from(spotPositions)
    .where(and(eq(spotPositions.id, id), eq(spotPositions.userId, u.id))).limit(1);
  if (!pos || pos.status !== 'open') return back('That position is not open.');

  const [p] = await sql`select price::text from prices where symbol = ${pos.symbol}`;
  if (!p) return back('No live price to settle that position.');
  const exit = Number(p.price);
  const qty = Number(pos.qty);
  const proceeds = qty * exit;
  const pnl = proceeds - Number(pos.cost);

  await db.update(spotPositions).set({
    status: 'closed', exitPrice: String(exit), pnl: String(pnl), closedAt: new Date(),
  }).where(eq(spotPositions.id, id));

  await db.insert(ledger).values([
    { userId: u.id, account: 'main',   kind: 'trade_sell', amount: String(proceeds), refType: 'spot', refId: id, memo: `Closed ${pos.symbol} @ ${fmt.usd(exit)}` },
    { userId: u.id, account: 'profit', kind: 'trade_sell', amount: String(pnl),      refType: 'spot', refId: id, memo: pnl >= 0 ? 'Realised gain' : 'Realised loss' },
  ]);
  await db.insert(notifications).values({
    userId: u.id, kind: pnl >= 0 ? 'success' : 'warn', title: 'Position closed',
    body: `Closed ${pos.symbol.replace(/USDT$/, '')} at ${fmt.usd(exit)}. ${pnl >= 0 ? 'Profit' : 'Loss'}: ${fmt.signedUsd(pnl)}.`,
  });
  return c.redirect('/dashboard/trade?ok=sold');
}

/* ---------------- portfolio ---------------- */
dash.get('/dashboard/portfolio', async (c) => {
  const u = c.get('user');
  const [pf, copies, spots, invs] = await Promise.all([
    portfolio(u.id), myCopyPositions(u.id), mySpotPositions(u.id),
    sql`select i.*, p.name plan_name, p.roi_percent::text roi, p.period_hours, p.duration_periods
        from investments i join plans p on p.id = i.plan_id
        where i.user_id = ${u.id} order by i.started_at desc limit 20`,
  ]);
  const spotRows = spots.map((s) => {
    const mark = Number(s.mark), entry = Number(s.entry_price), qty = Number(s.qty);
    return { ...s, mark, value: mark * qty, unrealised: (mark - entry) * qty };
  });
  const spotValue = spotRows.reduce((a, s) => a + (s.status === 'open' ? s.value : 0), 0);
  return shell(c, 'dashboard/portfolio', {
    pf, copies, spots: spotRows, invs, spotValue,
    ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Portfolio');
});

/* ---------------- account hub ---------------- */
dash.get('/dashboard/account', async (c) => {
  const u = c.get('user');
  const [kyc, bal] = await Promise.all([
    db.select().from(kycSubmissions).where(eq(kycSubmissions.userId, u.id))
      .orderBy(desc(kycSubmissions.createdAt)).limit(1),
    balance(u.id),
  ]);
  return shell(c, 'dashboard/account', {
    latestKyc: kyc[0] || null, bal,
    ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Account');
});

/* ---------------- personal account edit ---------------- */
dash.get('/dashboard/account/profile', async (c) => {
  const u = c.get('user');
  const [me] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
  return shell(c, 'dashboard/account/profile', {
    me, ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Edit profile');
});

dash.post('/dashboard/account/profile', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const firstName = String(b.firstName || '').trim().slice(0, 80);
  const lastName = String(b.lastName || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 255);
  const country = String(b.country || '').trim().slice(0, 80) || null;
  const phone = String(b.phone || '').trim().slice(0, 40) || null;
  const back = (m) => c.redirect('/dashboard/account/profile?e=' + encodeURIComponent(m));

  if (!firstName || !lastName) return back('First and last name are required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('That email address does not look right.');

  const [dup] = await db.select().from(users)
    .where(and(eq(users.email, email))).limit(1);
  if (dup && dup.id !== u.id) return back('That email is already in use.');

  await db.update(users).set({ firstName, lastName, email, country, phone })
    .where(eq(users.id, u.id));
  // Keep the session's user object fresh for the rest of the request.
  c.set('user', { ...u, firstName, lastName, email, country, phone });
  return c.redirect('/dashboard/account/profile?ok=1');
});

/* ---------------- password change ---------------- */
dash.get('/dashboard/account/password', async (c) =>
  shell(c, 'dashboard/account/password', {
    ok: c.req.query('ok'), error: c.req.query('e'),
  }, 'Change password'));

dash.post('/dashboard/account/password', async (c) => {
  const u = c.get('user');
  const b = c.get('body');
  const current = String(b.current || '');
  const next = String(b.next || '');
  const back = (m) => c.redirect('/dashboard/account/password?e=' + encodeURIComponent(m));

  if (next.length < 8) return back('New password must be at least 8 characters.');
  if (next === current) return back('Choose a password different from your current one.');

  const [me] = await db.select().from(users).where(eq(users.id, u.id)).limit(1);
  if (!await verify(me.passwordHash, current)) return back('Your current password is incorrect.');

  await db.update(users).set({ passwordHash: await hash(next) }).where(eq(users.id, u.id));
  await db.insert(notifications).values({
    userId: u.id, kind: 'info', title: 'Password changed',
    body: 'Your account password was updated just now. If that was not you, contact support immediately.',
  });
  return c.redirect('/dashboard/account/password?ok=1');
});
