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
- Login diagnostics: failed logins are logged server-side (`[auth] login failed (no such user|bad password)`) while the UI stays generic — check app logs before touching the DB. Account recovery: `ADMIN_PASSWORD='New!123' npm run reset-admin` (creates or resets the admin; see `src/db/reset-admin.js`).
- Mail: `src/lib/mail.js` renders `.eta` body wrapped by `views/mail/layout.eta`, logs to `mail_log` table, sends via nodemailer SMTP. `getTransporter()` reads `mail_config` from `settings` table first, then `SMTP_URL` env, else log-only. Fire-and-forget with `.catch()`.
- Settings: `src/lib/settings.js` — key/value store in `settings` table (jsonb). Wallet addresses stored under key `wallet_addresses`.

## Frontend conventions & gotchas
- reCAPTCHA v3: the token is generated client-side by `public/js/app.js` (intercepts `form.recaptcha-form` submits). ANY layout that renders a recaptcha form MUST include `<script src="/js/app.js" defer></script>` — `layouts/site.eta` and `layouts/app.eta` do; `layouts/auth.eta` was missing it (fixed), which broke login/register with "reCAPTCHA token missing."
- Inner page templates are rendered via `eta.render(view, {...})` into `body` BEFORE `render()` wraps the layout — so `csrf`/`user` injected by `render()` do NOT reach the inner template. Every inner render of a form template must pass `csrf: c.get('csrf')` explicitly (admin.js/dashboard.js do; public.js SIMPLE pages + contact POST were missing it → `_csrf` rendered as literal "undefined" → 403 "session expired").
- `public/css/app.css` carries two naming layers: a BEM-style layer (`.stat__v`, `.card--flush`, `.btn--ghost`) and a "single-dash" compatibility layer (`.stat-v`, `.btn-ghost`, `.card-head`, `.metric-card`, `.notice`, `.page-head`, `.kv`, `.meter`, `.avatar`, `.trader-head`, `.plan*`, `.row2`). The `.eta` dashboard templates use the single-dash names; both resolve onto the same design tokens. Keep new component styles in the single-dash layer to match the templates.
- Dashboard tables use bare `<table>` inside `.table-wrap` (NOT the `.tbl` class). Styles live under `.table-wrap table` so they apply automatically — no need to add a class in templates.
- Sidebar (`.side`) is a sticky column on desktop (`@media min-width 901px`) and a fixed off-canvas drawer on mobile (`@media max-width 900px`). The drawer is driven by `public/js/app.js`: `[data-side-toggle]` opens, `.scrim`/`.side-close`/ESC/nav-link click close, and `body.side-open` locks scroll. Breakpoint is 900px; a tablet refinement exists for 901–1100px.

## Testing locally
Needs Postgres. Start one, set `DATABASE_URL` in `.env` (use `?sslmode=disable` for a local container — `postgres` lib defaults to SSL `require`), run `node src/db/migrate.js && node src/db/seed.js`, then `RUN_ENGINE=false node src/index.js`.
- CSRF note for curl: fetch the page with the cookie jar, grep the `_csrf` token, POST with the same jar. Token is stable per session.

## Deployment (Railway)
- `railway.json` (DOCKERFILE builder) + `Dockerfile` (node:22-slim, builds argon2 native binding). `.dockerignore` excludes node_modules/.env/.git/public/uploads.
- **Auto-deploy: the Railway service is connected to the GitHub repo — every push to `main` triggers a build + deploy automatically.** No manual step. If a push does NOT trigger a build, the repo↔service link is broken: re-connect it in Railway dashboard → service → Settings → Source, or enable "Auto Deploy". Verify a deploy landed by hitting `/healthz` and checking Railway logs.
- App runs migration on boot (background, non-fatal) so `npm run migrate` is optional. `/healthz` = liveness (no DB), `/readyz` = readiness (DB probe). Docker HEALTHCHECK hits `/healthz`.
- `PORT` injected by Railway. Required vars: `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Optional: `UPLOAD_DIR`, `SMTP_URL`/`MAIL_FROM`.
- Receipt uploads: saved to `UPLOAD_DIR` (default `public/uploads`). Railway filesystem is ephemeral → mount a Volume at `/data` and set `UPLOAD_DIR=/data/uploads` or receipts vanish on redeploy. Dir is auto-created on boot (before static routes register). Served at `/uploads/*` via serveStatic with rewriteRequestPath.
- Mail/SMTP: configured via admin UI (System → Mail settings), stored in `settings` table key `mail_config` (persists across redeploys). No env var needed. `getTransporter()` is async (reads DB). Gmail: smtp.gmail.com:465 SSL + App Password.
