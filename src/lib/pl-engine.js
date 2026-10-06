import crypto from 'node:crypto';
import { sql } from '../db/client.js';

/* =================================================================
   Automated profit/loss engine.

   Instead of an admin hand-setting every result, a plan carries a
   configuration — a win probability plus a profit range and a loss
   range — and each completed period draws its own outcome from it.
   Over many periods the realised win share converges on the configured
   probability, so a 70% plan yields roughly 70 wins and 30 losses.

   Randomness is drawn with crypto.randomInt (not Math.random), and every
   draw is recorded in investment_results together with the parameters
   that were in force, so a result can always be explained after the fact
   even if the plan is edited later.
   ================================================================= */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (n, dp) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/* A uniform float in [0,1) built from crypto bytes — high resolution and
   not predictable from previous outcomes the way Math.random can be. */
function uniform() {
  const buf = crypto.randomBytes(6);
  const n = buf.readUIntBE(0, 6);          // 48 bits
  return n / 2 ** 48;
}

/** Normalize a plan row (or form body) into a validated config object.
    Ranges are ordered, negatives are made positive, the probability is
    clamped to 0–100. Returns { config, errors }. */
export function normalizePlanConfig(p) {
  const errors = [];
  const winProbability = clamp(num(p.winProbability, 65), 0, 100);

  let profitMin = num(p.profitMinPercent, 0.5);
  let profitMax = num(p.profitMaxPercent, 2);
  let lossMin = num(p.lossMinPercent, 0.2);
  let lossMax = num(p.lossMaxPercent, 1.5);

  if (profitMin < 0 || profitMax < 0) errors.push('Profit percentages cannot be negative.');
  if (lossMin < 0 || lossMax < 0) errors.push('Loss percentages cannot be negative.');
  if (profitMin > profitMax) [profitMin, profitMax] = [profitMax, profitMin];
  if (lossMin > lossMax) [lossMin, lossMax] = [lossMax, lossMin];

  return {
    config: {
      winProbability: round(winProbability, 2),
      profitMinPercent: round(Math.abs(profitMin), 4),
      profitMaxPercent: round(Math.abs(profitMax), 4),
      lossMinPercent: round(Math.abs(lossMin), 4),
      lossMaxPercent: round(Math.abs(lossMax), 4),
    },
    errors,
  };
}

/** Draw one outcome from a config. Pure — no DB, no clock. `principal`
    is the base the percentage is applied to. */
export function drawOutcome(config, principal) {
  const p = clamp(num(config.winProbability, 65), 0, 100) / 100;
  const roll = uniform();
  const isWin = roll < p;

  const lo = isWin ? num(config.profitMinPercent, 0.5) : num(config.lossMinPercent, 0.2);
  const hi = isWin ? num(config.profitMaxPercent, 2) : num(config.lossMaxPercent, 1.5);
  const magnitude = round(lo + uniform() * (Math.max(lo, hi) - Math.min(lo, hi)), 4);
  const percent = round(isWin ? magnitude : -magnitude, 4);

  const base = num(principal, 0);
  const amount = round((base * percent) / 100, 8);

  const reason =
    `${isWin ? 'Win' : 'Loss'}: win probability ${config.winProbability}% · ` +
    `uniform draw ${roll.toFixed(6)} ${isWin ? '<' : '≥'} ${p.toFixed(4)} → ${isWin ? 'win' : 'loss'} · ` +
    `${isWin ? 'profit' : 'loss'} range ${lo}%–${Math.max(lo, hi)}% · ` +
    `applied ${percent}% of principal ${base.toFixed(2)} = ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}`;

  return { outcome: isWin ? 'win' : 'loss', percent, amount, roll, reason };
}

/** Dry-run a config: draw `periods` outcomes per run across `runs` runs
    and aggregate. Never touches the database — this is the simulation
    mode the admin uses to sanity-check a plan before publishing it. */
export function simulateConfig(config, { runs = 1, periods = 100, principal = 1000 } = {}) {
  runs = clamp(Math.round(num(runs, 1)), 1, 200);
  periods = clamp(Math.round(num(periods, 100)), 1, 5000);
  principal = num(principal, 1000);

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, net = 0;
  const sample = [];

  for (let r = 0; r < runs; r++) {
    for (let i = 0; i < periods; i++) {
      const d = drawOutcome(config, principal);
      net += d.amount;
      if (d.outcome === 'win') { wins++; grossProfit += d.amount; }
      else { losses++; grossLoss += Math.abs(d.amount); }
      if (sample.length < 12) sample.push(d);
    }
  }

  const total = wins + losses;
  return {
    runs, periods, principal,
    totalOutcomes: total,
    wins, losses,
    winRate: total ? (wins / total) * 100 : 0,
    expectedWinRate: num(config.winProbability, 0),
    avgProfit: wins ? grossProfit / wins : 0,
    avgLoss: losses ? grossLoss / losses : 0,
    grossProfit, grossLoss, net,
    roi: principal ? (net / (principal * total)) * 100 : 0,
    sample,
  };
}

/* Post one generated result to the ledger and record the audit row.
   Everything commits together in one transaction, so the balance, the
   investment's accrued figure and the audit trail can never disagree. */
export async function generateInvestmentResult({
  investmentId, planId, userId, principal, periodNumber, config, reasonPrefix = null,
}) {
  const draw = drawOutcome(config, principal);
  const params = {
    winProbability: config.winProbability,
    profitMinPercent: config.profitMinPercent,
    profitMaxPercent: config.profitMaxPercent,
    lossMinPercent: config.lossMinPercent,
    lossMaxPercent: config.lossMaxPercent,
  };
  const reason = reasonPrefix ? `${reasonPrefix} ${draw.reason}` : draw.reason;

  return sql.begin(async (tx) => {
    const [before] = await tx`
      select coalesce(sum(amount),0)::text s from ledger
      where user_id = ${userId} and account = 'profit'`;
    const balanceBefore = Number(before.s);
    const balanceAfter = round(balanceBefore + draw.amount, 8);

    await tx`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo)
      values (${userId}, 'profit', 'investment_payout', ${String(draw.amount)}, 'investment', ${investmentId},
              ${`Period ${periodNumber} ${draw.outcome}: ${draw.percent >= 0 ? '+' : ''}${draw.percent}%`})`;

    const [row] = await tx`
      insert into investment_results
        (investment_id, plan_id, user_id, period_number, outcome, percent, amount,
         principal, balance_before, balance_after, mode, params, reason)
      values (${investmentId}, ${planId}, ${userId}, ${periodNumber}, ${draw.outcome},
              ${String(draw.percent)}, ${String(draw.amount)}, ${String(principal)},
              ${String(balanceBefore)}, ${String(balanceAfter)}, 'live',
              ${JSON.stringify(params)}, ${reason})
      returning id`;

    return { id: row.id, ...draw, balanceBefore, balanceAfter, reason, params };
  });
}

/** Aggregate performance for a plan (or all plans) from the audit table.
    Live results only — simulation previews are excluded. */
export async function planPerformance(planId = null) {
  const [r] = await sql`
    select count(*)::int                                             total,
           count(*) filter (where outcome = 'win')::int              wins,
           count(*) filter (where outcome = 'loss')::int             losses,
           coalesce(sum(amount) filter (where outcome = 'win'), 0)::text  gross_profit,
           coalesce(sum(abs(amount)) filter (where outcome = 'loss'), 0)::text gross_loss,
           coalesce(sum(amount), 0)::text                            net,
           coalesce(avg(percent) filter (where outcome = 'win'), 0)::text avg_win_pct,
           coalesce(avg(abs(percent)) filter (where outcome = 'loss'), 0)::text avg_loss_pct,
           coalesce(avg(amount) filter (where outcome = 'win'), 0)::text  avg_profit,
           coalesce(avg(abs(amount)) filter (where outcome = 'loss'), 0)::text avg_loss,
           max(created_at)                                           last_at
    from investment_results
    where mode = 'live' ${planId ? sql`and plan_id = ${planId}` : sql``}`;

  const total = Number(r.total);
  const wins = Number(r.wins);
  return {
    total, wins, losses: Number(r.losses),
    winRate: total ? (wins / total) * 100 : 0,
    grossProfit: Number(r.gross_profit),
    grossLoss: Number(r.gross_loss),
    net: Number(r.net),
    avgWinPct: Number(r.avg_win_pct),
    avgLossPct: Number(r.avg_loss_pct),
    avgProfit: Number(r.avg_profit),
    avgLoss: Number(r.avg_loss),
    lastAt: r.last_at,
  };
}

/** Per-plan performance rows for the admin performance page. */
export async function planPerformanceByPlan() {
  return (await sql`
    select p.id, p.name, p.slug, p.win_probability::text win_probability, p.active,
           count(ir.id)::int                                            total,
           count(ir.id) filter (where ir.outcome = 'win')::int          wins,
           count(ir.id) filter (where ir.outcome = 'loss')::int         losses,
           coalesce(sum(ir.amount), 0)::text                            net,
           coalesce(avg(ir.amount) filter (where ir.outcome = 'win'), 0)::text avg_profit,
           coalesce(avg(abs(ir.amount)) filter (where ir.outcome = 'loss'), 0)::text avg_loss
    from plans p
    left join investment_results ir on ir.plan_id = p.id and ir.mode = 'live'
    group by p.id
    order by p.sort_order, p.id`).map((r) => {
    const total = Number(r.total), wins = Number(r.wins);
    return {
      id: r.id, name: r.name, slug: r.slug, active: r.active,
      configuredWinRate: Number(r.win_probability),
      total, wins, losses: Number(r.losses),
      winRate: total ? (wins / total) * 100 : 0,
      net: Number(r.net),
      avgProfit: Number(r.avg_profit),
      avgLoss: Number(r.avg_loss),
    };
  });
}
