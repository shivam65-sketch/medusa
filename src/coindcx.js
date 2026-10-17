// Read-only CoinDCX client. CoinDCX can't make an API key read-only on its side, so this file is
// what keeps it read-only here: the key can only sign the two history calls in READ_ONLY, and it is
// only ever sent to https://api.coindcx.com. There is no code that places, changes or cancels orders
// or moves funds.

const API = 'https://api.coindcx.com';
const READ_ONLY = new Set([
  '/exchange/v1/derivatives/futures/orders',
  '/exchange/v1/derivatives/futures/positions/transactions',
]);
const FILLED = 'filled,partially_filled,partially_cancelled';
const enc = new TextEncoder();

export class CoinDCXError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'CoinDCXError';
    Object.assign(this, info);
  }
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function explain(status, msg) {
  if (status === 401 || status === 403) return 'CoinDCX rejected the API key. Connect it again from the ⋯ menu.';
  if (status === 429) return 'CoinDCX is rate-limiting requests. Wait a minute and import again.';
  if (status >= 500) return 'CoinDCX is having problems right now. Try the import again later.';
  if (/timestamp/i.test(msg)) return 'CoinDCX refused the request time. Try again in a minute.';
  return `CoinDCX said: ${msg || 'HTTP ' + status}`;
}

/** creds: { key, secret } from vault.js (or null). env is only read for the local-testing URL below. */
export function coindcx(creds, env = {}, { fetchImpl = fetch } = {}) {
  const key = (creds && creds.key) || '';
  const secret = (creds && creds.secret) || '';
  // Local testing only: a fake CoinDCX on this computer. Anything that isn't localhost is ignored.
  const dev = String(env.DEV_COINDCX_URL || '');
  const base = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(dev) ? dev : API;
  const scrub = (s) => [key, secret].filter((x) => x.length >= 8).reduce((t, x) => t.split(x).join('[hidden]'), String(s));

  async function post(path, body) {
    if (!READ_ONLY.has(path)) throw new CoinDCXError('Blocked: that is not one of the read-only history calls.', { blocked: true });
    if (!key || !secret) throw new CoinDCXError('No CoinDCX API key is set up yet.', { noKey: true });
    const payload = JSON.stringify({ ...body, timestamp: Date.now() });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-AUTH-APIKEY': key,
      'X-AUTH-SIGNATURE': await hmacHex(secret, payload),
    };
    let res;
    try {
      res = await fetchImpl(base + path, { method: 'POST', headers, body: payload });
    } catch {
      throw new CoinDCXError("Couldn't reach CoinDCX. Try again in a minute.", { network: true });
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const msg = data && typeof data === 'object' ? String(data.message || data.error || '') : String(data || '').slice(0, 200);
      throw new CoinDCXError(scrub(explain(res.status, msg)), { status: res.status, detail: scrub(msg) });
    }
    return data;
  }

  return {
    hasKey: Boolean(key && secret),
    /** One page of futures orders for one side: filled (or part-filled) ones unless `status` says otherwise. */
    orders: ({ side, page, size, mcur, status = FILLED }) => post('/exchange/v1/derivatives/futures/orders', {
      status, side, page: String(page), size: String(size), margin_currency_short_name: mcur,
    }),
    /** One page of CoinDCX's profit/loss, fee and funding records. */
    transactions: ({ page, size, mcur }) => post('/exchange/v1/derivatives/futures/positions/transactions', {
      stage: 'all', page: String(page), size: String(size), margin_currency_short_name: mcur,
    }),
  };
}
