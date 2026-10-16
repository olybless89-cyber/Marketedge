/* Admin financial operations — credit/debit, audit trail, withdrawal codes.
   All balance math happens in SQL numeric inside a transaction; a debit that
   would drive a bucket negative rolls back, so the ledger and the audit row
   always commit together or not at all. */

import crypto from 'node:crypto';
import { db, sql } from '../db/client.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hash } from './auth.js';

export const BUCKETS = {
  main: 'Account Balance',
  profit: 'Profit',
  bonus: 'Bonus',
  ref_bonus: 'Referral Bonus',
  deposit: 'Deposit',
};

const sumInTx = (tx, userId, account) =>
  tx`select coalesce(sum(amount),0)::text s from ledger where user_id = ${userId} and account = ${account}`;

/* Credit or debit one ledger bucket. Returns { before, after, ref }.
   Throws Error with a user-safe message on validation/insufficient funds. */
export async function creditDebit({ admin, userId, bucket, direction, amount, reason, ip }) {
  if (!BUCKETS[bucket]) throw new Error('Unknown account category.');
  amount = Math.round(Number(amount) * 1e8) / 1e8;
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  const sign = direction === 'credit' ? 1 : direction === 'debit' ? -1 : 0;
  if (!sign) throw new Error('Choose credit or debit.');
  const ref = 'cd-' + crypto.randomBytes(6).toString('hex');

  return sql.begin(async (tx) => {
    const [b] = await sumInTx(tx, userId, bucket);
    const before = Number(b.s);
    if (sign < 0 && amount > before)
      throw new Error(`Debit exceeds the current ${BUCKETS[bucket].toLowerCase()} (${before.toFixed(2)} available).`);
    const after = before + sign * amount;

    // Ledger memo is user-facing (shown verbatim in the statement/activity
    // table's REFERENCE column) — it must never read as an admin action.
    // The full picture (who, when, ref, before/after) still lands in
    // audit_log, which only admins ever see.
    await tx`insert into ledger (user_id, account, kind, amount, ref_type, memo)
      values (${userId}, ${bucket}, 'adjustment', ${String(sign * amount)}, 'admin_adjustment',
              ${reason || 'Balance adjustment'})`;
    await tx`insert into audit_log (admin_id, user_id, action, category, amount, balance_before, balance_after, reason, reference, ip)
      values (${admin.id}, ${userId}, ${direction}, ${bucket}, ${String(amount)},
              ${String(before)}, ${String(after)}, ${reason}, ${ref}, ${ip})`;
    // No user notification for admin credit/debit — these should be silent.
    return { before, after, ref };
  });
}

/* Clear every bucket to zero. Balances become zero via compensating ledger
   lines — the history itself is never deleted, so the account stays
   auditable. */
export async function clearAccount({ admin, userId, reason, ip }) {
  const ref = 'clr-' + crypto.randomBytes(6).toString('hex');
  return sql.begin(async (tx) => {
    const rows = await tx`select account, coalesce(sum(amount),0)::text s
      from ledger where user_id = ${userId} group by account having sum(amount) <> 0`;
    for (const r of rows) {
      const bal = Number(r.s);
      // See the comment in creditDebit(): the ledger memo is user-facing
      // and must not read as an admin action. audit_log keeps the full
      // record (admin, reason, ref) for admin eyes only.
      await tx`insert into ledger (user_id, account, kind, amount, ref_type, memo)
        values (${userId}, ${r.account}, 'adjustment', ${String(-bal)}, 'admin_clear',
                ${reason || 'Balance adjustment'})`;
      await tx`insert into audit_log (admin_id, user_id, action, category, amount, balance_before, balance_after, reason, reference, ip)
        values (${admin.id}, ${userId}, 'clear_account', ${r.account}, ${String(bal)},
                ${String(bal)}, '0', ${reason}, ${ref}, ${ip})`;
    }
    // No user notification for admin clear-account — silent like credit/debit.
    return { cleared: rows.length, ref };
  });
}

/* Withdrawal code: admin sets a plain code once (shown once, never stored);
   users verify against the hash at withdrawal time. */
export async function setWithdrawalCode(userId, code) {
  await db.update(users).set({ withdrawalCodeHash: await hash(String(code)) })
    .where(eq(users.id, userId));
}
export async function clearWithdrawalCode(userId) {
  await db.update(users).set({ withdrawalCodeHash: null }).where(eq(users.id, userId));
}

/* Admin manually records a deposit or withdrawal for a user — e.g. a bank
   wire or cash payment handled outside the site. Creates a real row in
   `transactions` (so it shows in the client's deposit/withdrawal history,
   exactly like a client-submitted one) rather than a silent ledger tweak.
     - approved deposit   -> ledger credited immediately
     - approved withdrawal -> ledger debited immediately (funds already left)
     - pending withdrawal  -> funds held, same as a client-submitted request,
                               so it can be approved/rejected later from the
                               normal deposits/withdrawals queue
     - pending deposit     -> no ledger entry yet, same as a client submission;
                               posts to the ledger once approved
   Returns the inserted transaction row. Throws Error with a user-safe
   message on validation failure. */
export async function addManualTransaction({
  admin, userId, type, method, methodName, amount, status, note, ip,
}) {
  if (!['deposit', 'withdrawal'].includes(type)) throw new Error('Choose deposit or withdrawal.');
  if (!['approved', 'pending'].includes(status)) throw new Error('Choose a status.');
  amount = Math.round(Number(amount) * 1e8) / 1e8;
  if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
  method = String(method || '').trim().slice(0, 40) || 'manual';
  methodName = String(methodName || '').trim().slice(0, 80) || 'Manual entry';
  note = String(note || '').trim().slice(0, 300);

  const reviewedAt = status === 'approved' ? new Date() : null;

  return sql.begin(async (tx) => {
    const [t] = await tx`insert into transactions
        (user_id, type, method, method_name, amount, net_amount, currency, status,
         admin_note, reviewed_by, reviewed_at)
      values (${userId}, ${type}, ${method}, ${methodName}, ${String(amount)}, ${String(amount)}, 'USD',
              ${status}, ${note || null}, ${admin.id}, ${reviewedAt})
      returning *`;

    if (type === 'deposit' && status === 'approved') {
      await tx`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo)
        values (${userId}, 'main', 'deposit', ${String(amount)}, 'transaction', ${t.id},
                ${'Deposit via ' + methodName})`;
    } else if (type === 'withdrawal' && status === 'approved') {
      await tx`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo)
        values (${userId}, 'main', 'withdrawal', ${String(-amount)}, 'transaction', ${t.id},
                ${'Withdrawal via ' + methodName})`;
    } else if (type === 'withdrawal' && status === 'pending') {
      await tx`insert into ledger (user_id, account, kind, amount, ref_type, ref_id, memo)
        values (${userId}, 'main', 'withdrawal_hold', ${String(-amount)}, 'withdrawal', ${t.id},
                ${'Held pending withdrawal review (' + methodName + ')'})`;
    }

    await tx`insert into audit_log (admin_id, user_id, action, category, amount, reason, reference, ip)
      values (${admin.id}, ${userId}, ${'admin_' + type + '_add'}, ${method}, ${String(amount)},
              ${note || null}, ${'tx-' + t.id}, ${ip})`;

    return t;
  });
}
