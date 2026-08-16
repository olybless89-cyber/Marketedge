import { sql } from '../db/client.js';
import { mailPlanClosed } from '../lib/mail.js';

/* =================================================================
   Three loops, all writing rows. Nothing here touches the UI —
   the UI just aggregates whatever these have written.

   1. prices   — pull live marks from Binance into the prices table
   2. market   — traders open and close positions against those marks,
                 and follower slices are mirrored and marked to market
   3. accrual  — investment plans pay their periodic return
   ================================================================= */

const SYMBOLS = (process.env.PRICE_SYMBOLS ||
  'BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT,ADAUSDT,DOGEUSDT,TRXUSDT,LTCUSDT').split(',').map((s) => s.trim());

/* ---------- 1. prices ---------- */
export async function pollPrices() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const all = await res.json();
    const want = new Set(SYMBOLS);
    const rows = all.filter((t) => want.has(t.symbol));
    if (!rows.length) throw new Error('no matching symbols');

    for (const t of rows) {
      await sql`
        insert into prices (symbol, price, change_24h, source, updated_at)
        values (${t.symbol}, ${t.lastPrice}, ${t.priceChangePercent}, 'binance', now())
        on conflict (symbol) do update
          set price = excluded.price, change_24h = excluded.change_24h, updated_at = now()`;
    }
    return rows.length;
  } catch (e) {
    console.warn('[prices] binance failed, trying coingecko:', e.message);
    return pollCoinGecko();
  }
}

const CG = { BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', XRPUSDT: 'ripple', SOLUSDT: 'solana',
             ADAUSDT: 'cardano', DOGEUSDT: 'dogecoin', TRXUSDT: 'tron', LTCUSDT: 'litecoin' };

async function pollCoinGecko() {
  try {
    const ids = SYMBOLS.map((s) => CG[s]).filter(Boolean).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const data = await res.json();
    let n = 0;
    for (const [sym, id] of Object.entries(CG)) {
      const d = data[id];
      if (!d) continue;
      await sql`
        insert into prices (symbol, price, change_24h, source, updated_at)
        values (${sym}, ${d.usd}, ${d.usd_24h_change ?? 0}, 'coingecko', now())
        on conflict (symbol) do update
          set price = excluded.price, change_24h = excluded.change_24h, updated_at = now()`;
      n++;
    }
    return n;
  } catch (e) {
    console.error('[prices] all sources failed:', e.message);
    return 0;
  }
}

/* ---------- 2. market ---------- */
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** Mark every open position to the current price. Runs each tick. */
async function markToMarket() {
  await sql`
    update trader_trades t
    set pnl = case when t.side = 'buy'
                   then (p.price - t.entry_price) / t.entry_price * t.size_usd * t.leverage
                   else (t.entry_price - p.price) / t.entry_price * t.size_usd * t.leverage end
    from prices p
    where p.symbol = t.symbol and t.status = 'open'`;

  await sql`
    update copy_positions c
    set pnl = case when c.side = 'buy'
                   then (p.price - c.entry_price) / c.entry_price * c.size_usd
                   else (c.entry_price - p.price) / c.entry_price * c.size_usd end
    from prices p
    where p.symbol = c.symbol and c.status = 'open'`;
}

/** Open a position for a trader, and mirror it to everyone copying them. */
async function openTrade(traderId, riskScore) {
  const [px] = await sql`select symbol, price::text from prices order by random() limit 1`;
  if (!px) return;

  const side = Math.random() > 0.5 ? 'buy' : 'sell';
  const size = Math.round((400 + Math.random() * 2600) * (0.5 + riskScore / 10));
  const leverage = riskScore > 7 ? 5 : riskScore > 4 ? 3 : 1;

  const [t] = await sql`
    insert into trader_trades (trader_id, symbol, side, entry_price, size_usd, leverage, status)
    values (${traderId}, ${px.symbol}, ${side}, ${px.price}, ${size}, ${leverage}, 'open')
    returning id`;

  // Mirror proportionally: a follower's slice scales to their allocation,
  // capped so one trade can never consume the whole allocation.
  await sql`
    insert into copy_positions (follow_id, user_id, trader_trade_id, symbol, side, entry_price, size_usd, status)
    select f.id, f.user_id, ${t.id}, ${px.symbol}, ${side}, ${px.price},
           least(f.allocation * 0.2, ${size}), 'open'
    from copy_follows f
    where f.trader_id = ${traderId} and f.status = 'active'`;
}

/** Close a position and settle the mirrored slices with it. */
async function closeTrade(tradeId) {
  const [t] = await sql`
    select tt.*, p.price::text mark from trader_trades tt
    join prices p on p.symbol = tt.symbol where tt.id = ${tradeId}`;
  if (!t) return;

  await sql`
    update trader_trades set status = 'closed', closed_at = now(), exit_price = ${t.mark},
      pnl = case when side = 'buy'
                 then (${t.mark}::numeric - entry_price) / entry_price * size_usd * leverage
                 else (entry_price - ${t.mark}::numeric) / entry_price * size_usd * leverage end
    where id = ${tradeId}`;

  await sql`
    update copy_positions set status = 'closed', closed_at = now(), exit_price = ${t.mark},
      pnl = case when side = 'buy'
                 then (${t.mark}::numeric - entry_price) / entry_price * size_usd
                 else (entry_price - ${t.mark}::numeric) / entry_price * size_usd end
    where trader_trade_id = ${tradeId} and status = 'open'`;
}

export async function runMarket() {
  await markToMarket();

  const traders = await sql`
    select t.id, t.risk_score,
           (select count(*) from trader_trades where trader_id = t.id and status = 'open') open_count
    from traders t where t.active = true`;

  for (const t of traders) {
    // Higher risk score → trades more often and holds more at once.
    const maxOpen = Math.ceil(t.risk_score / 2);
    const openChance = 0.04 + t.risk_score * 0.012;

    if (t.open_count < maxOpen && Math.random() < openChance) {
      await openTrade(t.id, t.risk_score);
    }

    // Close anything that has run long enough or hit a rough exit band.
    const stale = await sql`
      select id, pnl::text, size_usd::text from trader_trades
      where trader_id = ${t.id} and status = 'open'
        and opened_at < now() - interval '20 minutes'`;

    for (const s of stale) {
      const ret = Number(s.pnl || 0) / Number(s.size_usd);
      const takeProfit = ret > 0.012;
      const stopLoss = ret < -0.008;
      const timeUp = Math.random() < 0.25;
      if (takeProfit || stopLoss || timeUp) await closeTrade(s.id);
    }
  }
}

/* ---------- 3. investment accrual ---------- */
export async function runAccrual() {
  const due = await sql`
    select i.id, i.user_id, i.principal::text, i.periods_paid, p.roi_percent::text roi,
           p.period_hours, p.duration_periods, p.name, p.principal_returned
    from investments i join plans p on p.id = i.plan_id
    where i.status = 'active'
      and i.periods_paid < p.duration_periods
      and coalesce(i.last_accrual_at, i.started_at) < now() - (p.period_hours || ' hours')::interval`;

  for (const i of due) {
    const payout = (Number(i.principal) * Number(i.roi)) / 100;

    await sql`update investments
      set accrued = accrued + ${payout}, periods_paid = periods_paid + 1, last_accrual_at = now()
      where id = ${i.id}`;

    await sql`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo)
      values (${i.user_id}, 'profit', 'investment_payout', ${payout}, 'investment', ${i.id},
              ${`${i.name} return, period ${i.periods_paid + 1}/${i.duration_periods}`})`;

    // Final period: release the principal and close the plan.
    if (i.periods_paid + 1 >= i.duration_periods) {
      await sql`update investments set status = 'matured' where id = ${i.id}`;
      if (i.principal_returned) {
        await sql`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo) values
          (${i.user_id}, 'locked', 'investment_close', ${-Number(i.principal)}, 'investment', ${i.id}, 'Principal released'),
          (${i.user_id}, 'main',   'investment_close', ${Number(i.principal)},  'investment', ${i.id}, ${`${i.name} matured`})`;
      }
      await sql`insert into notifications (user_id, kind, title, body)
        values (${i.user_id}, 'success', 'Plan matured',
                ${`Your ${i.name} plan has completed. Principal and returns are back in your balance.`})`;

      // Plan closing mail — fire-and-forget; never block the accrual loop.
      const [owner] = await sql`select email, first_name from users where id = ${i.user_id}`;
      if (owner) {
        mailPlanClosed(
          { id: i.user_id, email: owner.email, firstName: owner.first_name },
          i.name, i.principal, i.accrued + payout,
        ).catch((e) => console.error('[mail] plan closed failed:', e.message));
      }
    }
  }
  return due.length;
}

/* ---------- scheduler ---------- */
export function startEngine() {
  const every = Number(process.env.PRICE_POLL_MS || 15000);
  let busy = false;

  const tick = async () => {
    if (busy) return;                 // never let two ticks overlap
    busy = true;
    try {
      await pollPrices();
      await runMarket();
    } catch (e) {
      console.error('[engine] tick failed:', e.message);
    } finally { busy = false; }
  };

  tick();
  setInterval(tick, every);
  setInterval(() => runAccrual().catch((e) => console.error('[accrual]', e.message)), 60000);
  console.log(`[engine] running — prices every ${every / 1000}s, accrual every 60s`);
}
