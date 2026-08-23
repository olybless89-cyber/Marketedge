import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings as settingsT, paymentMethods } from '../db/schema.js';

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

/* People often paste the whole `<script>..._smartsupp.key = '...'...</script>`
   snippet instead of just the hex key. Normalize on every read so the widget
   works even after a botched paste; also un-escapes HTML entities. */
function normalizeSmartsuppKey(raw) {
  let v = String(raw || '')
    .replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const snippet = v.match(/_smartsupp\.key\s*=\s*['"]([a-f0-9]{32,})['"]/i);
  if (snippet) return snippet[1].toLowerCase();
  if (/^[a-f0-9]{32,}$/i.test(v.trim())) return v.trim().toLowerCase();
  return v.trim();
}

/* Cached read for the per-request middleware. Falls back to defaults when
   the settings table isn't readable yet (first boot before migration). */
export async function getSiteConfig() {
  const now = Date.now();
  if (siteCache.value && now - siteCache.at < SITE_TTL_MS) return siteCache.value;
  let stored = null;
  try { stored = await getSetting('site_config', null); }
  catch { /* table may not exist yet — defaults are fine */ }
  const merged = { ...DEFAULT_SITE, ...(stored || {}) };
  merged.smartsuppKey = normalizeSmartsuppKey(merged.smartsuppKey);
  siteCache = { value: merged, at: now };
  return siteCache.value;
}

export async function setSiteConfig(partial) {
  const prev = await getSiteConfig();
  const next = {
    supportEmail: String(partial.supportEmail ?? prev.supportEmail).trim() || DEFAULT_SITE.supportEmail,
    smartsuppKey: normalizeSmartsuppKey(partial.smartsuppKey ?? prev.smartsuppKey),
  };
  await setSetting('site_config', next);
  siteCache = { value: next, at: Date.now() };
  return next;
}

/* Payment methods — admin-managed list used by deposit and withdrawal
   forms. Slug is derived from the name, stable across renames of the
   display label only when edited via slug field indirectly (name change
   keeps original transactions readable because method is just a slug). */
export async function listPaymentMethods(onlyEnabled = false) {
  const rows = await db.select().from(paymentMethods).orderBy(paymentMethods.sortOrder, paymentMethods.id);
  return onlyEnabled ? rows.filter((r) => r.enabled) : rows;
}

export async function seedDefaultPaymentMethods() {
  const existing = await db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
  if (existing.length) return false;
  const defaults = [
    { slug: 'usdt_trc20', name: 'USDT — TRC20', instructions: '', sortOrder: 0 },
    { slug: 'btc',        name: 'Bitcoin',      instructions: '', sortOrder: 1 },
    { slug: 'eth',        name: 'Ethereum — ERC20', instructions: '', sortOrder: 2 },
    { slug: 'bank',       name: 'Bank transfer', instructions: '', sortOrder: 3 },
  ];
  await db.insert(paymentMethods).values(defaults);
  // Carry over any wallet addresses saved under the old fixed scheme.
  try {
    const wallets = await getWallets();
    for (const d of defaults) {
      const addr = String(wallets[d.slug] || '').trim();
      if (addr) await db.update(paymentMethods).set({ instructions: addr }).where(eq(paymentMethods.slug, d.slug));
    }
  } catch { /* old keys may not exist — fine */ }
  return true;
}

export function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'method';
}

export async function addPaymentMethod({ name, instructions = '' }) {
  const base = slugify(name);
  let slug = base;
  const taken = new Set((await db.select({ slug: paymentMethods.slug }).from(paymentMethods)).map((r) => r.slug));
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  const [{ max = -1 }] = await db.select({ max: paymentMethods.id }).from(paymentMethods).catch(() => [{ max: -1 }]);
  const all = await listPaymentMethods();
  const sortOrder = all.length ? Math.max(...all.map((m) => m.sortOrder)) + 1 : 0;
  return db.insert(paymentMethods).values({ slug, name: String(name).trim(), instructions: String(instructions).trim(), sortOrder }).returning();
}

export async function updatePaymentMethod(id, { name, instructions, enabled }) {
  await db.update(paymentMethods).set({
    name: String(name).trim(),
    instructions: String(instructions ?? '').trim(),
    enabled: !!enabled && enabled !== 'off',
  }).where(eq(paymentMethods.id, Number(id)));
}

export async function deletePaymentMethod(id) {
  await db.delete(paymentMethods).where(eq(paymentMethods.id, Number(id)));
}
