/* Small, dependency-free. HTMX does the fetching; this handles polish. */

/* ── Google reCAPTCHA v3: execute before form submission ── */
(function () {
  const siteKey = document.documentElement.dataset.recaptchaSiteKey;
  if (!siteKey || typeof grecaptcha === 'undefined') return;

  function execute(form) {
    const action = form.dataset.action || 'submit';
    return new Promise((resolve, reject) => {
      grecaptcha.ready(() => {
        grecaptcha.execute(siteKey, { action })
          .then((token) => {
            const input = form.querySelector('.recaptcha-token');
            if (input) input.value = token;
            resolve(token);
          })
          .catch(reject);
      });
    });
  }

  document.querySelectorAll('form.recaptcha-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      if (form.dataset.recaptchaReady === 'true') return;
      e.preventDefault();
      try {
        await execute(form);
        form.dataset.recaptchaReady = 'true';
        form.requestSubmit();
      } catch (err) {
        console.error('[recaptcha]', err);
        alert('Could not verify the security check. Please reload the page and try again.');
      }
    });
  });

  // Refresh token on each page load so users can submit again without reload
  grecaptcha?.ready?.(() => {
    document.querySelectorAll('form.recaptcha-form').forEach((form) => {
      execute(form).catch(() => {});
    });
  });
})();

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

// Sidebar on mobile — proper side drawer with scrim, ESC, link & close-button
// dismissal, and body-scroll lock while open.
const side = document.querySelector('.side');
const toggleBtn = document.querySelector('[data-side-toggle]');

function closeSide() {
  if (!side) return;
  side.classList.remove('open');
  document.body.classList.remove('side-open');
  const s = document.querySelector('.scrim');
  if (s) s.remove();
}
function openSide() {
  if (!side) return;
  side.classList.add('open');
  document.body.classList.add('side-open');
  if (!document.querySelector('.scrim')) {
    const s = document.createElement('div');
    s.className = 'scrim';
    s.onclick = closeSide;
    document.body.appendChild(s);
  }
  side.focus?.();
}

toggleBtn?.addEventListener('click', openSide);

// Inject a header with a close affordance into the drawer (mobile only).
if (side && !side.querySelector('.side-close')) {
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'side-close';
  header.setAttribute('aria-label', 'Close menu');
  header.innerHTML =
    '<span>Menu</span>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  header.addEventListener('click', closeSide);
  side.insertBefore(header, side.firstChild);
}

// Navigation links — allow the browser to follow href naturally.
// We simply close the overlay visually (it will be destroyed on page load anyway).
// NEVER call preventDefault() on anchor clicks — doing so blocks navigation.
side?.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (a && side.classList.contains('open')) {
    // Let the browser navigate; just clean up the overlay so the outgoing
    // page doesn't briefly show a stuck scrim.
    closeSide();
  }
});

// ESC closes the drawer.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && side?.classList.contains('open')) closeSide();
});

// Close the drawer if the viewport grows back past the mobile breakpoint.
window.matchMedia('(min-width: 901px)').addEventListener('change', (m) => {
  if (m.matches) closeSide();
});

/* ── Public site mobile navigation ── */
(function () {
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('navlinks');
  const backdrop = document.querySelector('[data-nav-backdrop]');
  if (!toggle || !nav) return;

  function closeNav() {
    nav.classList.remove('open');
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function openNav() {
    nav.classList.add('open');
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', () => {
    if (nav.classList.contains('open')) closeNav();
    else openNav();
  });

  backdrop?.addEventListener('click', closeNav);

  nav.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) closeNav();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('open')) closeNav();
  });
})();

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

// Amount preset chips (deposit / withdraw): fill the linked amount input.
document.querySelectorAll('.amount-presets').forEach((group) => {
  const target = group.dataset.target ? document.querySelector(group.dataset.target) : null;
  if (!target) return;
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-amt]');
    if (!btn) return;
    const val = btn.dataset.amt === 'max' ? group.dataset.max : btn.dataset.amt;
    target.value = val || '';
    target.dispatchEvent(new Event('input'));
    group.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
  });
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
