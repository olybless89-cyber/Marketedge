import {
  pgTable, serial, text, varchar, timestamp, boolean,
  numeric, integer, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------
   Money is numeric(20,8) everywhere. Never float.
   Every displayed figure in this app derives from these tables —
   nothing is typed in by an admin and shown as fact.
---------------------------------------------------------------- */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  firstName: varchar('first_name', { length: 80 }).notNull(),
  lastName: varchar('last_name', { length: 80 }).notNull(),
  country: varchar('country', { length: 80 }),
  phone: varchar('phone', { length: 40 }),
  role: varchar('role', { length: 20 }).notNull().default('user'), // user | admin
  status: varchar('status', { length: 20 }).notNull().default('active'), // active | suspended
  kycStatus: varchar('kyc_status', { length: 20 }).notNull().default('unverified'),
  referralCode: varchar('referral_code', { length: 20 }),
  referredBy: integer('referred_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
  refIdx: uniqueIndex('users_ref_idx').on(t.referralCode),
}));

/* Ledger. Balance is never a column — it is the sum of this table.
   That means a balance can always be explained line by line.        */
export const ledger = pgTable('ledger', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  account: varchar('account', { length: 24 }).notNull().default('main'), // main | profit | locked
  kind: varchar('kind', { length: 32 }).notNull(),
  // deposit | withdrawal | investment_open | investment_payout |
  // copy_open | copy_close | bot_open | bot_close | fee | adjustment | referral
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(), // signed
  currency: varchar('currency', { length: 8 }).notNull().default('USD'),
  refType: varchar('ref_type', { length: 32 }),
  refId: integer('ref_id'),
  memo: text('memo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('ledger_user_idx').on(t.userId, t.createdAt),
}));

export const transactions = pgTable('transactions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  type: varchar('type', { length: 20 }).notNull(), // deposit | withdrawal
  method: varchar('method', { length: 40 }).notNull(), // btc | usdt_trc20 | bank | card
  amount: numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull().default('USD'),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending | approved | rejected
  address: text('address'),
  proofUrl: text('proof_url'),
  adminNote: text('admin_note'),
  reviewedBy: integer('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('tx_user_idx').on(t.userId, t.createdAt),
  statusIdx: index('tx_status_idx').on(t.status),
}));

/* Investment plans. roiPercent is per period, not "per trade" — a
   period has an explicit length so maturity is computable.          */
export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  slug: varchar('slug', { length: 80 }).notNull(),
  badge: varchar('badge', { length: 40 }),
  roiPercent: numeric('roi_percent', { precision: 8, scale: 4 }).notNull(),
  periodHours: integer('period_hours').notNull().default(24),
  durationPeriods: integer('duration_periods').notNull().default(30),
  minAmount: numeric('min_amount', { precision: 20, scale: 2 }).notNull(),
  maxAmount: numeric('max_amount', { precision: 20, scale: 2 }).notNull(),
  principalReturned: boolean('principal_returned').notNull().default(true),
  features: jsonb('features').$type().default([]),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({ slugIdx: uniqueIndex('plans_slug_idx').on(t.slug) }));

export const investments = pgTable('investments', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  planId: integer('plan_id').notNull(),
  principal: numeric('principal', { precision: 20, scale: 8 }).notNull(),
  accrued: numeric('accrued', { precision: 20, scale: 8 }).notNull().default('0'),
  periodsPaid: integer('periods_paid').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('active'), // active | matured | cancelled
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastAccrualAt: timestamp('last_accrual_at', { withTimezone: true }),
  maturesAt: timestamp('matures_at', { withTimezone: true }).notNull(),
}, (t) => ({ userIdx: index('inv_user_idx').on(t.userId, t.status) }));

/* Traders. Note what is NOT here: follower count, total profit, win
   rate, equity %. Those are computed from copy_positions + follows
   so they cannot be invented. See src/lib/stats.js.                 */
export const traders = pgTable('traders', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 80 }).notNull(),
  displayName: varchar('display_name', { length: 80 }).notNull(),
  strategy: varchar('strategy', { length: 60 }).notNull(), // Swing Trader | Stock Market Pro
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  markets: jsonb('markets').$type().default([]),
  copyFee: numeric('copy_fee', { precision: 20, scale: 2 }).notNull().default('0'),
  minCopy: numeric('min_copy', { precision: 20, scale: 2 }).notNull().default('100'),
  riskScore: integer('risk_score').notNull().default(5), // 1-10
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex('traders_slug_idx').on(t.slug) }));

/* Every trade a trader makes. One row = one real, timestamped fill.
   Trader performance is an aggregate of these, nothing else.        */
export const traderTrades = pgTable('trader_trades', {
  id: serial('id').primaryKey(),
  traderId: integer('trader_id').notNull(),
  symbol: varchar('symbol', { length: 24 }).notNull(),
  side: varchar('side', { length: 8 }).notNull(), // buy | sell
  entryPrice: numeric('entry_price', { precision: 20, scale: 8 }).notNull(),
  exitPrice: numeric('exit_price', { precision: 20, scale: 8 }),
  sizeUsd: numeric('size_usd', { precision: 20, scale: 8 }).notNull(),
  leverage: integer('leverage').notNull().default(1),
  status: varchar('status', { length: 12 }).notNull().default('open'), // open | closed
  pnl: numeric('pnl', { precision: 20, scale: 8 }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ traderIdx: index('tt_trader_idx').on(t.traderId, t.status) }));

export const copyFollows = pgTable('copy_follows', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  traderId: integer('trader_id').notNull(),
  allocation: numeric('allocation', { precision: 20, scale: 8 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'), // active | stopped
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => ({ uIdx: index('cf_user_idx').on(t.userId, t.status) }));

/* A follower's mirrored slice of a trader trade. */
export const copyPositions = pgTable('copy_positions', {
  id: serial('id').primaryKey(),
  followId: integer('follow_id').notNull(),
  userId: integer('user_id').notNull(),
  traderTradeId: integer('trader_trade_id').notNull(),
  symbol: varchar('symbol', { length: 24 }).notNull(),
  side: varchar('side', { length: 8 }).notNull(),
  entryPrice: numeric('entry_price', { precision: 20, scale: 8 }).notNull(),
  exitPrice: numeric('exit_price', { precision: 20, scale: 8 }),
  sizeUsd: numeric('size_usd', { precision: 20, scale: 8 }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('open'),
  pnl: numeric('pnl', { precision: 20, scale: 8 }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ uIdx: index('cp_user_idx').on(t.userId, t.status) }));

export const bots = pgTable('bots', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 80 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  tagline: varchar('tagline', { length: 160 }),
  market: varchar('market', { length: 40 }).notNull().default('crypto'),
  cadence: varchar('cadence', { length: 40 }).notNull().default('scalp'),
  riskScore: integer('risk_score').notNull().default(5),
  minAllocation: numeric('min_allocation', { precision: 20, scale: 2 }).notNull().default('250'),
  active: boolean('active').notNull().default(true),
}, (t) => ({ slugIdx: uniqueIndex('bots_slug_idx').on(t.slug) }));

export const botRuns = pgTable('bot_runs', {
  id: serial('id').primaryKey(),
  botId: integer('bot_id').notNull(),
  userId: integer('user_id').notNull(),
  allocation: numeric('allocation', { precision: 20, scale: 8 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  pnl: numeric('pnl', { precision: 20, scale: 8 }).notNull().default('0'),
  tradesCount: integer('trades_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
});

/* Live price cache, filled by src/workers/prices.js */
export const prices = pgTable('prices', {
  symbol: varchar('symbol', { length: 24 }).primaryKey(),
  price: numeric('price', { precision: 20, scale: 8 }).notNull(),
  change24h: numeric('change_24h', { precision: 10, scale: 4 }),
  source: varchar('source', { length: 24 }).notNull().default('binance'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: integer('user_id').notNull(),
  ip: varchar('ip', { length: 64 }),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),
  title: varchar('title', { length: 160 }).notNull(),
  body: text('body'),
  kind: varchar('kind', { length: 24 }).notNull().default('info'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uIdx: index('notif_user_idx').on(t.userId, t.readAt) }));

export const settings = pgTable('settings', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value'),
});
