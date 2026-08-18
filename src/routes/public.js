import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { plans as plansT, traderTrades, traders as tradersT } from '../db/schema.js';
import { render, partial, eta } from '../lib/view.js';
import { verifyRecaptcha } from '../lib/recaptcha.js';
import { traderStats, platformStats, livePrices } from '../lib/stats.js';
import * as fmt from '../lib/money.js';

export const pub = new Hono();

const ic = {
  globe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 010 18 15 15 0 010-18"/></svg>',
  chart: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 17l5-6 4 4 6-8"/><path d="M3 21h18"/></svg>',
  flame: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3s5 4.2 5 8.6A5 5 0 017 11.6C7 8.5 9 6 12 3z"/><path d="M12 21a4 4 0 004-4c0-2-2-3.4-4-6-2 2.6-4 4-4 6a4 4 0 004 4z"/></svg>',
  bank:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 10l9-6 9 6"/><path d="M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18"/></svg>',
  drop:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3l5.5 7.5a6.5 6.5 0 11-11 0z"/></svg>',
  mail:  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  tools: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 20l5-5"/><path d="M14.5 4.5a4 4 0 105.5 5.5L14 16l-6-6 6.5-5.5z"/></svg>',
  shield:'<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};

const ASSETS = [
  { slug: 'forex',    name: 'Forex',    tint: '#5A8CFF', icon: ic.globe, blurb: '70+ major, minor and exotic pairs with competitive spreads and deep liquidity.' },
  { slug: 'shares',   name: 'Shares',   tint: '#16C784', icon: ic.chart, blurb: 'Hundreds of listed companies across the US, UK, Germany and more.' },
  { slug: 'energies', name: 'Energies', tint: '#F0B429', icon: ic.flame, blurb: 'UK and US crude oil plus natural gas with tight spreads and no expiry surprises.' },
  { slug: 'indices',  name: 'Indices',  tint: '#7C5CFF', icon: ic.bank,  blurb: 'Major and minor index CFDs from every session around the globe.' },
];

const INTEL = [
  { tint: '#5A8CFF', icon: ic.mail,   title: 'Daily market briefing',  body: 'A short written read on the sessions that moved, delivered before the London open.' },
  { tint: '#16C784', icon: ic.tools,  title: 'Charting and screeners', body: 'Full TradingView charting, watchlists and alerts attached to your live account.' },
  { tint: '#7C5CFF', icon: ic.shield, title: 'Position sizing',        body: 'Exposure limits per strategy so a single bad run cannot take the whole account.' },
];

const COIN_META = [
  { ticker: 'BTC', pair: 'BTCUSDT', name: 'Bitcoin',  grad: 'linear-gradient(135deg,#F7931A,#B45309)', blurb: 'The original decentralised digital currency, settled peer to peer with no central administrator.' },
  { ticker: 'ETH', pair: 'ETHUSDT', name: 'Ethereum', grad: 'linear-gradient(135deg,#627EEA,#3C4FB8)', blurb: 'A programmable blockchain with smart contracts, and the second largest asset by market cap.' },
  { ticker: 'XRP', pair: 'XRPUSDT', name: 'Ripple',   grad: 'linear-gradient(135deg,#2F6BFF,#FFC83D)', blurb: 'A real-time settlement and remittance network built for moving value across borders.' },
  { ticker: 'ADA', pair: 'ADAUSDT', name: 'Cardano',  grad: 'linear-gradient(135deg,#5A6BF0,#2B3391)', blurb: 'A peer-reviewed proof-of-stake platform focused on scalability and sustainability.' },
];

async function tickerHtml() {
  const prices = await livePrices(10);
  return eta.render('partials/ticker', { ...fmt, prices });
}

pub.get('/', async (c) => {
  const [stats, traders, plans, prices, tick] = await Promise.all([
    platformStats(),
    traderStats(),
    db.select().from(plansT).where(eq(plansT.active, true)).orderBy(plansT.sortOrder),
    livePrices(30),
    tickerHtml(),
  ]);

  const byPair = Object.fromEntries(prices.map((p) => [p.pair, p]));
  const coins = COIN_META.map((m) => ({ ...m, price: byPair[m.pair]?.price || 0, change: byPair[m.pair]?.change || 0 }));

  // Highlight the plan closest to the middle of the range, not the loudest one.
  const featuredIdx = Math.min(1, plans.length - 1);
  const decorated = plans.map((p, i) => ({ ...p, featured: i === featuredIdx }));

  const body = eta.render('pages/home', {
    ...fmt, stats, traders, plans: decorated, coins, assets: ASSETS, intel: INTEL,
  });
  return render(c, 'layouts/site', { body, tickerHtml: tick });
});

pub.get('/partials/ticker', async (c) => c.html(await tickerHtml()));

/* ---- Copy trading index + trader record ---- */
pub.get('/copy-trading', async (c) => {
  const [traders, tick] = await Promise.all([traderStats(), tickerHtml()]);
  const body = eta.render('pages/copy-index', { ...fmt, traders });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: 'Copy trading' });
});

pub.get('/copy-trading/:slug', async (c) => {
  const [t] = await db.select().from(tradersT).where(eq(tradersT.slug, c.req.param('slug'))).limit(1);
  if (!t) return c.notFound();
  const [[stat], trades, tick] = await Promise.all([
    traderStats(t.id),
    db.select().from(traderTrades)
      .where(and(eq(traderTrades.traderId, t.id), eq(traderTrades.status, 'closed')))
      .orderBy(desc(traderTrades.closedAt)).limit(40),
    tickerHtml(),
  ]);
  const body = eta.render('pages/trader', { ...fmt, t: stat, trades });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: stat.displayName });
});

/* ---- Plans ---- */
pub.get('/plans', async (c) => {
  const [plans, tick] = await Promise.all([
    db.select().from(plansT).where(eq(plansT.active, true)).orderBy(plansT.sortOrder),
    tickerHtml(),
  ]);
  const body = eta.render('pages/plans', { ...fmt, plans });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: 'Investment plans' });
});

/* ---- Market pages, driven by one template ---- */
const MARKET_TV = {
  forex:    'FX:EURUSD', shares: 'NASDAQ:AAPL', energies: 'TVC:UKOIL',
  indices:  'FOREXCOM:SPXUSD', crypto: 'BITSTAMP:BTCUSD',
};

pub.get('/markets', async (c) => {
  const tick = await tickerHtml();
  const body = eta.render('pages/markets', { ...fmt, assets: ASSETS });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: 'Markets' });
});

pub.get('/markets/:slug', async (c) => {
  const slug = c.req.param('slug');
  const meta = ASSETS.find((a) => a.slug === slug)
    || (slug === 'crypto' ? { slug: 'crypto', name: 'Cryptocurrency', tint: '#F0B429', icon: ic.drop, blurb: 'Trade the most liquid digital assets around the clock.' } : null);
  if (!meta) return c.notFound();
  const tick = await tickerHtml();
  const body = eta.render('pages/market', { ...fmt, m: meta, tvSymbol: MARKET_TV[slug] || 'BITSTAMP:BTCUSD' });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: meta.name });
});

/* ---- Static content pages ---- */
const SIMPLE = {
  '/about':          { t: 'About',           v: 'pages/about' },
  '/contact':        { t: 'Contact',         v: 'pages/contact' },
  '/education':      { t: 'Education',       v: 'pages/education' },
  '/bots':           { t: 'Automation',      v: 'pages/bots' },
  '/legal/terms':    { t: 'Terms',           v: 'pages/legal-terms' },
  '/legal/privacy':  { t: 'Privacy',         v: 'pages/legal-privacy' },
  '/legal/risk':     { t: 'Risk disclosure', v: 'pages/legal-risk' },
};
for (const [route, cfg] of Object.entries(SIMPLE)) {
  pub.get(route, async (c) => {
    const tick = await tickerHtml();
    const body = eta.render(cfg.v, { ...fmt });
    return render(c, 'layouts/site', { body, tickerHtml: tick, title: cfg.t });
  });
}

/* ---- Contact form POST ---- */
pub.post('/contact', async (c) => {
  const tick = await tickerHtml();
  const data = c.get('body');
  const back = (err) => {
    const body = eta.render('pages/contact', {
      ...fmt,
      error: err,
      name: data.name || '',
      email: data.email || '',
      message: data.message || '',
    });
    return render(c, 'layouts/site', { body, tickerHtml: tick, title: 'Contact' });
  };

  if (!data.name || !data.email || !data.message) {
    return back('Please complete all fields before sending.');
  }

  const recaptcha = await verifyRecaptcha(data['g-recaptcha-response']);
  if (!recaptcha.ok) return back(recaptcha.error);

  // Best-effort: log the message; swap for an email/DB call before going live
  console.info('[contact]', { name: data.name, email: data.email, message: String(data.message).slice(0, 500) });

  const body = eta.render('pages/contact', { ...fmt, sent: true });
  return render(c, 'layouts/site', { body, tickerHtml: tick, title: 'Contact', sent: true });
});
