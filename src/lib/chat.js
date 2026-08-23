/* Built-in live chat — no external provider. Clients (signed-in or guest)
   post from the floating widget; admins answer from the admin console.
   Poll-based (4 s), which is all the latency a support channel needs and
   keeps the single-process/no-redis architecture. */

import { eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import { db, sql } from '../db/client.js';
import { chatMessages, notifications, users } from '../db/schema.js';

export const GUEST_COOKIE = 'me_guest';
const CHANNEL_RE = /^[ug]:[A-Za-z0-9_-]{1,84}$/;

/* Resolves the caller's chat channel. Signed-in clients get the stable
   `u:<id>` channel; anonymous visitors get a rotating signed guest token
   cookie. Admins never become a channel — they answer on others' channels. */
export function clientChannel(c) {
  const u = c.get('user');
  if (u && u.role !== 'admin') return { channel: `u:${u.id}`, userId: u.id, label: null };
  if (u && u.role === 'admin') return null;
  let token = getCookie(c, GUEST_COOKIE);
  if (!token) {
    token = crypto.randomBytes(18).toString('hex');
    setCookie(c, GUEST_COOKIE, token, {
      httpOnly: false, sameSite: 'Lax', path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 365 * 86400,
    });
  }
  return { channel: `g:${token}`, userId: null, label: null };
}

/* Channel ownership is the only thing that separates client from admin:
   `u:x` belongs to user x; `g:<cookie value>` belongs to the cookie holder. */
export function ownsChannel(c, channel) {
  const u = c.get('user');
  if (u && u.role !== 'admin') return channel === `u:${u.id}`;
  if (u && u.role === 'admin') return false;
  return channel === `g:${getCookie(c, GUEST_COOKIE) || ''}`;
}

export async function unreadForClient(channel) {
  const [r] = await sql`select count(*)::int n from chat_messages
    where channel = ${channel} and sender = 'admin' and not read_by_client`;
  return r.n;
}

export async function adminInbox() {
  return sql`
    select c.channel,
           coalesce(u.first_name || ' ' || u.last_name, c.guest_name, 'Guest') as title,
           coalesce(u.email, c.guest_email, '') as email,
           coalesce((select count(x.id) from chat_messages x
             where x.channel = c.channel and x.sender = 'client' and not x.read_by_admin), 0)::int as unread,
           (select x.body from chat_messages x where x.channel = c.channel
             order by x.created_at desc limit 1) as last_body,
           (select x.created_at from chat_messages x where x.channel = c.channel
             order by x.created_at desc limit 1) as last_at
    from (
      select channel,
             max(case when user_id is not null then user_id end) as user_id,
             max(guest_name) as guest_name,
             max(guest_email) as guest_email
      from chat_messages group by channel
    ) c
    left join users u on u.id = c.user_id
    order by last_at desc
    limit 100`;
}

export async function thread(channel, limit = 100) {
  return db.select().from(chatMessages)
    .where(eq(chatMessages.channel, channel))
    .orderBy(chatMessages.createdAt).limit(limit);
}

export async function postMessage({ channel, sender, body, userId = null, guestName = null, guestEmail = null }) {
  body = String(body || '').trim().slice(0, 2000);
  if (!body) return null;
  const isClient = sender === 'client';
  const [row] = await db.insert(chatMessages).values({
    channel, userId, guestName, guestEmail, sender, body,
    readByAdmin: !isClient, readByClient: isClient,
  }).returning();
  return row;
}

export async function markRead(channel, byAdmin) {
  await db.update(chatMessages)
    .set(byAdmin ? { readByAdmin: true } : { readByClient: true })
    .where(and(
      eq(chatMessages.channel, channel),
      eq(chatMessages.sender, byAdmin ? 'client' : 'admin'),
    ));
}

export function validChannel(channel) {
  return typeof channel === 'string' && CHANNEL_RE.test(channel);
}

export async function notifyClientOfReply(channel, userId, preview) {
  if (!userId) return;  // guests read the widget; nothing to notify
  await db.insert(notifications).values({
    userId, kind: 'info',
    title: 'Support replied in live chat',
    body: preview.slice(0, 180),
  });
}

export async function firstClientLabel(channel) {
  const [m] = await db.select({ userId: chatMessages.userId, name: chatMessages.guestName, email: chatMessages.guestEmail })
    .from(chatMessages).where(eq(chatMessages.channel, channel)).limit(1);
  if (m && m.userId) {
    const [u] = await db.select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users).where(eq(users.id, m.userId)).limit(1);
    if (u) return { label: `${u.firstName} ${u.lastName}`, email: u.email || '' };
  }
  return { label: m?.name || 'Guest', email: m?.email || '' };
}