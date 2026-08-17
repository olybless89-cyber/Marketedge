import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';

/* Receipt upload helper. Files land in the uploads directory and are served
   at /uploads/<name>. Only image/pdf types are accepted; size is capped.

   The on-disk location is configurable via UPLOAD_DIR so it can point at a
   persistent volume in production (Railway Volumes, an NFS mount, etc.).
   Defaults to public/uploads, which is served statically by the web layer.

   Hono's parseBody() yields Web File/Blob objects for multipart fields.
   We normalise to a Buffer, validate, and persist with an unguessable name. */

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), 'public', 'uploads');
const PUBLIC_PREFIX = '/uploads/';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf',
]);

const EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

/* Accept either a File (multipart) or a string (pasted link). Returns the
   public URL to store, or null when nothing usable was provided. Throws on
   a rejected file (bad type / too large) so the caller can 400 the user. */
export async function saveReceipt(file, { link } = {}) {
  // A pasted link takes precedence only when no file was attached.
  if (file && typeof file === 'object' && 'size' in file) {
    if (file.size === 0) file = null;
  } else if (file && typeof file !== 'object') {
    file = null;
  }

  if (!file) {
    const url = String(link || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) throw new Error('Receipt link must start with http:// or https://');
    return url;
  }

  const type = String(file.type || '').toLowerCase();
  if (!ALLOWED.has(type)) throw new Error('Receipt must be an image (PNG, JPEG, WebP, GIF) or PDF.');
  if (file.size > MAX_BYTES) throw new Error('Receipt file is larger than 5 MB.');

  await ensureUploadDir();
  const buf = Buffer.from(await file.arrayBuffer());
  const name = `${crypto.randomBytes(9).toString('hex')}.${EXT_BY_TYPE[type]}`;
  await writeFile(path.join(UPLOAD_DIR, name), buf);
  return PUBLIC_PREFIX + name;
}

/* Best-effort cleanup when a transaction that stored an uploaded receipt is
   later removed. Never throws — a dangling file is harmless. */
export async function removeReceipt(url) {
  if (!url || !url.startsWith(PUBLIC_PREFIX)) return;
  try { await rm(path.join(UPLOAD_DIR, url.slice(PUBLIC_PREFIX.length))); }
  catch { /* ignore */ }
}
