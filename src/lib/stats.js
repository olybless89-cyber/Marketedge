import { db, sql } from '../db/client.js';

/* =================================================================
   Nothing here accepts a number from a form. Every figure the UI
   renders is an aggregate over rows that were actually written.

   The practical payoff: a demo left running overnight has genuinely
   moved by morning, and no figure can contradict another because
   they all come from the same rows.
   ================================================================= */

/** Balance = sum of the ledger. There is no balance column to drift. */
export async function balance(userId) {
  const [r] = await sql`
    select
      coalesce(sum(amount) filter (where account = 'main'), 0)::text   as main,
      coalesce(sum(amount) filter (where account = 'profit'), 0)::text as profit,
      coalesce(sum(amount) filter (where account = 'locked'), 0)::text as locked,
      coalesce(sum(amount), 0)::text                                    as total
    from ledger where user_id = ${userId}`;
  return {
    main: Number(r.main), profit: Number(r.profit),
    locked: Number(r.locked), total: Number(r.total),
    available: Number(r.main) + Number(r.profit),
  };
}

/** Portfolio card figures for the user dashboard. */
export async function portfolio(userId) {
  const [r] = await sql`
    with dep as (
      select coalesce(sum(amount),0) v from transactions
      where user_id = ${userId} and type = 'deposit' and status = 'approved'),
    wd as (
      select coalesce(sum(amount),0) v from transactions
      where user_id = ${userId} and type = 'withdrawal' and status = 'approved'),
    pend as (
      select coalesce(sum(amount),0) v from transactions
      where user_id = ${userId} and status = 'pending'),
    inv as (
      select coalesce(sum(principal),0) p, coalesce(sum(accrued),0) a, count(*) n
      from investments where user_id = ${userId} and status = 'active'),
    cp as (
      select coalesce(sum(pnl),0) realised, count(*) filter (where pnl > 0) wins, count(*) n
      from copy_positions where user_id = ${userId} and status = 'closed'),
    open_cp as (
      select coalesce(sum(size_usd),0) exposure, count(*) n
      from copy_positions where user_id = ${userId} and status = 'open')
    select dep.v::text deposited, wd.v::text withdrawn, pend.v::text pending,
           inv.p::text staked, inv.a::text accrued, inv.n active_plans,
           cp.realised::text realised, cp.wins, cp.n closed_trades,
           open_cp.exposure::text exposure, open_cp.n open_trades
    from dep, wd, pend, inv, cp, open_cp`;

  const bal = await balance(userId);
  const closed = Number(r.closed_trades);
  return {
    ...bal,
    deposited: Number(r.deposited),
    withdrawn: Number(r.withdrawn),
    pending: Number(r.pending),
    staked: Number(r.staked),
    accrued: Number(r.accrued),
    activePlans: Number(r.active_plans),
    realised: Number(r.realised),
    exposure: Number(r.exposure),
    openTrades: Number(r.open_trades),
    closedTrades: closed,
    winRate: closed ? (Number(r.wins) / closed) * 100 : 0,
    equity: bal.total + Number(r.staked) + Number(r.accrued),
  };
}

/** Trader leaderboard. followers/profit/winRate are all aggregates. */
export async function traderStats(traderId = null) {
  const rows = await sql`
    select t.id, t.slug, t.display_name, t.strategy, t.bio, t.avatar_url,
           t.copy_fee::text copy_fee, t.min_copy::text min_copy, t.risk_score, t.markets,
           coalesce(f.followers, 0)                     as followers,
           coalesce(f.aum, 0)::text                     as aum,
           coalesce(s.closed, 0)                        as closed_trades,
           coalesce(s.wins, 0)                          as wins,
           coalesce(s.pnl, 0)::text                     as total_pnl,
           coalesce(s.volume, 0)::text                  as volume,
           coalesce(o.open_trades, 0)                   as open_trades,
           s.last_trade_at,
           extract(day from now() - t.created_at)::int  as active_days
    from traders t
    left join (
      select trader_id, count(*) followers, sum(allocation) aum
      from copy_follows where status = 'active' group by trader_id) f on f.trader_id = t.id
    left join (
      select trader_id, count(*) closed, count(*) filter (where pnl > 0) wins,
             sum(pnl) pnl, sum(size_usd) volume, max(closed_at) last_trade_at
      from trader_trades where status = 'closed' group by trader_id) s on s.trader_id = t.id
    left join (
      select trader_id, count(*) open_trades
      from trader_trades where status = 'open' group by trader_id) o on o.trader_id = t.id
    where t.active = true ${traderId ? sql`and t.id = ${traderId}` : sql``}
    order by coalesce(s.pnl, 0) desc`;

  return rows.map((r) => {
    const closed = Number(r.closed_trades);
    const volume = Number(r.volume);
    const pnl = Number(r.total_pnl);
    return {
      id: r.id, slug: r.slug, displayName: r.display_name, strategy: r.strategy,
      bio: r.bio, avatarUrl: r.avatar_url, markets: r.markets || [],
      copyFee: Number(r.copy_fee), minCopy: Number(r.min_copy), riskScore: r.risk_score,
      followers: Number(r.followers),
      aum: Number(r.aum),
      closedTrades: closed,
      openTrades: Number(r.open_trades),
      totalPnl: pnl,
      // return on volume traded — an honest denominator, unlike "equity %"
      roi: volume > 0 ? (pnl / volume) * 100 : 0,
      winRate: closed ? (Number(r.wins) / closed) * 100 : 0,
      lastTradeAt: r.last_trade_at,
      activeDays: Math.max(0, Number(r.active_days) || 0),
    };
  });
}

/** A single user's copy positions grouped per trader (dashboard cards). */
export async function myCopyPositions(userId) {
  return (await sql`
    select f.id follow_id, f.allocation::text allocation, f.status, f.started_at,
           t.id trader_id, t.display_name, t.strategy, t.avatar_url, t.slug,
           coalesce(sum(p.size_usd) filter (where p.status = 'open'), 0)::text exposure,
           coalesce(sum(p.pnl), 0)::text pnl,
           count(p.id) filter (where p.status = 'closed')            closed,
           count(p.id) filter (where p.status = 'closed' and p.pnl>0) wins,
           count(p.id) filter (where p.status = 'open')               open,
           max(p.opened_at) last_at
    from copy_follows f
    join traders t on t.id = f.trader_id
    left join copy_positions p on p.follow_id = f.id
    where f.user_id = ${userId} and f.status = 'active'
    group by f.id, t.id
    order by f.started_at desc`).map((r) => {
      const alloc = Number(r.allocation), pnl = Number(r.pnl), closed = Number(r.closed);
      return {
        followId: r.follow_id, traderId: r.trader_id, slug: r.slug,
        displayName: r.display_name, strategy: r.strategy, avatarUrl: r.avatar_url,
        allocation: alloc, exposure: Number(r.exposure), pnl,
        currentValue: alloc + pnl,
        roi: alloc > 0 ? (pnl / alloc) * 100 : 0,
        trades: closed + Number(r.open), closedTrades: closed, openTrades: Number(r.open),
        winRate: closed ? (Number(r.wins) / closed) * 100 : 0,
        lastAt: r.last_at, startedAt: r.started_at,
      };
    });
}

/** Platform-wide counters for the marketing page. Real, or hidden. */
export async function platformStats() {
  const [r] = await sql`
    select (select count(*) from users where role = 'user')                        as traders_count,
           (select count(*) from trader_trades)                                    as trades_count,
           (select coalesce(sum(size_usd),0) from trader_trades)::text             as volume,
           (select count(*) from traders where active = true)                      as strategies,
           (select count(*) from prices)                                           as instruments`;
  return {
    users: Number(r.traders_count),
    trades: Number(r.trades_count),
    volume: Number(r.volume),
    strategies: Number(r.strategies),
    instruments: Number(r.instruments),
  };
}

export async function livePrices(limit = 12) {
  return (await sql`
    select symbol, price::text, change_24h::text, updated_at
    from prices order by symbol limit ${limit}`).map((r) => ({
      symbol: r.symbol.replace(/USDT$/, ''),
      pair: r.symbol,
      price: Number(r.price),
      change: Number(r.change_24h || 0),
      updatedAt: r.updated_at,
    }));
}

export async function unreadCount(userId) {
  const [r] = await sql`select count(*)::int n from notifications
    where (user_id = ${userId} or user_id is null) and read_at is null`;
  return r.n;
}

export { db, sql };
