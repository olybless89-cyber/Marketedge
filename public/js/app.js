/* Small, dependency-free. HTMX does the fetching; this handles polish. */

// Live clock in the hero chart bar
const clock = document.getElementById('clock');
if (clock) {
  const tick = () => { clock.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false }); };
  tick(); setInterval(tick, 1000);
}

// Flash a cell green/red when its value changes after an HTMX swap.
document.body.addEventListener('htmx:beforeSwap', (e) => {
  const t = e.detail.target;
  t.querySelectorAll?.('[data-watch]').forEach((el) => {
    el.dataset.prev = el.textContent.trim();
  });
});
document.body.addEventListener('htmx:afterSwap', (e) => {
  e.detail.target.querySelectorAll?.('[data-watch]').forEach((el) => {
    const prev = parseFloat((el.dataset.prev || '').replace(/[^0-9.-]/g, ''));
    const now = parseFloat(el.textContent.replace(/[^0-9.-]/g, ''));
    if (!isNaN(prev) && !isNaN(now) && prev !== now) {
      el.classList.add(now > prev ? 'flash-up' : 'flash-down');
      setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 700);
    }
  });
});

// Sidebar on mobile
const side = document.querySelector('.side');
document.querySelector('[data-side-toggle]')?.addEventListener('click', () => {
  side.classList.add('open');
  const s = document.createElement('div');
  s.className = 'scrim';
  s.onclick = () => { side.classList.remove('open'); s.remove(); };
  document.body.appendChild(s);
});

// Confirm destructive actions without a library
document.body.addEventListener('click', (e) => {
  const el = e.target.closest('[data-confirm]');
  if (el && !confirm(el.dataset.confirm)) { e.preventDefault(); e.stopPropagation(); }
}, true);

// Deposit page: reveal the wallet address for the chosen method
const methodSel = document.getElementById('m');
if (methodSel && methodSel.dataset.wallets) {
  const wallets = JSON.parse(methodSel.dataset.wallets);
  const box = document.getElementById('wallet-box');
  const addr = document.getElementById('wallet-addr');
  const update = () => {
    const v = wallets[methodSel.value] || '';
    if (v) { addr.textContent = v; box.style.display = ''; }
    else { box.style.display = 'none'; }
  };
  methodSel.addEventListener('change', update);
  update();
}

// Copy-to-clipboard helper
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const target = document.querySelector(btn.dataset.copy);
  if (!target) return;
  navigator.clipboard?.writeText(target.textContent.trim());
  const t = btn.textContent; btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = t; }, 1200);
});

// Trade page: live order estimate + chart symbol sync
(function () {
  const sel = document.getElementById('sym');
  const amt = document.getElementById('amt');
  const est = document.getElementById('est');
  const chartSym = document.getElementById('chart-sym');
  if (!sel || !amt) return;
  let prices = [];
  try { prices = JSON.parse(sel.dataset.prices || '[]'); } catch {}
  const fmt = (n, dp = 6) => Number(n).toLocaleString('en-US', { maximumFractionDigits: dp });
  const refresh = () => {
    const p = prices.find(x => x.s === sel.value) || prices[0];
    if (!p) return;
    const usd = Number(amt.value || 0);
    if (chartSym) chartSym.textContent = (p.k || sel.value).replace(/USDT$/, 'USD');
    if (usd > 0 && p.px > 0) {
      est.textContent = `≈ ${fmt(usd / p.px)} ${p.k} at ${Number(p.px).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
    } else {
      est.textContent = '';
    }
  };
  sel.addEventListener('change', refresh);
  amt.addEventListener('input', refresh);
  refresh();
})();
