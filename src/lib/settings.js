import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings as settingsT } from '../db/schema.js';

/* Key-value store backed by the `settings` table. Each value is a jsonb
   column, so structured values (objects, arrays) survive a round trip
   without serialization on the caller's side. */

export async function getSetting(key, fallback = null) {
  const [row] = await db.select().from(settingsT).where(eq(settingsT.key, key)).limit(1);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.insert(settingsT).values({ key, value })
    .onConflictDoUpdate({ target: settingsT.key, set: { value } });
  return value;
}

/* Wallet addresses are stored as one object keyed by payment method:
     { usdt_trc20: 'TQn9...', btc: 'bc1q...', eth: '0x...', bank: 'IBAN...' }
   The deposit view reads this to show the user where to send funds. */
const DEFAULT_WALLETS = {
  usdt_trc20: '',
  btc: '',
  eth: '',
  bank: '',
};

export async function getWallets() {
  const stored = await getSetting('wallet_addresses', {});
  return { ...DEFAULT_WALLETS, ...stored };
}

export async function setWallets(obj) {
  const clean = { ...DEFAULT_WALLETS };
  for (const k of Object.keys(DEFAULT_WALLETS)) {
    if (typeof obj[k] === 'string') clean[k] = obj[k].trim();
  }
  await setSetting('wallet_addresses', clean);
  return clean;
}
