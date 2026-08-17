# Marketedge — project notes

## Stack
Node.js + Hono (web) + Drizzle ORM + Postgres + Eta templates. Single-process.
- Entry: `src/index.js` — boots web server, runs migration, optionally starts engine (`RUN_ENGINE=false` to disable price-polling/engine worker).
- DB client: `src/db/client.js` exports `db` (drizzle) and `sql` (raw tagged template via postgres).
- Migrations: `src/db/migrate.js` (idempotent `create table if not exists` style). Run with `node src/db/migrate.js`.
- Seed: `src/db/seed.js` creates admin (`admin@marketedge.com`) + demo client + plans/traders/prices.
- Auth: `src/lib/auth.js` — cookie session (`rr_sid`), CSRF token = HMAC of session id (stable per session), `csrfGuard` middleware on all POST/PUT/PATCH/DELETE.
- Views: `src/lib/view.js` — Eta render. Templates in `src/views/`. Layout wraps inner body via `<%~ it.body %>`.
- Static assets: `public/` (js/app.js, css).

## Key conventions
- All forms include `<input type="hidden" name="_csrf" value="<%= it.csrf %>">`.
- Eta raw output uses `<%~ %>` (needed for JSON in data attributes; `<%= %>` HTML-escapes).
- Admin routes in `src/routes/admin.js`, user routes in `src/routes/dashboard.js`.
- Mail: `src/lib/mail.js` renders `.eta` body wrapped by `views/mail/layout.eta`, logs to `mail_log` table, sends via nodemailer SMTP. `getTransporter()` reads `mail_config` from `settings` table first, then `SMTP_URL` env, else log-only. Fire-and-forget with `.catch()`.
- Settings: `src/lib/settings.js` — key/value store in `settings` table (jsonb). Wallet addresses stored under key `wallet_addresses`.

## Testing locally
Needs Postgres. Start one, set `DATABASE_URL` in `.env` (use `?sslmode=disable` for a local container — `postgres` lib defaults to SSL `require`), run `node src/db/migrate.js && node src/db/seed.js`, then `RUN_ENGINE=false node src/index.js`.
- CSRF note for curl: fetch the page with the cookie jar, grep the `_csrf` token, POST with the same jar. Token is stable per session.

## Deployment (Railway)
- `railway.json` (DOCKERFILE builder) + `Dockerfile` (node:22-slim, builds argon2 native binding). `.dockerignore` excludes node_modules/.env/.git/public/uploads.
- App runs migration on boot (background, non-fatal) so `npm run migrate` is optional. `/healthz` = liveness (no DB), `/readyz` = readiness (DB probe). Docker HEALTHCHECK hits `/healthz`.
- `PORT` injected by Railway. Required vars: `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Optional: `UPLOAD_DIR`, `SMTP_URL`/`MAIL_FROM`.
- Receipt uploads: saved to `UPLOAD_DIR` (default `public/uploads`). Railway filesystem is ephemeral → mount a Volume at `/data` and set `UPLOAD_DIR=/data/uploads` or receipts vanish on redeploy. Dir is auto-created on boot (before static routes register). Served at `/uploads/*` via serveStatic with rewriteRequestPath.
- Mail/SMTP: configured via admin UI (System → Mail settings), stored in `settings` table key `mail_config` (persists across redeploys). No env var needed. `getTransporter()` is async (reads DB). Gmail: smtp.gmail.com:465 SSL + App Password.
