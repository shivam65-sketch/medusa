// Coin logos, looked up once and kept in the database so each one is only fetched the first time.
// Sources, in order: CoinCap's icon set, then CoinGecko's search. Coins neither knows get a
// simple letter badge (looked up again the next day). Only raster images are taken from outside.

import { logoKey } from './trades.js';

const RETRY_LETTER = 86_400_000; // coins without a logo are looked up again after a day
const RASTER = /^image\/(png|jpeg|webp|gif)$/;
// CoinGecko refuses requests without a descriptive User-Agent.
const UA = { 'User-Agent': 'medusa/1.0 (personal trading journal)' };

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function letterBadge(key) {
  const text = key.slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#2b303b"/>` +
    `<text x="32" y="40" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="700" fill="#dfe4ec">${text}</text></svg>`;
  return toB64(new TextEncoder().encode(svg));
}

async function grab(url, fetchImpl) {
  try {
    const r = await fetchImpl(url, { headers: { Accept: 'image/*', ...UA } });
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !RASTER.test(type)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length || bytes.length > 250_000) return null;
    return { type, data: toB64(bytes) };
  } catch {
    return null;
  }
}

async function find(key, fetchImpl) {
  const lower = key.toLowerCase();
  const coincap = await grab(`https://assets.coincap.io/assets/icons/${lower}@2x.png`, fetchImpl);
  if (coincap) return { ...coincap, source: 'coincap' };
  try {
    const r = await fetchImpl(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(lower)}`, { headers: { Accept: 'application/json', ...UA } });
    if (!r.ok) return null;
    const d = await r.json();
    const hits = (d.coins || [])
      .filter((c) => String(c.symbol || '').toUpperCase() === key && c.large)
      .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
    if (!hits.length) return null;
    const img = (await grab(String(hits[0].large).replace('/large/', '/small/'), fetchImpl)) || (await grab(hits[0].large, fetchImpl));
    return img ? { ...img, source: 'coingecko' } : null;
  } catch {
    return null;
  }
}

function imageResponse(type, b64) {
  return new Response(fromB64(b64), {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=2592000',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

export async function logoResponse(env, raw, { fetchImpl = fetch, now = Date.now() } = {}) {
  const key = logoKey(String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24));
  if (!key) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT type, data, source, fetched_at FROM logos WHERE base = ?').bind(key).first();
  if (row && (row.source !== 'letter' || now - row.fetched_at < RETRY_LETTER)) return imageResponse(row.type, row.data);
  const found = await find(key, fetchImpl);
  const item = found || { type: 'image/svg+xml', data: letterBadge(key), source: 'letter' };
  await env.DB.prepare(
    'INSERT INTO logos (base, type, data, source, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(base) DO UPDATE SET type = ?2, data = ?3, source = ?4, fetched_at = ?5',
  ).bind(key, item.type, item.data, item.source, now).run();
  return imageResponse(item.type, item.data);
}
