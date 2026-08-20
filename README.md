# Marketedge

Multi-asset trading platform — public marketing site, client dashboard, and admin panel.
Node + Hono, server-rendered with Eta and HTMX, Postgres via Drizzle. No build step, no
bundler, ~110 MB resident on Railway.

---

## The one architectural decision that matters

**No figure shown to a user is stored as a figure.**

- A balance is `SUM(ledger.amount)`, not a column. It can always be explained line by line,
  and it cannot drift out of sync with the transactions that produced it.
- A trader's win rate, follower count, and return are `GROUP BY` aggregates over
  `trader_trades` and `copy_follows`. There is no admin field for "total profit" because
  there is nothing to type into.
- Admin balance corrections write a `kind = 'adjustment'` ledger row carrying the
  administrator's email and a mandatory reason. The client sees it in their statement.

This is what separates the platform from the scripts it resembles. It also means a demo left
running overnight has genuinely moved by morning — positions opened and closed, plans accrued,
the leaderboard reordered — because a background engine is writing real rows the whole time.

---

## Deploy to Railway

### 1. Database (Supabase or Neon)

**Supabase.** Project Settings → Database → Connection string → **Session pooler** (Supavisor,
port 5432). It looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Append `?sslmode=require` when setting it as `DATABASE_URL`. Do **not** use the direct host
(`db.<ref>.supabase.co`) — it is IPv6-only and unreachable from Railway's network, and do not
use the transaction pooler (port 6543). The app runs with `prepare: false` and a small
connection pool, which is exactly what the session pooler expects.

**Neon.** Create a database and copy the **pooled** connection string — the host contains
`-pooler`. The direct endpoint will exhaust its connection limit under a warm container.
In Neon's settings, either disable scale-to-zero or accept a ~500 ms cold start on the first
request after an idle period. For a demo you're showing to someone, disable it.

### 2. Railway

```bash
railway init
railway up
```

Railway detects `railway.json` and builds from the Dockerfile.

Set these variables in the Railway dashboard:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **session pooler** or Neon **pooled** connection string |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ADMIN_EMAIL` | your admin login |
| `ADMIN_PASSWORD` | strong password, change after first login |
| `NODE_ENV` | `production` |
| `BRAND_NAME` / `BRAND_DOMAIN` | your branding |
| `UPLOAD_DIR` | `/data/uploads` (if a volume is mounted at `/data`) |

`PORT` is injected by Railway. Leave it unset. SMTP/mail is configured from the
admin UI after first login — no env var needed.

### 3. Schema and seed

```bash
railway run npm run migrate   # creates tables (idempotent, also runs on boot)
railway run npm run seed      # plans, traders, bots, admin, demo client, trade history
```

The seed prints the admin and demo credentials. It's idempotent — safe to re-run.
`migrate` also runs automatically when the app boots, so this step is optional.

### Moving an existing database to a new provider (e.g. Neon → Supabase)

The data layer is plain Postgres — no provider-specific features are used.

```bash
# 1. Dump from the OLD database
pg_dump --no-owner --no-privileges -Fc -f marketedge.dump "$OLD_DATABASE_URL"

# 2. Restore into the NEW database (use the pooler/direct host you can reach)
pg_restore --no-owner --no-privileges -d "$NEW_DATABASE_URL" marketedge.dump

# 3. Point Railway at the new database: Variables → DATABASE_URL → save (redeploys)
```

If you don't need to keep existing data, skip the dump/restore: just set
`DATABASE_URL` to the new database — the app creates the schema on boot — then run
`railway run npm run seed` (fresh content) or `npm run reset-admin` (admin only).

### 4. Persistent uploads (Volume)

Receipts are saved to disk under `UPLOAD_DIR` (defaults to `public/uploads`).
Railway's filesystem is **ephemeral** — without a volume, uploaded receipts vanish
on every redeploy/restart. Attach a volume to keep them:

1. In the service → **Settings → Volumes**, add a volume mounted at `/data`.
2. Set the env var `UPLOAD_DIR=/data/uploads`.
3. Redeploy. The app creates the directory on boot.

Mail config and sessions already live in the database, so they persist without a volume.

### 5. Domain

Add your domain in Railway's settings. TLS is issued automatically, which also fixes the
"Not secure" warning in the address bar.

### 6. Transactional email (Gmail)

The platform sends welcome, deposit, withdrawal, plan and KYC emails. SMTP is
**optional at deploy time** — with nothing configured every mail is still logged to
the outbox (status `logged`); it just isn't delivered. Configure it from the admin UI,
no redeploy required.

**Option A — Gmail App Password (recommended for a quick start)**

1. Enable **2-Step Verification** on the Google account:
   <https://myaccount.google.com/security>
2. Open **App Passwords** and create one for *Mail*:
   <https://myaccount.google.com/apppasswords>
3. Sign in as admin → **System → Mail settings** and enter:
   - SMTP host: `smtp.gmail.com`
   - Port: `465`, SSL on
   - Username: your full Gmail address
   - Password: the 16-character App Password (spaces are fine)
   - From name / From address: your Gmail address
4. **Save**, then **Send a test email**. The result shows at the top and in the
   **Mail outbox** (status `sent`).

The credentials are stored in the database `settings` table (key `mail_config`),
never in `.env`, and the password field is masked — leave it blank on save to keep
the existing one. Gmail caps sending at ~500/day; for higher volume use a dedicated
provider (SendGrid, Postmark, Amazon SES) with the same form.

**Option B — environment variable**

For infrastructure-as-code, set `SMTP_URL` instead (e.g.
`smtps://user:pass@smtp.example.com`). The admin UI config takes precedence when
both are present. `MAIL_FROM` sets the default From header in that mode.

---

## Local development

```bash
cp .env.example .env      # fill in DATABASE_URL and SESSION_SECRET
npm install
npm run db:push
npm run seed
npm run dev               # http://localhost:3000
```

---

## Layout

```
src/
  index.js              server, middleware, CSP, error pages
  db/
    schema.js           Drizzle schema — start here to understand the data model
    client.js           pooled postgres.js connection (pgbouncer-safe)
    seed.js             idempotent seed
  lib/
    auth.js             argon2id, DB sessions, CSRF, rate limiting
    stats.js            every derived figure in the product
    money.js            formatting helpers
    view.js             Eta renderer
  routes/               public · auth · dashboard · admin
  views/                .eta templates (layouts / pages / dashboard / admin / partials)
  workers/engine.js     price polling, trade simulation, investment accrual
public/css/app.css      design tokens + component system
```

---

## The engine

`startEngine()` runs three loops in-process:

1. **Prices** — every 15 s from Binance's public ticker, falling back to CoinGecko. Writes to
   the `prices` table. No API key needed.
2. **Market** — marks open positions to the current price, opens new trader positions at a rate
   proportional to their risk score, and closes on take-profit, stop-loss, or elapsed time.
   Follower slices mirror proportionally, capped at 20% of allocation per trade.
3. **Accrual** — investment plans pay their periodic return into the ledger and release
   principal at maturity.

Set `RUN_ENGINE=false` to disable. If you scale past one Railway instance, run the engine as a
separate service with that flag set on the web instances, or the loops will double up.

---

## Charts

TradingView widgets handle candles, screeners, and market overviews — they're free, genuinely
live, and better than anything worth rebuilding. Our own `prices` table drives every figure the
application computes. The two never disagree because they never overlap.

---

## Before going live

- [ ] Replace the three placeholder pages in `src/views/pages/legal-*.eta` with real text
- [ ] Wire the contact form in `src/routes/public.js` to your inbox
- [ ] Swap the in-memory rate limiter in `lib/auth.js` for Redis if you run more than one instance
- [ ] Point deposit methods at a real payment gateway — nothing currently verifies an on-chain transfer
- [ ] Rotate `ADMIN_PASSWORD`
- [ ] Review the plan rates you publish (see below)

---

## A note on the numbers you publish

The plan rates are configurable and seeded conservatively (0.85%–1.60% per day). Push them much
higher and two things happen: Google Safe Browsing starts flagging the domain, and payment
processors decline the merchant account. Stripe, PayPal, and Flutterwave all screen for
high-yield-investment patterns, and "150% per trade" next to a hand-typed follower count is the
canonical signature.

The computed-stats architecture is the defensible answer to that screening — everything on the
platform can be traced to a transaction. It's worth keeping when you configure the live rates.
