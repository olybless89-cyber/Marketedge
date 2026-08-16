/* Mail system. Two jobs: render an HTML body from a template, and deliver it.

   Design rules (matching the rest of the platform):
   - Every mail is written to mail_log regardless of delivery outcome. The
     outbox is the audit trail; SMTP success is a bonus, not a requirement.
   - SMTP is optional. With no SMTP_URL set the mail is still logged with
     status 'logged' so a demo on Railway works with zero external config.
   - Delivery never throws into the caller's flow. A failed send logs an
     error row and resolves, so registration/deposit flows are not blocked.

   Configuration:
     SMTP_URL        smtps://user:pass@smtp.example.com  (or smtp://host:port)
     MAIL_FROM       "Rydon Invest <no-reply@rydoninv.com>"
*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mailLog } from '../db/schema.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views');
const eta = new Eta({
  views: dir,
  cache: process.env.NODE_ENV === 'production',
  autoEscape: true,
  rmWhitespace: false,
});

const brand = () => ({
  name: process.env.BRAND_NAME || 'Rydon Invest',
  domain: process.env.BRAND_DOMAIN || 'rydoninv.com',
  year: new Date().getFullYear(),
  from: process.env.MAIL_FROM || `${process.env.BRAND_NAME || 'Rydon Invest'} <no-reply@${process.env.BRAND_DOMAIN || 'rydoninv.com'}>`,
  base: process.env.BRAND_URL || `https://${process.env.BRAND_DOMAIN || 'rydoninv.com'}`,
});

/* ---- Lazy SMTP transporter. Created once on first use. ---- */
let transporter = null;

function getTransporter() {
  if (transporter !== null) return transporter;
  const url = process.env.SMTP_URL;
  if (!url) { transporter = false; return false; }
  try {
    transporter = nodemailer.createTransport(url);
  } catch (e) {
    console.error('[mail] SMTP transporter init failed, log-only mode:', e.message);
    transporter = false;
  }
  return transporter;
}

/* Warm the transporter early so the first mail isn't delayed by connection
   setup. Safe to call when SMTP is unconfigured. */
export async function warmTransporter() {
  getTransporter();
  if (transporter && typeof transporter.verify === 'function') {
    transporter.verify().catch((e) => console.warn('[mail] SMTP verify failed:', e.message));
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
  const tx = getTransporter();
  if (!tx) return { id: row.id, status: 'logged' };

  try {
    const info = await tx.sendMail({ from: b.from, to, subject, html: bodyHtml });
    await db.update(mailLog).set({ status: 'sent' }).where(eq(mailLog.id, row.id));
    return { id: row.id, status: 'sent', messageId: info.messageId };
  } catch (e) {
    await db.update(mailLog).set({ status: 'failed', error: String(e.message || e).slice(0, 500) }).where(eq(mailLog.id, row.id));
    console.error('[mail] send failed:', subject, '->', to, e.message);
    return { id: row.id, status: 'failed' };
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
