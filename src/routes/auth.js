import { Hono } from 'hono';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users, ledger, notifications } from '../db/schema.js';
import { hash, verify, createSession, destroySession, csrfToken, throttle } from '../lib/auth.js';
import { render, eta } from '../lib/view.js';
import { verifyRecaptcha } from '../lib/recaptcha.js';
import { mailWelcome } from '../lib/mail.js';
import * as fmt from '../lib/money.js';

export const auth = new Hono();

const shell = (c, view, data = {}, title = '') =>
  render(c, 'layouts/auth', { body: eta.render(view, { ...fmt, csrf: csrfToken(c), recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '', ...data }), title });

/* Already-authenticated users go straight to their area. */
const homeFor = (u) => (u?.role === 'admin' ? '/admin' : '/dashboard');

auth.get('/login', (c) => {
  const u = c.get('user');
  if (u) return c.redirect(homeFor(u));
  return shell(c, 'pages/login', { next: c.req.query('next') || '' }, 'Log in');
});

auth.post('/login', throttle(8), async (c) => {
  const b = c.get('body');
  const email = String(b.email || '').trim().toLowerCase();
  const back = (v) => shell(c, 'pages/login', { error: v, email, next: b.next || '' }, 'Log in');

  const recaptcha = await verifyRecaptcha(b['g-recaptcha-response']);
  if (!recaptcha.ok) return back(recaptcha.error);

  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Same message either way — don't confirm which emails exist. The reason is
  // logged server-side only, so "I can't log in" is diagnosable from app logs.
  if (!u || !(await verify(u.passwordHash, String(b.password || '')))) {
    console.warn(`[auth] login failed (${u ? 'bad password' : 'no such user'}): ${email}`);
    return back('That email and password combination did not match an account.');
  }
  if (u.status !== 'active') {
    console.warn(`[auth] login blocked (status=${u.status}): ${email}`);
    return back('This account is suspended. Contact support to restore access.');
  }

  await createSession(c, u.id);
  const next = String(b.next || '');
  // New logins land on the deposit page — the first thing a funded client
  // does is pay in and share a receipt. Admins go to their console.
  return c.redirect(next.startsWith('/') ? next : (u.role === 'admin' ? '/admin' : '/dashboard/deposit'));
});

auth.get('/register', (c) => {
  const u = c.get('user');
  if (u) return c.redirect(homeFor(u));
  return shell(c, 'pages/register', {}, 'Open an account');
});

auth.post('/register', throttle(6), async (c) => {
  const b = c.get('body');
  const f = {
    firstName: String(b.firstName || '').trim(),
    lastName: String(b.lastName || '').trim(),
    email: String(b.email || '').trim().toLowerCase(),
    country: String(b.country || '').trim(),
    phone: String(b.phone || '').trim(),
  };
  const back = (e) => shell(c, 'pages/register', { error: e, f }, 'Open an account');

  const recaptcha = await verifyRecaptcha(b['g-recaptcha-response']);
  if (!recaptcha.ok) return back(recaptcha.error);

  if (!f.firstName || !f.lastName) return back('Enter your first and last name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email)) return back('Enter a valid email address.');
  if (String(b.password || '').length < 10) return back('Use a password of at least 10 characters.');
  if (b.password !== b.confirm) return back('The two passwords do not match.');

  const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, f.email)).limit(1);
  if (dupe) return back('An account already exists for that email. Try logging in instead.');

  const [u] = await db.insert(users).values({
    ...f,
    passwordHash: await hash(String(b.password)),
    referralCode: crypto.randomBytes(4).toString('hex').toUpperCase(),
  }).returning();

  await db.insert(notifications).values({
    userId: u.id, kind: 'info',
    title: 'Welcome to the platform',
    body: 'Fund your account to start trading, or browse strategies while you decide.',
  });

  // Registration mail — logged to the outbox; sent if SMTP is configured.
  mailWelcome(u).catch((e) => console.error('[mail] welcome failed:', e.message));

  await createSession(c, u.id);
  return c.redirect('/dashboard/deposit');
});

auth.post('/logout', async (c) => { await destroySession(c); return c.redirect('/'); });
