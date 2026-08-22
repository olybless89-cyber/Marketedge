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

/* Site-wide knobs editable from the admin UI (System → Site settings):
   supportEmail — inbox for contact-form mail; shown to users as the
     support address. Defaults to SUPPORT_EMAIL env, else the shared Gmail.
   smartsuppKey — Smartsupp live-chat widget key; blank disables the widget.
     Defaults to SMARTSUPP_KEY env, else the legacy hardcoded key. */
const DEFAULT_SITE = {
  supportEmail: process.env.SUPPORT_EMAIL || 'marketedgesupport@gmail.com',
  smartsuppKey: process.env.SMARTSUPP_KEY || '4274d05b1ff81bb5c726ea48b1364f81eb785401',
};

let siteCache = { value: null, at: 0 };
const SITE_TTL_MS = 15_000;

/* Cached read for the per-request middleware. Falls back to defaults when
   the settings table isn't readable yet (first boot before migration). */
export async function getSiteConfig() {
  const now = Date.now();
  if (siteCache.value && now - siteCache.at < SITE_TTL_MS) return siteCache.value;
  let stored = null;
  try { stored = await getSetting('site_config', null); }
  catch { /* table may not exist yet — defaults are fine */ }
  siteCache = { value: { ...DEFAULT_SITE, ...(stored || {}) }, at: now };
  return siteCache.value;
}

export async function setSiteConfig(partial) {
  const prev = await getSiteConfig();
  const next = {
    supportEmail: String(partial.supportEmail ?? prev.supportEmail).trim() || DEFAULT_SITE.supportEmail,
    smartsuppKey: String(partial.smartsuppKey ?? prev.smartsuppKey).trim(),
  };
  await setSetting('site_config', next);
  siteCache = { value: next, at: Date.now() };
  return next;
}
