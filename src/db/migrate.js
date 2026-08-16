import 'dotenv/config';
import { sql } from './client.js';

/* Idempotent schema bootstrap.
   Creates every table from src/db/schema.js with CREATE TABLE IF NOT EXISTS,
   so a fresh database (e.g. Railway Postgres) is ready for the app and seed.
   Safe to run on every boot. */

const DDL = [
  `create table if not exists users (
    id serial primary key,
    email varchar(255) not null,
    password_hash text not null,
    first_name varchar(80) not null,
    last_name varchar(80) not null,
    country varchar(80),
    phone varchar(40),
    role varchar(20) not null default 'user',
    status varchar(20) not null default 'active',
    kyc_status varchar(20) not null default 'unverified',
    referral_code varchar(20),
    referred_by integer,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists users_email_idx on users(email)`,
  `create unique index if not exists users_ref_idx on users(referral_code)`,

  `create table if not exists ledger (
    id serial primary key,
    user_id integer not null,
    account varchar(24) not null default 'main',
    kind varchar(32) not null,
    amount numeric(20,8) not null,
    currency varchar(8) not null default 'USD',
    ref_type varchar(32),
    ref_id integer,
    memo text,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ledger_user_idx on ledger(user_id, created_at)`,

  `create table if not exists transactions (
    id serial primary key,
    user_id integer not null,
    type varchar(20) not null,
    method varchar(40) not null,
    amount numeric(20,8) not null,
    currency varchar(8) not null default 'USD',
    status varchar(20) not null default 'pending',
    address text,
    proof_url text,
    admin_note text,
    reviewed_by integer,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists tx_user_idx on transactions(user_id, created_at)`,
  `create index if not exists tx_status_idx on transactions(status)`,

  `create table if not exists plans (
    id serial primary key,
    name varchar(80) not null,
    slug varchar(80) not null,
    badge varchar(40),
    roi_percent numeric(8,4) not null,
    period_hours integer not null default 24,
    duration_periods integer not null default 30,
    min_amount numeric(20,2) not null,
    max_amount numeric(20,2) not null,
    principal_returned boolean not null default true,
    features jsonb default '[]',
    active boolean not null default true,
    sort_order integer not null default 0
  )`,
  `create unique index if not exists plans_slug_idx on plans(slug)`,

  `create table if not exists investments (
    id serial primary key,
    user_id integer not null,
    plan_id integer not null,
    principal numeric(20,8) not null,
    accrued numeric(20,8) not null default 0,
    periods_paid integer not null default 0,
    status varchar(20) not null default 'active',
    started_at timestamptz not null default now(),
    last_accrual_at timestamptz,
    matures_at timestamptz not null default now()
  )`,
  `create index if not exists inv_user_idx on investments(user_id, status)`,

  `create table if not exists spot_positions (
    id serial primary key,
    user_id integer not null,
    symbol varchar(24) not null,
    qty numeric(20,8) not null,
    entry_price numeric(20,8) not null,
    cost numeric(20,8) not null,
    status varchar(20) not null default 'open',
    pnl numeric(20,8) not null default 0,
    exit_price numeric(20,8),
    opened_at timestamptz not null default now(),
    closed_at timestamptz
  )`,
  `create index if not exists spot_user_idx on spot_positions(user_id, status)`,

  `create table if not exists traders (
    id serial primary key,
    slug varchar(80) not null,
    display_name varchar(80) not null,
    strategy varchar(60) not null,
    bio text,
    avatar_url text,
    markets jsonb default '[]',
    copy_fee numeric(20,2) not null default 0,
    min_copy numeric(20,2) not null default 100,
    risk_score integer not null default 5,
    active boolean not null default true,
    created_at timestamptz not null default now()
  )`,
  `create unique index if not exists traders_slug_idx on traders(slug)`,

  `create table if not exists trader_trades (
    id serial primary key,
    trader_id integer not null,
    symbol varchar(24) not null,
    side varchar(8) not null,
    entry_price numeric(20,8) not null,
    exit_price numeric(20,8),
    size_usd numeric(20,8) not null,
    leverage integer not null default 1,
    status varchar(12) not null default 'open',
    pnl numeric(20,8),
    opened_at timestamptz not null default now(),
    closed_at timestamptz
  )`,
  `create index if not exists tt_trader_idx on trader_trades(trader_id, status)`,

  `create table if not exists copy_follows (
    id serial primary key,
    user_id integer not null,
    trader_id integer not null,
    allocation numeric(20,8) not null,
    status varchar(20) not null default 'active',
    started_at timestamptz not null default now(),
    stopped_at timestamptz
  )`,
  `create index if not exists cf_user_idx on copy_follows(user_id, status)`,

  `create table if not exists copy_positions (
    id serial primary key,
    follow_id integer not null,
    user_id integer not null,
    trader_trade_id integer not null,
    symbol varchar(24) not null,
    side varchar(8) not null,
    entry_price numeric(20,8) not null,
    exit_price numeric(20,8),
    size_usd numeric(20,8) not null,
    status varchar(12) not null default 'open',
    pnl numeric(20,8),
    opened_at timestamptz not null default now(),
    closed_at timestamptz
  )`,
  `create index if not exists cp_user_idx on copy_positions(user_id, status)`,

  `create table if not exists bots (
    id serial primary key,
    slug varchar(80) not null,
    name varchar(80) not null,
    tagline varchar(160),
    market varchar(40) not null default 'crypto',
    cadence varchar(40) not null default 'scalp',
    risk_score integer not null default 5,
    min_allocation numeric(20,2) not null default 250,
    active boolean not null default true
  )`,
  `create unique index if not exists bots_slug_idx on bots(slug)`,

  `create table if not exists bot_runs (
    id serial primary key,
    bot_id integer not null,
    user_id integer not null,
    allocation numeric(20,8) not null,
    status varchar(20) not null default 'running',
    pnl numeric(20,8) not null default 0,
    trades_count integer not null default 0,
    started_at timestamptz not null default now(),
    stopped_at timestamptz
  )`,

  `create table if not exists prices (
    symbol varchar(24) primary key,
    price numeric(20,8) not null,
    change_24h numeric(10,4),
    source varchar(24) not null default 'binance',
    updated_at timestamptz not null default now()
  )`,

  `create table if not exists sessions (
    id varchar(64) primary key,
    user_id integer not null,
    ip varchar(64),
    user_agent text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,

  `create table if not exists notifications (
    id serial primary key,
    user_id integer,
    title varchar(160) not null,
    body text,
    kind varchar(24) not null default 'info',
    read_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists notif_user_idx on notifications(user_id, read_at)`,

  `create table if not exists kyc_submissions (
    id serial primary key,
    user_id integer not null,
    document_type varchar(40) not null,
    document_number varchar(80),
    country varchar(80),
    front_url text,
    back_url text,
    selfie_url text,
    status varchar(20) not null default 'pending',
    admin_note text,
    reviewed_by integer,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists kyc_user_idx on kyc_submissions(user_id, status)`,
  `create index if not exists kyc_status_idx on kyc_submissions(status)`,

  `create table if not exists mail_log (
    id serial primary key,
    user_id integer,
    to_email varchar(255) not null,
    template varchar(60) not null,
    subject varchar(200) not null,
    body_html text,
    status varchar(20) not null default 'logged',
    error text,
    ref_type varchar(32),
    ref_id integer,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists mail_user_idx on mail_log(user_id, created_at)`,
  `create index if not exists mail_tpl_idx on mail_log(template, created_at)`,

  `create table if not exists settings (
    key varchar(80) primary key,
    value jsonb
  )`,
];

export async function migrate() {
  for (const stmt of DDL) await sql.unsafe(stmt);
  console.log(`[migrate] ${DDL.length} statements applied (idempotent)`);
}

// Run directly: `node src/db/migrate.js`
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  migrate()
    .then(() => sql.end())
    .catch((e) => { console.error('[migrate] failed:', e); process.exit(1); });
}
