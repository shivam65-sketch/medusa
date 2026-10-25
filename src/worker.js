// Medusa: the server. Static files in /public are served by Cloudflare directly; this Worker
// handles /api/* and /logo/*. Anyone can create an account; everything except signing up and in is
// behind a session (auth.js), and every query is limited to the signed-in account's own rows.

import { coindcx, CoinDCXError } from './coindcx.js';
import { importStep, importInfo, resetImport } from './sync.js';
import { pickLevels } from './trades.js';
import { logoResponse } from './logos.js';
import { loadCreds, saveCreds, credsInfo, deleteCreds, canStore } from './vault.js';
import { json, fail, readBody } from './http.js';
import { labRoute, bodyLimit } from './lab.js';
import { logsRoute } from './logs.js';
import { marketIngest, marketScanner } from './market.js';
import { myMetrics, saveMetric, resetMetric, metricHistory, reloadMetrics } from './metrics.js';
import {
  currentUser, accountInfo, confirmPassword, signup, login, recover, logout, changePassword, newRecovery,
  twoStepSetup, twoStepEnable, twoStepDisable, signOutOthers, deleteAccount,
} from './auth.js';

const DAY = 86_400_000;

/* ---------- input cleaning ---------- */

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const words = (v, items = 12, len = 40) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, items) : [];
const whole = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12 ? v : null);

function cleanNote(b) {
  const chart = str(b.chart, 400);
  return {
    setup: str(b.setup, 40) || null,
    tags: words(b.tags),
    mistakes: words(b.mistakes),
    emotion: str(b.emotion, 40) || null,
    rating: whole(b.rating, 1, 5),
    plan: b.plan === 1 || b.plan === 0 ? b.plan : null,
    risk: positive(b.risk),
    notes: str(b.notes, 8000),
    chart: /^https:\/\/\S+$/i.test(chart) ? chart : '',
  };
}

function cleanSettings(b) {
  return {
    name: str(b.name, 40),
    usdtLabel: b.usdtLabel === 'USDT' ? 'USDT' : '$',
    balance: positive(b.balance),
    defaultRisk: positive(b.defaultRisk),
    setups: words(b.setups, 40),
    tags: words(b.tags, 40),
    mistakes: words(b.mistakes, 40),
    emotions: words(b.emotions, 40),
    autoImport: b.autoImport !== false,
  };
}

/* ---------- handlers (uid = the signed-in account) ---------- */

async function journal(env, user) {
  const db = env.DB, uid = user.id;
  const [trades, notes, days, settings] = await db.batch([
    db.prepare('SELECT id, pair, sym, base, mcur, side, open_ts, close_ts, qty, entry, exit, pnl, fees, funding, net, lev, entry_type, exit_kind, orders, pnl_source FROM trades WHERE user_id = ? ORDER BY close_ts').bind(uid),
    db.prepare('SELECT trade_id, setup, tags, mistakes, emotion, rating, plan, risk, notes, chart, updated_at FROM annotations WHERE user_id = ?').bind(uid),
    db.prepare('SELECT date, plan, review, mood, updated_at FROM days WHERE user_id = ?').bind(uid),
    db.prepare("SELECT v FROM kv WHERE user_id = ? AND k = 'settings'").bind(uid),
  ]);
  return json({
    trades: trades.results,
    notes: notes.results.map((n) => ({ ...n, tags: JSON.parse(n.tags || '[]'), mistakes: JSON.parse(n.mistakes || '[]') })),
    days: days.results,
    settings: settings.results[0] ? JSON.parse(settings.results[0].v) : null,
    import: await importInfo(db, uid),
    coindcx: await credsInfo(env, uid),
    account: await accountInfo(env, user),
  });
}

async function saveNote(env, uid, id, req) {
  if (!id || id.length > 200) return fail(400, 'Unknown trade.');
  const exists = await env.DB.prepare('SELECT 1 AS x FROM trades WHERE user_id = ? AND id = ?').bind(uid, id).first();
  if (!exists) return fail(404, 'That trade is no longer in the journal.');
  const n = cleanNote(await readBody(req));
  await env.DB.prepare(
    `INSERT INTO annotations (user_id, trade_id, setup, tags, mistakes, emotion, rating, plan, risk, notes, chart, updated_at)
     VALUES (?12, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(user_id, trade_id) DO UPDATE SET setup = ?2, tags = ?3, mistakes = ?4, emotion = ?5, rating = ?6, plan = ?7, risk = ?8, notes = ?9, chart = ?10, updated_at = ?11`,
  ).bind(id, n.setup, JSON.stringify(n.tags), JSON.stringify(n.mistakes), n.emotion, n.rating, n.plan, n.risk, n.notes, n.chart, Date.now(), uid).run();
  return json({ ok: true, note: { trade_id: id, ...n } });
}

async function saveDay(env, uid, date, req) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'Unknown day.');
  const b = await readBody(req);
  const plan = str(b.plan, 8000), review = str(b.review, 8000), mood = whole(b.mood, 1, 5);
  if (!plan && !review && !mood) {
    await env.DB.prepare('DELETE FROM days WHERE user_id = ? AND date = ?').bind(uid, date).run();
    return json({ ok: true, day: null });
  }
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO days (user_id, date, plan, review, mood, updated_at) VALUES (?6, ?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id, date) DO UPDATE SET plan = ?2, review = ?3, mood = ?4, updated_at = ?5',
  ).bind(date, plan, review, mood, now, uid).run();
  return json({ ok: true, day: { date, plan, review, mood, updated_at: now } });
}

async function saveSettings(env, uid, req) {
  const s = cleanSettings(await readBody(req));
  await env.DB.prepare("INSERT INTO kv (user_id, k, v) VALUES (?2, 'settings', ?1) ON CONFLICT(user_id, k) DO UPDATE SET v = ?1").bind(JSON.stringify(s), uid).run();
  return json({ ok: true, settings: s });
}

/** The stop loss and take profit that were set on one trade, from the imported CoinDCX orders. */
async function levels(env, uid, url) {
  const id = url.searchParams.get('id') || '';
  if (!id || id.length > 200) return fail(400, 'Unknown trade.');
  const t = await env.DB.prepare('SELECT pair, mcur, side, open_ts, close_ts FROM trades WHERE user_id = ? AND id = ?').bind(uid, id).first();
  if (!t) return fail(404, 'That trade is no longer in the journal.');
  const r = await env.DB.prepare('SELECT side, kind, price, status, created_at, updated_at FROM triggers WHERE user_id = ? AND pair = ? AND mcur = ? AND created_at <= ? AND updated_at >= ?')
    .bind(uid, t.pair, t.mcur, t.close_ts, t.open_ts).all();
  const { sl, tp } = pickLevels(t, r.results);
  const out = (x) => (x ? { price: x.price, hit: x.status === 'filled' } : null);
  return json({ sl: out(sl), tp: out(tp) });
}

/**
 * The stop loss and take profit of every trade on one coin, for the Lab's chart: two queries in one
 * round trip, then the same choice as levels() (the last one placed that was live while the trade was
 * open), found by a short search per trade so it stays well inside the free plan's CPU time.
 * Answer: {levels: {tradeId: [stop, target, 1 if the stop filled / 2 if the target filled / 0]}}.
 */
async function coinLevels(env, uid, url) {
  const pair = url.searchParams.get('pair') || '', mcur = url.searchParams.get('mcur') || 'USDT';
  if (!pair || pair.length > 60 || mcur.length > 10) return fail(400, 'Unknown coin.');
  const [tr, tg] = await env.DB.batch([
    env.DB.prepare('SELECT id, side, open_ts, close_ts FROM trades WHERE user_id = ? AND pair = ? AND mcur = ?').bind(uid, pair, mcur),
    env.DB.prepare('SELECT side, kind, price, status, created_at, updated_at FROM triggers WHERE user_id = ? AND pair = ? AND mcur = ? ORDER BY created_at').bind(uid, pair, mcur),
  ]);
  const bySide = { buy: [], sell: [] };
  for (const x of tg.results || []) if (bySide[x.side]) bySide[x.side].push(x);
  const LOOK = 90 * DAY;                                     // an order placed more than 90 days before the trade isn't its stop
  const out = {};
  for (const t of tr.results || []) {
    const list = bySide[t.side === 'long' ? 'sell' : 'buy'];
    let a = 0, b = list.length;
    while (a < b) { const m = (a + b) >> 1; if (list[m].created_at <= t.close_ts) a = m + 1; else b = m; }
    let sl = null, tp = null;
    for (let i = a - 1; i >= 0 && (!sl || !tp) && list[i].created_at >= t.open_ts - LOOK; i--) {
      const x = list[i];
      if (x.updated_at < t.open_ts) continue;
      if (x.kind === 'sl' && !sl) sl = x;
      else if (x.kind === 'tp' && !tp) tp = x;
    }
    if (sl || tp) out[t.id] = [sl ? sl.price : null, tp ? tp.price : null, sl && sl.status === 'filled' ? 1 : tp && tp.status === 'filled' ? 2 : 0];
  }
  return json({ levels: out });
}

async function runImport(env, uid) {
  try {
    return json(await importStep(env, uid, coindcx(await loadCreds(env, uid), env)));
  } catch (e) {
    if (e instanceof CoinDCXError) return fail(502, e.message);
    return fail(500, String(e && e.message ? e.message : e).slice(0, 300));
  }
}

/*
 * Connect CoinDCX from the app. The password is asked again (except in the first 30 minutes after
 * signing in, e.g. right after creating the account), the key and secret are checked with one
 * read-only call before anything is saved, then they are stored encrypted (vault.js). They are never
 * sent back to the browser: the app only ever sees the last 4 characters of the key.
 */
async function connectCoinDCX(req, env, user) {
  if (!canStore(env)) return fail(503, 'Finish setup first: the ENCRYPTION_KEY secret is missing. The README has the command.');
  const body = await readBody(req);
  if (body.password || !user.fresh) {
    if (!body.password) return fail(403, 'For your safety, type your MEDUSA password to connect a key.', { needPassword: true });
    const refused = await confirmPassword(env, user, body.password);
    if (refused) return refused;
  }
  const key = String(body.apiKey || '').trim(), secret = String(body.apiSecret || '').trim();
  const shape = /^[A-Za-z0-9_-]{16,200}$/;
  if (!shape.test(key) || !shape.test(secret)) {
    return fail(400, "That doesn't look like a CoinDCX API key and secret. Copy them again from CoinDCX's API dashboard.");
  }
  const api = coindcx({ key, secret }, env);
  let lastError = null;
  for (const mcur of [['USDT', 'INR'], ['USDT']]) {
    try {
      await api.orders({ side: 'buy', page: 1, size: 1, mcur });
      lastError = null;
      break;
    } catch (e) {
      if (!(e instanceof CoinDCXError)) throw e;
      if (e.status === 401 || e.status === 403) return fail(400, 'CoinDCX rejected this key and secret. Check that you copied both in full and that the key is still active.');
      lastError = e;
      if (!(e.status >= 400 && e.status < 500)) break;
    }
  }
  if (lastError) return fail(502, lastError.network ? "Couldn't reach CoinDCX to check the key. Nothing was saved; try again." : `${lastError.message} Nothing was saved.`);
  await saveCreds(env, user.id, key, secret);
  return json({ ok: true, coindcx: await credsInfo(env, user.id) });
}

// Candles for replaying a closed trade: CoinDCX's public futures chart data, no key involved.
const STEPS = [[5 * 3_600_000, '1', 60_000], [26 * 3_600_000, '5', 300_000], [3.5 * DAY, '15', 900_000], [14 * DAY, '60', 3_600_000], [56 * DAY, '240', 14_400_000], [Infinity, '1D', DAY]];
async function candles(url) {
  const pair = url.searchParams.get('pair') || '';
  const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
  if (!/^[A-Z]{1,3}-[A-Z0-9]{1,24}_[A-Z0-9]{2,6}$/.test(pair) || !(from > 0) || !(to >= from) || to - from > 400 * DAY) return fail(400, 'Bad chart request.');
  const span = Math.max(to - from, 60_000);
  // Start with the finest candles that fit; CoinDCX keeps less fine-grained history, so step up if a size comes back empty.
  const start = STEPS.findIndex(([max]) => span * 1.5 <= max);
  for (let i = start; i < Math.min(STEPS.length, start + 3); i++) {
    const [, res, step] = STEPS[i];
    const pad = Math.max(span * 0.3, step * 12);
    const q = new URLSearchParams({ pair, from: String(Math.floor((from - pad) / 1000)), to: String(Math.ceil(Math.min(Date.now(), to + pad) / 1000)), resolution: res, pcode: 'f' });
    let d = null;
    try {
      const r = await fetch(`https://public.coindcx.com/market_data/candlesticks?${q}`, { headers: { Accept: 'application/json' } });
      d = r.ok ? await r.json() : null;
    } catch {
      d = null;
    }
    if (!d || !Array.isArray(d.data)) return fail(502, "CoinDCX's chart data isn't available right now.");
    const rows = d.data
      .map((c) => [Number(c.time), Number(c.open), Number(c.high), Number(c.low), Number(c.close)])
      .filter((c) => c.every(Number.isFinite))
      .sort((a, b) => a[0] - b[0])
      .slice(-700);
    if (rows.length >= 5 || i === Math.min(STEPS.length, start + 3) - 1) {
      return json({ res, step, candles: rows }, 200, { 'cache-control': 'private, max-age=86400' });
    }
  }
  return fail(502, "CoinDCX's chart data isn't available right now.");
}

/* ---------- USDT in Indian rupees (the INR switch) ---------- */
// The last USDT/INR trade on CoinDCX (public data, a few bytes), kept in Cloudflare's cache for 5 minutes.
async function usdtInr() {
  const cache = caches.default;
  const key = new Request('https://medusa.cache/fx/usdt-inr');
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const headers = { 'User-Agent': 'Mozilla/5.0 (MEDUSA trading journal)', Accept: 'application/json' };
  let rate = null, at = null;
  try {
    const r = await fetch('https://public.coindcx.com/market_data/trade_history?pair=I-USDT_INR&limit=1', { headers });
    const d = r.ok ? await r.json() : null;
    if (Array.isArray(d) && d[0] && Number(d[0].p) > 0) { rate = Number(d[0].p); at = Number(d[0].T) || Date.now(); }
  } catch { /* try the ticker below */ }
  if (!rate) {
    try {
      const r = await fetch('https://api.coindcx.com/exchange/ticker', { headers });
      const m = r.ok ? (await r.json()).find((x) => x.market === 'USDTINR') : null;
      if (m && Number(m.last_price) > 0) { rate = Number(m.last_price); at = (Number(m.timestamp) || Date.now() / 1000) * 1000; }
    } catch { /* below */ }
  }
  if (!rate) return fail(502, 'The USDT/INR rate isn’t available from CoinDCX right now.');
  const body = JSON.stringify({ rate, at, source: 'CoinDCX' });
  await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } }));
  return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/* ---------- router ---------- */

async function route(req, env, url) {
  const { pathname: path } = url;
  const method = req.method;

  // The lakehouse's daily publish job (server to server, no browser and no cookie): its own token,
  // checked in market.js, and it can only replace the market tables.
  if (path === '/api/market/ingest' && method === 'POST') return marketIngest(req, env);

  if (method !== 'GET' && method !== 'HEAD') {
    // Only this app's own pages may change anything (blocks cross-site form posts).
    const origin = req.headers.get('origin');
    if (req.headers.get('x-requested-with') !== 'journal' || (origin && origin !== url.origin)) return fail(403, 'Blocked.');
    const limit = bodyLimit(path, method) || (path === '/api/market/metrics/save' ? 160 * 1024 : 64 * 1024);   // a query up to 20,000 characters
    if (Number(req.headers.get('content-length') || 0) > limit) return fail(413, 'That request is too big.');
  }

  // Signed-out routes.
  if (path === '/api/session' && method === 'GET') {
    const user = await currentUser(req, env);
    return json({ signedIn: Boolean(user), ready: canStore(env), account: user ? await accountInfo(env, user) : null });
  }
  if (path === '/api/signup' && method === 'POST') return signup(req, env);
  if (path === '/api/login' && method === 'POST') return login(req, env);
  if (path === '/api/recover' && method === 'POST') return recover(req, env);
  if (path === '/api/logout' && method === 'POST') return logout(req, env);

  const user = await currentUser(req, env);
  if (!user) return fail(401, 'Sign in first.');
  const uid = user.id;

  if (path.startsWith('/logo/') && method === 'GET') return logoResponse(env, decodeURIComponent(path.slice(6)));
  if (path === '/api/journal' && method === 'GET') return journal(env, user);
  if (path === '/api/import' && method === 'POST') return runImport(env, uid);
  if (path === '/api/import/reset' && method === 'POST') {
    await resetImport(env.DB, uid);
    return json({ ok: true });
  }
  if (path.startsWith('/api/notes/') && method === 'PUT') return saveNote(env, uid, decodeURIComponent(path.slice(11)), req);
  if (path.startsWith('/api/days/') && method === 'PUT') return saveDay(env, uid, decodeURIComponent(path.slice(10)), req);
  if (path === '/api/settings' && method === 'PUT') return saveSettings(env, uid, req);
  if (path === '/api/coindcx' && method === 'GET') return json(await credsInfo(env, uid));
  if (path === '/api/coindcx' && method === 'POST') return connectCoinDCX(req, env, user);
  if (path === '/api/coindcx' && method === 'DELETE') {
    await deleteCreds(env, uid);
    return json({ ok: true, coindcx: await credsInfo(env, uid) });
  }
  if (path === '/api/candles' && method === 'GET') return candles(url);
  if (path === '/api/levels' && method === 'GET') return url.searchParams.has('pair') ? coinLevels(env, uid, url) : levels(env, uid, url);
  if (path.startsWith('/api/lab/')) return labRoute(req, env, url, uid);
  if (path === '/api/logs') return logsRoute(req, env, url, uid);
  if (path === '/api/fx' && method === 'GET') return usdtInr();
  if (path === '/api/market/scanner' && method === 'GET') return marketScanner(env);   // the live scanner's data, the same for every account
  // The Markets definitions: the account's own versions, saving a version to the lakehouse, every version
  // of one, and (the owner) reloading MEDUSA's copy from the lakehouse (metrics.js).
  if (path === '/api/market/metrics/mine' && method === 'GET') return myMetrics(env, user);
  if (path === '/api/market/metrics/save' && method === 'POST') return saveMetric(req, env, user);
  if (path === '/api/market/metrics/reset' && method === 'POST') return resetMetric(req, env, user);
  if (path === '/api/market/metrics/history' && method === 'GET') return metricHistory(env, user, url);
  if (path === '/api/market/metrics/reload' && method === 'POST') return reloadMetrics(env, user);

  // Dev tools: how far the server is (and which Cloudflare data centre answered), and clearing what this
  // browser keeps for MEDUSA. Only the site's own response can ask a browser to clear that (Clear-Site-Data);
  // it never includes cookies, so it doesn't sign you out.
  if (path === '/api/ping' && method === 'GET') return json({ colo: (req.cf && req.cf.colo) || null, at: Date.now() });
  if (path === '/api/clear-site-data' && method === 'POST') {
    const want = (await readBody(req)).types;
    const types = ['cache', 'storage'].filter((t) => Array.isArray(want) && want.includes(t));
    if (!types.length) return fail(400, 'Nothing to clear.');
    return json({ ok: true, cleared: types }, 200, { 'clear-site-data': types.map((t) => `"${t}"`).join(', ') });
  }

  // Account and security.
  if (path === '/api/account' && method === 'GET') return json(await accountInfo(env, user));
  if (path === '/api/account' && method === 'DELETE') return deleteAccount(req, env, user);
  if (path === '/api/password' && method === 'POST') return changePassword(req, env, user);
  if (path === '/api/recovery' && method === 'POST') return newRecovery(req, env, user);
  if (path === '/api/2fa/setup' && method === 'POST') return twoStepSetup(req, env, user);
  if (path === '/api/2fa/enable' && method === 'POST') return twoStepEnable(req, env, user);
  if (path === '/api/2fa/disable' && method === 'POST') return twoStepDisable(req, env, user);
  if (path === '/api/sessions/others' && method === 'DELETE') return signOutOthers(env, user);
  return fail(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/logo/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return fail(500, 'Something went wrong on the server. Try again.');
    }
  },

  // Optional: turn on the cron trigger in wrangler.toml to import new trades while the app is closed.
  // Each run moves the three accounts whose last import is oldest one step forward.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const r = await env.DB.prepare(
        `SELECT c.user_id FROM kv c LEFT JOIN kv i ON i.user_id = c.user_id AND i.k = 'import'
         WHERE c.k = 'coindcx' AND c.user_id > 0 ORDER BY COALESCE(json_extract(i.v, '$.lastAt'), 0) LIMIT 3`,
      ).all();
      for (const { user_id: uid } of r.results) {
        try {
          await importStep(env, uid, coindcx(await loadCreds(env, uid), env));
        } catch (e) {
          console.error('scheduled import:', e && e.message);
        }
      }
    })());
  },
};
