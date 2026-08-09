import 'dotenv/config';
import crypto from 'node:crypto';
import { sql } from './client.js';
import { hash } from '../lib/auth.js';
import { pollPrices, runMarket } from '../workers/engine.js';

/* Idempotent: safe to run more than once. */

const PLANS = [
  { name: 'Starter',  slug: 'starter',  roi: 0.85, hours: 24, periods: 30, min: 100,    max: 2999,    badge: null,
    features: ['Principal returned at maturity', 'Withdraw returns as they post', 'Full charting access', '24/7 support'] },
  { name: 'Standard', slug: 'standard', roi: 1.10, hours: 24, periods: 45, min: 3000,   max: 24999,   badge: 'Popular',
    features: ['Principal returned at maturity', 'Withdraw returns as they post', 'Priority withdrawals', 'Dedicated account manager'] },
  { name: 'Growth',   slug: 'growth',   roi: 1.35, hours: 24, periods: 60, min: 25000,  max: 99999,   badge: null,
    features: ['Principal returned at maturity', 'Withdraw returns as they post', 'Reduced spreads', 'Quarterly strategy review'] },
  { name: 'Private',  slug: 'private',  roi: 1.60, hours: 24, periods: 90, min: 100000, max: 1000000, badge: 'Invite',
    features: ['Principal returned at maturity', 'Custom mandate available', 'Institutional execution', 'Direct desk line'] },
];

const TRADERS = [
  { name: 'Marcus Rodriguez', strategy: 'Stock Market Pro', risk: 6, min: 500,
    bio: 'Momentum on large-cap US equities. Holds through earnings only when the setup was there before the print.' },
  { name: 'Sarah Williams',   strategy: 'Forex Master',     risk: 4, min: 1000,
    bio: 'Majors and one or two crosses. Trades London and New York overlap, flat overnight.' },
  { name: 'David Kim',        strategy: 'Swing Trader',     risk: 7, min: 300,
    bio: 'Multi-day swings on crypto and index CFDs. Wide stops, small size, patient with entries.' },
  { name: 'Amara Okonkwo',    strategy: 'Fixed Income',     risk: 2, min: 2500,
    bio: 'Rates and carry. Low turnover, low drawdown, unexciting by design.' },
  { name: 'Tomasz Nowak',     strategy: 'Scalper',          risk: 9, min: 250,
    bio: 'High-frequency intraday on BTC and ETH. High turnover and real drawdowns — size accordingly.' },
];

const BOTS = [
  { slug: 'grid-btc',   name: 'Grid — BTC',        market: 'crypto',  cadence: 'grid',       risk: 5, min: 500,
    tagline: 'Places a ladder of buy and sell orders across a range and profits from oscillation.' },
  { slug: 'trend-major', name: 'Trend — FX majors', market: 'forex',   cadence: 'swing',      risk: 4, min: 1000,
    tagline: 'Follows established daily trends on the majors, sits out chop.' },
  { slug: 'meanrev-idx', name: 'Mean reversion — indices', market: 'indices', cadence: 'intraday', risk: 6, min: 750,
    tagline: 'Fades intraday extremes on index CFDs and exits at the session average.' },
];

async function main() {
  console.log('[seed] starting');

  /* --- plans --- */
  for (const [i, p] of PLANS.entries()) {
    await sql`
      insert into plans (name, slug, badge, roi_percent, period_hours, duration_periods,
                         min_amount, max_amount, features, sort_order, active)
      values (${p.name}, ${p.slug}, ${p.badge}, ${p.roi}, ${p.hours}, ${p.periods},
              ${p.min}, ${p.max}, ${JSON.stringify(p.features)}, ${i}, true)
      on conflict (slug) do nothing`;
  }
  console.log(`[seed] plans: ${PLANS.length}`);

  /* --- traders --- */
  for (const t of TRADERS) {
    const slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await sql`
      insert into traders (slug, display_name, strategy, bio, min_copy, risk_score, markets, active)
      values (${slug}, ${t.name}, ${t.strategy}, ${t.bio}, ${t.min}, ${t.risk},
              ${JSON.stringify(['crypto', 'forex'])}, true)
      on conflict (slug) do nothing`;
  }
  console.log(`[seed] traders: ${TRADERS.length}`);

  /* --- bots --- */
  for (const b of BOTS) {
    await sql`
      insert into bots (slug, name, tagline, market, cadence, risk_score, min_allocation, active)
      values (${b.slug}, ${b.name}, ${b.tagline}, ${b.market}, ${b.cadence}, ${b.risk}, ${b.min}, true)
      on conflict (slug) do nothing`;
  }

  /* --- admin --- */
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@rydoninv.com').toLowerCase();
  const [existing] = await sql`select id from users where email = ${adminEmail}`;
  if (!existing) {
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
    await sql`
      insert into users (email, password_hash, first_name, last_name, role, referral_code)
      values (${adminEmail}, ${await hash(pw)}, 'Platform', 'Admin', 'admin',
              ${crypto.randomBytes(4).toString('hex').toUpperCase()})`;
    console.log(`[seed] admin created: ${adminEmail} / ${pw}  — change this password`);
  } else {
    console.log('[seed] admin already exists, left alone');
  }

  /* --- demo client with a funded, active account --- */
  const demoEmail = 'demo@rydoninv.com';
  let [demo] = await sql`select id from users where email = ${demoEmail}`;
  if (!demo) {
    [demo] = await sql`
      insert into users (email, password_hash, first_name, last_name, country, referral_code)
      values (${demoEmail}, ${await hash('DemoAccount!2026')}, 'Edwin', 'Steen', 'Nigeria',
              ${crypto.randomBytes(4).toString('hex').toUpperCase()})
      returning id`;

    await sql`insert into transactions (user_id, type, method, amount, status, reviewed_at)
      values (${demo.id}, 'deposit', 'usdt_trc20', 20000, 'approved', now())`;
    await sql`insert into ledger (user_id, account, kind, amount, memo)
      values (${demo.id}, 'main', 'deposit', 20000, 'Opening deposit confirmed')`;

    // Follow two traders so the copy dashboard has something in it.
    const follows = await sql`select id, min_copy::text from traders order by id limit 2`;
    for (const t of follows) {
      const alloc = Math.max(Number(t.min_copy), 2500);
      const [f] = await sql`
        insert into copy_follows (user_id, trader_id, allocation) values (${demo.id}, ${t.id}, ${alloc})
        returning id`;
      await sql`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo) values
        (${demo.id}, 'main',   'copy_open', ${-alloc}, 'follow', ${f.id}, 'Allocated to strategy'),
        (${demo.id}, 'locked', 'copy_open', ${alloc},  'follow', ${f.id}, 'Strategy allocation')`;
    }

    // Open one investment plan.
    const [plan] = await sql`select * from plans where slug = 'standard'`;
    if (plan) {
      const amount = 5000;
      const matures = new Date(Date.now() + Number(plan.duration_periods) * Number(plan.period_hours) * 3600e3);
      const [inv] = await sql`
        insert into investments (user_id, plan_id, principal, matures_at)
        values (${demo.id}, ${plan.id}, ${amount}, ${matures.toISOString()}) returning id`;
      await sql`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo) values
        (${demo.id}, 'main',   'investment_open', ${-amount}, 'investment', ${inv.id}, 'Opened Standard'),
        (${demo.id}, 'locked', 'investment_open', ${amount},  'investment', ${inv.id}, 'Standard principal')`;
    }

    await sql`insert into notifications (user_id, kind, title, body)
      values (${demo.id}, 'info', 'Welcome to the platform',
              'Your account is funded and two strategies are running. Watch the statement fill in.')`;

    console.log(`[seed] demo client created: ${demoEmail} / DemoAccount!2026`);
  } else {
    console.log('[seed] demo client already exists, left alone');
  }

  /* --- prime the market so the demo isn't empty on first load --- */
  console.log('[seed] fetching live prices…');
  const n = await pollPrices();
  console.log(`[seed] priced ${n} instruments`);

  console.log('[seed] generating trade history…');
  for (let i = 0; i < 40; i++) {
    await runMarket();
    // Backdate so the loop's "older than 20 minutes" close condition triggers.
    await sql`update trader_trades set opened_at = opened_at - interval '25 minutes' where status = 'open'`;
  }
  const [{ count }] = await sql`select count(*)::int count from trader_trades where status = 'closed'`;
  console.log(`[seed] ${count} closed trades on record`);

  console.log('[seed] done');
  await sql.end();
}

main().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
