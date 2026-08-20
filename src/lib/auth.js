import crypto from 'node:crypto';
import argon2 from 'argon2';
import { eq, and, gt } from 'drizzle-orm';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';

const COOKIE = 'rr_sid';
const DAYS = 14;

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set — CSRF tokens fall back to a known secret. Set SESSION_SECRET in production.');
}

export const hash = (pw) =>
  argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export const verify = async (h, pw) => {
  try { return await argon2.verify(h, pw); } catch { return false; }
};

export async function createSession(c, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + DAYS * 864e5);
  await db.insert(sessions).values({
    id, userId, expiresAt,
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
    userAgent: (c.req.header('user-agent') || '').slice(0, 400),
  });
  setCookie(c, COOKIE, id, {
    httpOnly: true, sameSite: 'Lax', path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: DAYS * 86400,
  });
}

export async function destroySession(c) {
  const id = getCookie(c, COOKIE);
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
  deleteCookie(c, COOKIE, { path: '/' });
}

/* Attaches c.get('user') if a live session exists. Never throws. */
export async function loadUser(c, next) {
  c.set('user', null);
  const id = getCookie(c, COOKIE);
  if (id) {
    try {
      const [row] = await db.select({ u: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
        .limit(1);
      if (row && row.u.status === 'active') c.set('user', row.u);
    } catch (e) { console.error('[auth] session lookup failed', e.message); }
  }
  await next();
}

export const requireUser = async (c, next) => {
  if (!c.req.path.startsWith('/dashboard')) return next();
  if (!c.get('user')) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  await next();
};

export const requireAdmin = async (c, next) => {
  if (!c.req.path.startsWith('/admin')) return next();
  const u = c.get('user');
  if (!u) return c.redirect('/login?next=/admin');
  if (u.role !== 'admin') return c.notFound();   // don't reveal the route exists
  await next();
};

/* CSRF: token derived from the session id, submitted back in a hidden field. */
export function csrfToken(c) {
  const sid = getCookie(c, COOKIE) || 'anon';
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-secret')
    .update(sid).digest('hex').slice(0, 32);
}

export const csrfGuard = async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const body = await c.req.parseBody();
    c.set('body', body);
    const sent = body._csrf;
    const want = csrfToken(c);
    if (!sent || sent.length !== want.length ||
        !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want))) {
      return c.text('Your session expired. Reload the page and try again.', 403);
    }
  }
  await next();
};

/* Small in-memory throttle for login/register. Fine for one Railway
   instance; swap for Redis if you scale horizontally. */
const hits = new Map();
export const throttle = (max = 8, windowMs = 300000) => async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const key = (c.req.header('x-forwarded-for')?.split(',')[0] || 'local') + c.req.path;
  const now = Date.now();
  const rec = hits.get(key) || { n: 0, until: now + windowMs };
  if (now > rec.until) { rec.n = 0; rec.until = now + windowMs; }
  rec.n++; hits.set(key, rec);
  if (rec.n > max) return c.text('Too many attempts. Wait five minutes and try again.', 429);
  await next();
};
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.until) hits.delete(k); }, 600000).unref?.();
