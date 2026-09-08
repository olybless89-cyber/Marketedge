/* Mail system. Two jobs: render an HTML body from a template, and deliver it.

   Design rules (matching the rest of the platform):
   - Every mail is written to mail_log regardless of delivery outcome. The
     outbox is the audit trail; SMTP success is a bonus, not a requirement.
   - SMTP is optional. With nothing configured the mail is still logged with
     status 'logged' so a demo works with zero external config.
   - Delivery never throws into the caller's flow. A failed send logs an
     error row and resolves, so registration/deposit flows are not blocked.

   Configuration (in priority order):
     1. Admin "Mail settings" page  → stored in settings table under
        key `mail_config` as jsonb. See getMailConfig()/setMailConfig().
     2. SMTP_URL env var  smtps://user:pass@smtp.example.com  (or smtp://host:port)
     3. (neither) → log-only mode.

   Gmail setup:
     smtp.gmail.com : 465 (SSL, secure=true) using your Gmail address as the
     user and a 16-character App Password (not your account password) as the
     pass. Generate one at https://myaccount.google.com/apppasswords after
     enabling 2-Step Verification.
*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mailLog } from '../db/schema.js';
import { getSetting, setSetting, getSiteConfig } from './settings.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
const eta = new Eta({
  views: dir,
  cache: process.env.NODE_ENV === 'production',
  autoEscape: true,
  rmWhitespace: false,
});

const brand = () => ({
  name: process.env.BRAND_NAME || 'Marketedge',
  domain: process.env.BRAND_DOMAIN || 'marketedge.com',
  year: new Date().getFullYear(),
  base: process.env.BRAND_URL || `https://${process.env.BRAND_DOMAIN || 'marketedge.com'}`,
});

/* ---- Mail config stored in the settings table ----
   { host, port, secure, user, pass, fromName, fromAddress }
   `pass` is sensitive: getMailConfig returns it verbatim (admin-only),
   but views mask it via hasPassword. */
const GMAIL_PRESET = {
  host: 'smtp.gmail.com', port: 465, secure: true,
  user: 'marketedgesupport@gmail.com', pass: '',
  fromName: 'Marketedge Support', fromAddress: 'marketedgesupport@gmail.com',
};

export async function getMailConfig() {
  const stored = await getSetting('mail_config', null);
  if (!stored) return null;
  return { ...GMAIL_PRESET, ...stored };
}

/* Merge a partial submission onto the stored config. An empty `pass`
   means "keep the existing password" so the UI never has to reveal it.
   `provider: 'builtin'` selects the platform's own web-mail system (mails
   recorded in the outbox, no external SMTP); 'smtp' uses the host below. */
export async function setMailConfig(partial) {
  const prev = (await getMailConfig()) || { ...GMAIL_PRESET };
  const provider = partial.provider
    ? (partial.provider === 'smtp' ? 'smtp' : 'builtin')
    : (prev.provider || (prev.host ? 'smtp' : 'builtin'));
  const next = {
    provider,
    host: provider === 'builtin' ? '' : String(partial.host || prev.host || GMAIL_PRESET.host).trim(),
    port: Number(partial.port) || prev.port || GMAIL_PRESET.port,
    secure: partial.secure === undefined ? prev.secure : !!partial.secure,
    user: String(partial.user ?? prev.user ?? '').trim(),
    pass: (partial.pass === undefined || partial.pass === '')
      ? (prev.pass || '')
      : String(partial.pass),
    fromName: String(partial.fromName || prev.fromName || 'Marketedge').trim(),
    fromAddress: String(partial.fromAddress || prev.fromAddress || '').trim(),
  };
  await setSetting('mail_config', next);
  refreshTransporter();
  return next;
}

/* The "from" header: config's fromName/fromAddress beat env MAIL_FROM. */
async function fromHeader() {
  const cfg = await getMailConfig();
  if (cfg && cfg.fromAddress) {
    const name = cfg.fromName || brand().name;
    return `${name} <${cfg.fromAddress}>`;
  }
  return process.env.MAIL_FROM ||
    `${brand().name} <no-reply@${brand().domain}>`;
}

/* ---- Lazy SMTP transporter. Created once on first use. ---- */
let transporter = null;

function buildFromConfig(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: !!cfg.secure,
    auth: cfg.user || cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/* Reads config (DB → env → none) on first use, then caches. Call
   refreshTransporter() after a config change to force a rebuild. */
async function getTransporter() {
  if (transporter !== null) return transporter;
  const cfg = await getMailConfig();
  // Built-in web mail: no external provider — everything is recorded in the
  // outbox (and mirrored to in-app notifications) instead of leaving the box.
  if (cfg && cfg.provider === 'builtin') { transporter = false; return transporter; }
  if (cfg && cfg.host) {
    try { transporter = buildFromConfig(cfg); }
    catch (e) {
      console.error('[mail] SMTP transporter init failed, log-only mode:', e.message);
      transporter = false;
    }
    return transporter;
  }
  const url = process.env.SMTP_URL;
  if (url) {
    try { transporter = nodemailer.createTransport(url); }
    catch (e) {
      console.error('[mail] SMTP transporter init failed, log-only mode:', e.message);
      transporter = false;
    }
    return transporter;
  }
  transporter = false;
  return transporter;
}

export function refreshTransporter() { transporter = null; }

/* Auto-setup: if no mail_config exists in the DB yet, build one from env
   (SMTP_HOST or SMTP_URL) so the system works with zero admin UI visits.
   Runs once per boot after migration. Admin UI saves always win because
   this only fills the gap left by "nothing configured". */
export async function autoSetupMail() {
  const existing = await getMailConfig();
  if (existing && (existing.host || existing.provider)) return;  // admin UI or prior env already won

  // Preferred: discrete vars.
  const host = process.env.SMTP_HOST;
  if (host) {
    await setMailConfig({
      provider: 'smtp',
      host,
      port: process.env.SMTP_PORT || 465,
      secure: process.env.SMTP_SECURE !== 'false',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      fromName: process.env.MAIL_FROM_NAME || 'Marketedge Support',
      fromAddress: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    });
    console.log('[mail] auto-configured from SMTP_HOST env');
    return;
  }

  // Fallback: a single SMTP_URL (common on managed providers).
  const url = process.env.SMTP_URL;
  if (url) {
    try {
      const u = new URL(url);
      await setMailConfig({
        provider: 'smtp',
        host: u.hostname,
        port: u.port || (u.protocol === 'smtps:' ? 465 : 587),
        secure: u.protocol === 'smtps:',
        user: decodeURIComponent(u.username || ''),
        pass: decodeURIComponent(u.password || ''),
        fromName: process.env.MAIL_FROM_NAME || 'Marketedge Support',
        fromAddress: process.env.SMTP_FROM || decodeURIComponent(u.username || ''),
      });
      console.log('[mail] auto-configured from SMTP_URL env');
    } catch (e) {
      console.error('[mail] SMTP_URL parse failed:', e.message);
    }
    return;
  }

  // Default: the platform's built-in web mail — no external provider. Mails
  // are recorded in the admin outbox and users are notified in-app.
  await setMailConfig({
    provider: 'builtin',
    host: '',
    fromName: process.env.MAIL_FROM_NAME || 'Marketedge Support',
    fromAddress: process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || GMAIL_PRESET.fromAddress,
  });
  console.log('[mail] built-in web mail active (no external provider)');
}

/* Warm the transporter early so the first mail isn't delayed by connection
   setup. Safe to call when SMTP is unconfigured. */
export async function warmTransporter() {
  const tx = await getTransporter();
  if (tx && typeof tx.verify === 'function') {
    tx.verify().catch((e) => console.warn('[mail] SMTP verify failed:', e.message));
  }
}

/**
 * Send a mail. Always resolves (never throws).
 * @param {object} opts
 * @param {number|null} opts.userId
 * @param {string} opts.to
 * @param {string} opts.template  e.g. 'mail/welcome'
 * @param {string} opts.subject
 * @param {object} opts.data      template variables
 * @param {string} [opts.refType]
 * @param {number} [opts.refId]
 * @returns {Promise<{id:number, status:string}>}
 */
export async function sendMail({ userId = null, to, template, subject, data = {}, refType, refId }) {
  const b = brand();
  let innerHtml;
  try {
    innerHtml = eta.render(template, { ...b, ...data });
  } catch (e) {
    console.error('[mail] template render failed:', template, e.message);
    innerHtml = `<h1 style="margin:0 0 8px">${subject}</h1>`;
  }

  let bodyHtml;
  try {
    bodyHtml = eta.render('mail/layout', { ...b, ...data, to, subject, body: innerHtml });
  } catch (e) {
    console.error('[mail] layout render failed:', e.message);
    bodyHtml = innerHtml;
  }

  const [row] = await db.insert(mailLog).values({
    userId, toEmail: to, template, subject, bodyHtml,
    status: 'logged', refType, refId,
  }).returning({ id: mailLog.id });

  // Attempt real delivery only if a transporter is configured and ready.
  const tx = await getTransporter();
  if (!tx) return { id: row.id, status: 'logged' };

  try {
    const info = await tx.sendMail({ from: await fromHeader(), to, subject, html: bodyHtml });
    await db.update(mailLog).set({ status: 'sent' }).where(eq(mailLog.id, row.id));
    return { id: row.id, status: 'sent', messageId: info.messageId };
  } catch (e) {
    await db.update(mailLog).set({ status: 'failed', error: String(e.message || e).slice(0, 500) }).where(eq(mailLog.id, row.id));
    console.error('[mail] send failed:', subject, '->', to, e.message);
    return { id: row.id, status: 'failed' };
  }
}

/* ---- Test mail. Used by the admin settings page to confirm SMTP works. ---- */
export async function sendTestMail(to) {
  const b = brand();
  const bodyHtml = eta.render('mail/layout', {
    ...b, to, subject: 'Marketedge test email',
    body: `<div style="padding:8px 0"><h2 style="margin:0 0 8px">It works! ✅</h2>
      <p style="margin:0">This confirms your mail settings are correct. Transactional
      emails from ${b.name} will now be delivered from this address.</p></div>`,
  });
  const [row] = await db.insert(mailLog).values({
    toEmail: to, template: 'mail/test', subject: 'Marketedge test email',
    bodyHtml, status: 'logged',
  }).returning({ id: mailLog.id });

  const cfg = await getMailConfig();
  const tx = await getTransporter();
  if (!tx) {
    if (cfg && cfg.provider === 'builtin') {
      // Built-in web mail: being recorded in the outbox IS the delivery.
      return { id: row.id, status: 'logged',
        error: 'Built-in web mail is active — the message is recorded in the outbox (no external delivery, by design).' };
    }
    await db.update(mailLog).set({ status: 'failed', error: 'SMTP is not configured.' }).where(eq(mailLog.id, row.id));
    return { id: row.id, status: 'failed', error: 'SMTP is not configured. Fill in the form below first.' };
  }
  try {
    const info = await tx.sendMail({ from: await fromHeader(), to, subject: 'Marketedge test email', html: bodyHtml });
    await db.update(mailLog).set({ status: 'sent' }).where(eq(mailLog.id, row.id));
    return { id: row.id, status: 'sent', messageId: info.messageId };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await db.update(mailLog).set({ status: 'failed', error: msg }).where(eq(mailLog.id, row.id));
    return { id: row.id, status: 'failed', error: msg };
  }
}

/* ---- Typed helpers. Keep the call sites in routes one-liners. ---- */

export const mailWelcome = (u) => sendMail({
  userId: u.id, to: u.email, template: 'mail/welcome',
  subject: `Welcome to ${brand().name}`,
  data: { firstName: u.firstName },
});

export const mailDepositConfirmed = (u, t) => sendMail({
  userId: u.id, to: u.email, template: 'mail/deposit',
  subject: 'Deposit confirmed',
  data: { firstName: u.firstName, amount: Number(t.amount), method: t.method },
  refType: 'transaction', refId: t.id,
});

export const mailWithdrawalSent = (u, t) => sendMail({
  userId: u.id, to: u.email, template: 'mail/withdrawal',
  subject: 'Withdrawal sent',
  data: { firstName: u.firstName, amount: Number(t.amount), method: t.method, address: t.address },
  refType: 'transaction', refId: t.id,
});

export const mailWithdrawalDeclined = (u, t, note) => sendMail({
  userId: u.id, to: u.email, template: 'mail/withdrawal-declined',
  subject: 'Withdrawal declined',
  data: { firstName: u.firstName, amount: Number(t.amount), note: note || '' },
  refType: 'transaction', refId: t.id,
});

export const mailDepositDeclined = (u, t, note) => sendMail({
  userId: u.id, to: u.email, template: 'mail/deposit-declined',
  subject: 'Deposit declined',
  data: { firstName: u.firstName, amount: Number(t.amount), note: note || '' },
  refType: 'transaction', refId: t.id,
});

export const mailPlanActivated = (u, planName, amount, maturesAt) => sendMail({
  userId: u.id, to: u.email, template: 'mail/plan-activated',
  subject: `Plan activated — ${planName}`,
  data: { firstName: u.firstName, planName, amount: Number(amount), maturesAt },
  refType: 'investment',
});

export const mailPlanClosed = (u, planName, principal, accrued) => sendMail({
  userId: u.id, to: u.email, template: 'mail/plan-closed',
  subject: `Plan matured — ${planName}`,
  data: { firstName: u.firstName, planName, principal: Number(principal), accrued: Number(accrued) },
  refType: 'investment',
});

export const mailKycApproved = (u) => sendMail({
  userId: u.id, to: u.email, template: 'mail/kyc-approved',
  subject: 'Identity verified',
  data: { firstName: u.firstName },
});

export const mailKycRejected = (u, note) => sendMail({
  userId: u.id, to: u.email, template: 'mail/kyc-rejected',
  subject: 'Identity review — action needed',
  data: { firstName: u.firstName, note: note || '' },
});

export const mailDepositReceived = (u, t) => sendMail({
  userId: u.id, to: u.email, template: 'mail/deposit-received',
  subject: 'Deposit received — under review',
  data: { firstName: u.firstName, amount: Number(t.amount), method: t.method },
  refType: 'transaction', refId: t.id,
});

export const mailWithdrawalRequested = (u, t) => sendMail({
  userId: u.id, to: u.email, template: 'mail/withdrawal-received',
  subject: 'Withdrawal request received',
  data: { firstName: u.firstName, amount: Number(t.amount), method: t.method, address: t.address },
  refType: 'transaction', refId: t.id,
});

/* Contact form → support inbox. `to` is the configured support address,
   not the visitor. */
export const mailContactMessage = async ({ name, email, message }) => {
  const site = await getSiteConfig();
  return sendMail({
    to: site.supportEmail, template: 'mail/contact',
    subject: `Contact form — ${name}`,
    data: { name, email, message: String(message).slice(0, 4000) },
  });
};

/* Admin-composed mail. Message is plain text; split into escaped paragraphs
   here so the template can emit them raw. */
const escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const mailAdminMessage = (u, subject, message) => sendMail({
  userId: u?.id ?? null, to: u.email, template: 'mail/message',
  subject,
  data: {
    subject,
    firstName: u?.firstName || 'there',
    paragraphs: String(message).split(/\n\s*\n/)
      .map((p) => escHtml(p).replace(/\n/g, '<br>')),
  },
});

/* Admin manually ended an active investment before maturity — distinct from
   mailPlanClosed (which is the plan reaching its own maturity date). */
export const mailPlanEnded = (u, planName, principal, accrued) => sendMail({
  userId: u.id, to: u.email, template: 'mail/plan-ended',
  subject: `Investment plan ended — ${planName}`,
  data: { firstName: u.firstName, planName, principal: Number(principal), accrued: Number(accrued) },
  refType: 'investment',
});

/* Re-send a previously logged mail (used by the admin "Retry" action on a
   failed row in the mail outbox). Re-uses the exact bodyHtml/subject that
   were already rendered and stored — no template re-render, so it sends
   what was actually generated the first time. */
export async function retryMail(logId) {
  const [row] = await db.select().from(mailLog).where(eq(mailLog.id, logId)).limit(1);
  if (!row) throw new Error('Mail log entry not found');

  const tx = await getTransporter();
  if (!tx) {
    await db.update(mailLog).set({ status: 'failed', error: 'SMTP is not configured.' }).where(eq(mailLog.id, logId));
    return { id: logId, status: 'failed', error: 'SMTP is not configured.' };
  }
  try {
    await tx.sendMail({ from: await fromHeader(), to: row.toEmail, subject: row.subject, html: row.bodyHtml });
    await db.update(mailLog).set({ status: 'sent', error: null }).where(eq(mailLog.id, logId));
    return { id: logId, status: 'sent' };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await db.update(mailLog).set({ status: 'failed', error: msg }).where(eq(mailLog.id, logId));
    return { id: logId, status: 'failed', error: msg };
  }
}
