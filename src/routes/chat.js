/* Live chat — public JSON API for the widget. Admin pages mount in admin.js
   so they inherit that router's requireAdmin guard; client endpoints check
   channel ownership per request. */

import { Hono } from 'hono';
import { db } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { chatMessages } from '../db/schema.js';
import {
  clientChannel, validChannel, thread, postMessage, markRead,
  unreadForClient, firstClientLabel, notifyClientOfReply,
} from '../lib/chat.js';

export const chat = new Hono();

chat.get('/chat/messages', async (c) => {
  const ch = clientChannel(c);
  if (!ch) return c.json({ error: 'forbidden' }, 403);
  await markRead(ch.channel, false);
  const rows = await thread(ch.channel);
  return c.json({ messages: rows.map(mapMsg) });
});

chat.post('/chat/send', async (c) => {
  const ch = clientChannel(c);
  if (!ch) return c.json({ error: 'forbidden' }, 403);
  const b = c.get('body') || {};
  const u = c.get('user');
  const row = await postMessage({
    channel: ch.channel, sender: 'client', body: b.body,
    userId: ch.userId,
    guestName: u ? null : String(b.name || '').trim().slice(0, 80) || null,
    guestEmail: u ? null : String(b.email || '').trim().slice(0, 190) || null,
  });
  if (!row) return c.json({ error: 'empty message' }, 400);
  return c.json({ ok: true, id: row.id });
});

chat.get('/chat/unread', async (c) => {
  const ch = clientChannel(c);
  if (!ch) return c.json({ count: 0 });
  return c.json({ count: await unreadForClient(ch.channel) });
});

const mapMsg = (m) => ({ id: m.id, sender: m.sender, body: m.body, at: m.createdAt });

/* Admin handlers — wired into admin.js (NOT mounted here) so the admin
   router's requireAdmin guard applies. */
async function renderPage(c, openChannel) {
  const { render } = await import('../lib/view.js');
  const { adminInbox } = await import('../lib/chat.js');
  const inbox = await adminInbox();
  let rows = [], label = null;
  if (openChannel) {
    await markRead(openChannel, true);
    rows = await thread(openChannel, 200);
    label = await firstClientLabel(openChannel);
  }
  return render(c, 'admin/chat', { inbox, rows, openChannel, label, title: 'Live chat' });
}

export const chatAdminInbox = (c) => renderPage(c, null);
export const chatAdminThread = (c) => renderPage(c, c.req.param('channel'));

export async function chatAdminReply(c) {
  const channel = c.req.param('channel');
  if (!validChannel(channel)) return c.notFound();
  const b = c.get('body') || {};
  const row = await postMessage({ channel, sender: 'admin', body: b.body });
  if (!row) return c.redirect(`/admin/chat/${channel}?e=empty`);
  const [m] = await db.select({ userId: chatMessages.userId })
    .from(chatMessages).where(eq(chatMessages.channel, channel)).limit(1);
  if (m && m.userId)
    await notifyClientOfReply(channel, m.userId, String(b.body || ''));
  return c.redirect(`/admin/chat/${channel}`);
}
