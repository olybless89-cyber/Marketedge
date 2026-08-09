import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');

// Neon: use the -pooler host. Railway containers keep connections warm and
// the direct endpoint will exhaust its connection limit under any real load.
if (!/-pooler\./.test(url) && /neon\.tech/.test(url)) {
  console.warn('[db] Neon URL is not the pooled endpoint. Use the host containing "-pooler".');
}

export const sql = postgres(url, {
  max: Number(process.env.DB_POOL_MAX || 8),
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,          // required for pgbouncer transaction pooling
  ssl: 'require',
});

export const db = drizzle(sql, { schema });
export { schema };
