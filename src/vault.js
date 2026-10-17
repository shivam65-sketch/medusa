// Secrets kept in the database, encrypted: each account's CoinDCX API key and secret.
// AES-256-GCM with a fresh random IV each time. The encryption key is derived from the ENCRYPTION_KEY
// Worker secret, which lives in Cloudflare's secret store (write-only, never in the database), so a
// copy of the database alone can't reveal the credentials. Nothing here ever sends them to the browser.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
// v1 rows were saved before accounts existed; v2 rows are bound to their account, so a ciphertext
// copied to another account's row can't be decrypted there.
const AAD_V1 = enc.encode('journal:coindcx:v1');
const aadV2 = (uid) => enc.encode(`journal:coindcx:v2:${uid}`);

export const canStore = (env) => typeof env.ENCRYPTION_KEY === 'string' && env.ENCRYPTION_KEY.length >= 32;

/** A key derived from ENCRYPTION_KEY for one purpose (`info`); different purposes get unrelated keys. */
export async function secretKey(env, info, algorithm, usages) {
  if (!canStore(env)) throw new Error('ENCRYPTION_KEY is not set up yet. See the README.');
  const base = await crypto.subtle.importKey('raw', enc.encode(env.ENCRYPTION_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('journal'), info: enc.encode(info) },
    base, algorithm, false, usages,
  );
}

const aesKey = (env) => secretKey(env, 'coindcx-credentials', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);

export async function saveCreds(env, uid, key, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadV2(uid) }, await aesKey(env), enc.encode(JSON.stringify({ key, secret })));
  const row = { v: 2, iv: b64(iv), ct: b64(ct), hint: key.slice(-4), at: Date.now() };
  await env.DB.prepare("INSERT INTO kv (user_id, k, v) VALUES (?2, 'coindcx', ?1) ON CONFLICT(user_id, k) DO UPDATE SET v = ?1").bind(JSON.stringify(row), uid).run();
  return { hint: row.hint, at: row.at };
}

async function readRow(env, uid) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE user_id = ? AND k = 'coindcx'").bind(uid).first();
  return r ? JSON.parse(r.v) : null;
}

/** The account's saved CoinDCX credentials, or null. */
export async function loadCreds(env, uid) {
  const row = await readRow(env, uid);
  if (!row || !canStore(env)) return null;
  try {
    const iv = unb64(row.iv), ct = unb64(row.ct);
    const additionalData = row.v === 2 ? aadV2(uid) : AAD_V1;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, await aesKey(env), ct);
    const { key, secret } = JSON.parse(dec.decode(plain));
    return key && secret ? { key, secret } : null;
  } catch {
    return null; // ENCRYPTION_KEY changed since saving: connect again
  }
}

export async function credsInfo(env, uid) {
  const row = await readRow(env, uid);
  const usable = row ? Boolean(await loadCreds(env, uid)) : false;
  return { connected: usable, source: usable ? 'app' : null, hint: usable ? row.hint : null, at: usable ? row.at : null, broken: Boolean(row) && !usable, canStore: canStore(env) };
}

export const deleteCreds = (env, uid) => env.DB.prepare("DELETE FROM kv WHERE user_id = ? AND k = 'coindcx'").bind(uid).run();
