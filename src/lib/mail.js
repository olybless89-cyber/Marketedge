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
import { getSetting, setSetting } from './settings.js';

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
  user: '', pass: '',
  fromName: 'Marketedge', fromAddress: '',
};

export async function getMailConfig() {
  const stored = await getSetting('mail_config', null);
  if (!stored) return null;
  return { ...GMAIL_PRESET, ...stored };
}

/* Merge a partial submission onto the stored config. An empty `pass`
   means "keep the existing password" so the UI never has to reveal it. */
export async function setMailConfig(partial) {
  const prev = (await getMailConfig()) || { ...GMAIL_PRESET };
  const next = {
    host: String(partial.host || prev.host || GMAIL_PRESET.host).trim(),
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

  const tx = await getTransporter();
  if (!tx) {
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
