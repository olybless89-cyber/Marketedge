import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { compress } from 'hono/compress';

import { loadUser, csrfGuard, csrfToken } from './lib/auth.js';
import { pub } from './routes/public.js';
import { auth } from './routes/auth.js';
import { dash } from './routes/dashboard.js';
import { admin } from './routes/admin.js';
import { startEngine } from './workers/engine.js';
import { migrate } from './db/migrate.js';
import { warmTransporter } from './lib/mail.js';
import { ensureUploadDir, UPLOAD_DIR } from './lib/uploads.js';
import { sql } from './db/client.js';

// Ensure the upload directory exists before routes are registered, so the
// static file server finds its root even when UPLOAD_DIR points at a fresh
// volume mount. Safe no-op when it already exists.
await ensureUploadDir().catch((e) => console.error('[web] uploads dir init failed:', e.message));

const app = new Hono();

app.use('*', logger());
app.use('*', compress());
app.use('*', secureHeaders({
  // TradingView and Google reCAPTCHA need external scripts; everything else is locked down.
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://s3.tradingview.com', 'https://unpkg.com', 'https://www.tradingview-widget.com', 'https://www.google.com', 'https://www.gstatic.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'https://api.binance.com', 'https://api.coingecko.com', 'https://www.google.com', 'https:'],
    frameSrc: ['https://www.tradingview-widget.com', 'https://s.tradingview.com', 'https://www.tradingview.com', 'https://www.google.com'],
  },
  crossOriginEmbedderPolicy: false,
}));

app.use('/css/*', serveStatic({ root: './public' }));
app.use('/js/*',  serveStatic({ root: './public' }));
app.use('/img/*',  serveStatic({ root: './public' }));
// Receipts: served at /uploads/* but the on-disk root follows UPLOAD_DIR so
// it can live on a persistent volume in production.
app.use('/uploads/*', serveStatic({
  root: UPLOAD_DIR,
  rewriteRequestPath: (p) => p.replace(/^\/uploads/, ''),
}));

app.use('*', loadUser);
app.use('*', csrfGuard);
app.use('*', async (c, next) => { c.set('csrf', csrfToken(c)); await next(); });

app.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }));

// DB readiness probe — separate from liveness so a DB outage doesn't
// put Railway into a restart loop that prevents you from reading logs.
app.get('/readyz', async (c) => {
  try { await sql`select 1`; return c.json({ ok: true, db: true, ts: Date.now() }); }
  catch (e) { return c.json({ ok: false, db: false, error: e.message }, 503); }
});

// Order matters: public routes (auth + pub) must be mounted before the
// auth-protected routers, otherwise their `*` guard middleware would
// shadow public pages like /, /markets, /plans and force a login redirect.
app.route('/', auth);
app.route('/', pub);
app.route('/', dash);
app.route('/', admin);

app.notFound((c) => c.html(
  `<!doctype html><meta charset="utf-8"><title>Not found</title>
   <link rel="stylesheet" href="/css/app.css">
   <div style="min-height:100vh;display:grid;place-items:center;text-align:center;padding:20px">
     <div><h1 style="font-size:4rem;margin:0">404</h1>
     <p class="muted">That page doesn't exist.</p>
     <a class="btn btn-primary" href="/">Back to home</a></div>
   </div>`, 404));

app.onError((err, c) => {
  console.error('[error]', err);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Something broke</title>
     <link rel="stylesheet" href="/css/app.css">
     <div style="min-height:100vh;display:grid;place-items:center;text-align:center;padding:20px">
       <div><h1>Something broke on our side</h1>
       <p class="muted">The error is logged. Try again in a moment.</p>
       <a class="btn btn-primary" href="/">Back to home</a></div>
     </div>`, 500);
});

const port = Number(process.env.PORT || 3000);

// Start serving immediately. Migration runs in the background so a DB
// problem doesn't kill the container (and put Railway in a restart loop
// that hides the real error). The DB status is visible on /readyz.
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[web] listening on :${info.port}`);
  ensureUploadDir().catch((e) => console.error('[web] uploads dir failed:', e.message));
  migrate()
    .then(() => {
      console.log('[web] schema ready');
      // Warm the transporter only after migration: getTransporter() reads the
      // settings table, which doesn't exist yet on a fresh database.
      warmTransporter().catch((e) => console.error('[mail] transporter warm failed:', e.message));
      if (process.env.RUN_ENGINE !== 'false') startEngine();
    })
    .catch((err) => console.error('[web] migration failed (check DATABASE_URL):', err.message));
});

const bye = async () => { console.log('[web] shutting down'); await sql.end({ timeout: 5 }); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
