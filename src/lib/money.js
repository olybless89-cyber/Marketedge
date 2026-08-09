/* Money helpers. Formatting only — arithmetic that touches balances
   happens in SQL (numeric) so it never round-trips through a float. */
export const usd = (v, dp = 2) =>
  Number(v || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: dp, maximumFractionDigits: dp });
export const signedUsd = (v, dp = 2) => (Number(v || 0) >= 0 ? '+' : '') + usd(v, dp);
export const pct = (v, dp = 2) => `${Number(v || 0) >= 0 ? '+' : ''}${Number(v || 0).toFixed(dp)}%`;
export const dir = (v) => (Number(v || 0) > 0 ? 'up' : Number(v || 0) < 0 ? 'down' : '');
export const num = (v, dp = 2) =>
  Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const compact = (v) => Number(v || 0).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const initials = (a = '', b = '') => ((a[0] || '') + (b[0] || '')).toUpperCase() || '?';
export const ago = (d) => {
  if (!d) return '—';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24); if (dd < 30) return `${dd}d ago`;
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const dt = (d) => d
  ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
