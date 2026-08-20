import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;

if (!url) {
  // Don't throw at import time — that crashes the process before the web
  // server starts, which puts Railway in a restart loop that hides the
  // real cause. Defer the failure to query time so /healthz still works
  // and the error surfaces in logs and on /readyz.
  console.error('[db] DATABASE_URL is not set. The web server will start, but every database query will fail. Add a Postgres database in Railway and set DATABASE_URL, then redeploy.');
}

// Neon: use the -pooler host. Railway containers keep connections warm and
// the direct endpoint will exhaust its connection limit under any real load.
if (url && !/-pooler\./.test(url) && /neon\.tech/.test(url)) {
  console.warn('[db] Neon URL is not the pooled endpoint. Use the host containing "-pooler".');
}

// Supabase: the direct host (db.<ref>.supabase.co) is IPv6-only on current
// projects, which Railway's network cannot reach. Use the Supavisor session
// pooler (aws-0-<region>.pooler.supabase.com:5432, user postgres.<ref>) —
// compatible with this client's prepare:false and multiple connections.
if (url && /db\.[a-z0-9]+\.supabase\.co/.test(url)) {
  console.warn('[db] Supabase direct host is IPv6-only and unreachable from most PaaS networks. Use the session pooler: postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require');
}

// Respect sslmode in the URL; default to require for production safety.
//   sslmode=require  -> ssl: 'require'
//   sslmode=disable  -> ssl: false   (local dev / testing)
//   (unset)          -> ssl: 'require'  (Railway Postgres and Neon both accept SSL)
const sm = url ? /sslmode=([^&]+)/i.exec(url) : null;
const sslOpt = !url
  ? false
  : sm ? (sm[1].toLowerCase() === 'disable' ? false : sm[1].toLowerCase()) : 'require';

// Placeholder URL when DATABASE_URL is unset; fails fast on connect with a
// clear ECONNREFUSED instead of crashing at import.
const connUrl = url || 'postgresql://unset:unset@127.0.0.1:5432/unset';

export const sql = postgres(connUrl, {
  max: Number(process.env.DB_POOL_MAX || 8),
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,          // required for pgbouncer transaction pooling
  ssl: sslOpt,
});

export const db = drizzle(sql, { schema });
export { schema };
