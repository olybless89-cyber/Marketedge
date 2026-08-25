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

    await tx`insert into ledger (user_id, account, kind, amount, ref_type, memo)
      values (${userId}, ${bucket}, 'adjustment', ${String(sign * amount)}, 'admin_adjustment',
              ${`${direction === 'credit' ? 'Admin credit' : 'Admin debit'} — ${reason} (ref ${ref}, by ${admin.email})`})`;
    await tx`insert into audit_log (admin_id, user_id, action, category, amount, balance_before, balance_after, reason, reference, ip)
      values (${admin.id}, ${userId}, ${direction}, ${bucket}, ${String(amount)},
              ${String(before)}, ${String(after)}, ${reason}, ${ref}, ${ip})`;
    await tx`insert into notifications (user_id, kind, title, body)
      values (${userId}, 'info',
              ${direction === 'credit' ? 'Account credited' : 'Account debited'},
              ${`${direction === 'credit' ? '+' : '-'}$${amount.toFixed(2)} ${BUCKETS[bucket]} — ${reason}`})`;
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
      await tx`insert into ledger (user_id, account, kind, amount, ref_type, memo)
        values (${userId}, ${r.account}, 'adjustment', ${String(-bal)}, 'admin_clear',
                ${`Account cleared — ${reason} (ref ${ref}, by ${admin.email})`})`;
      await tx`insert into audit_log (admin_id, user_id, action, category, amount, balance_before, balance_after, reason, reference, ip)
        values (${admin.id}, ${userId}, 'clear_account', ${r.account}, ${String(bal)},
                ${String(bal)}, '0', ${reason}, ${ref}, ${ip})`;
    }
    await tx`insert into notifications (user_id, kind, title, body)
      values (${userId}, 'warn', 'Account cleared',
              ${'Your account balances were reset by support. Contact us if you have questions.'})`;
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
