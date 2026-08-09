# Rydon Invest

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

### 1. Neon

Create a database and copy the **pooled** connection string — the host contains `-pooler`.
The direct endpoint will exhaust its connection limit under a warm container.

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
| `DATABASE_URL` | Neon **pooled** connection string |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ADMIN_EMAIL` | your admin login |
| `ADMIN_PASSWORD` | strong password, change after first login |
| `NODE_ENV` | `production` |
| `BRAND_NAME` / `BRAND_DOMAIN` | your branding |

`PORT` is injected by Railway. Leave it unset.

### 3. Schema and seed

```bash
railway run npm run db:push   # creates tables from src/db/schema.js
railway run npm run seed      # plans, traders, bots, admin, demo client, trade history
```

The seed prints the admin and demo credentials. It's idempotent — safe to re-run.

### 4. Domain

Add your domain in Railway's settings. TLS is issued automatically, which also fixes the
"Not secure" warning in the address bar.

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
