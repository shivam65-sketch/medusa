// Medusa accounts: sign-up, sign-in, sessions, two-step codes and recovery codes.
//
// - Passwords: PBKDF2-SHA256 with 25,000 rounds (what fits in the free plan's 10 ms of CPU per
//   request), run over an HMAC of the password keyed from the ENCRYPTION_KEY secret. That secret is in
//   Cloudflare's secret store, so a copy of the database alone can't even be used to test guesses.
// - Sessions: a random 256-bit token in an HttpOnly cookie. Only its SHA-256 is stored, so the
//   database can't be used to sign in. 60 days, extended while the app is used.
// - Two-step login: standard 6-digit authenticator codes (TOTP, RFC 6238). The secret is encrypted
//   and each code works once.
// - Recovery code: 100 random bits, shown once, stored as a keyed hash. It resets the password and
//   turns two-step login off, for when either is lost.
// - Every guessable step is rate-limited per address and per account.
// Accounts are identified by email address (kept in the `username` column). The free plan can't send
// email, so addresses are never verified or written to; they are only the sign-in name.

import { json, fail, readBody } from './http.js';
import { canStore, secretKey } from './vault.js';
import { deleteLabData } from './lab.js';
import { deleteLogs } from './logs.js';
import { forgetMetrics } from './metrics.js';

const enc = new TextEncoder();
const MIN = 60_000;
const DAY = 86_400_000;
export const ROUNDS = 25_000;
const SESSION_DAYS = 60;
const COOKIE = 'session';
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const isEmail = (e) => e.length <= 254 && EMAIL.test(e);
const FRESH_MIN = 30; // minutes after signing in during which a CoinDCX key can be connected without typing the password again
const COMMON = new Set(['password1234', 'password12345', 'password123456', '123456789012', 'qwertyuiop12', '111111111111',
  'iloveyou1234', 'passwordpassword', 'qwertyqwerty', '1234567890123', 'abcdefghijkl', 'abc123abc123']);

/* ---------- bytes ---------- */

const b64 = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
function same(a, b) {
  if (typeof a === 'string') a = enc.encode(a);
  if (typeof b === 'string') b = enc.encode(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const sha256 = async (text) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
async function mac(env, info, text) {
  const key = await secretKey(env, info, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/* ---------- passwords ---------- */

async function pwHash(env, password, salt, rounds) {
  const peppered = await mac(env, 'user-password', password);
  const base = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, 256));
}
async function makePw(env, password) {
  const salt = random(16);
  return JSON.stringify({ v: 1, rounds: ROUNDS, salt: b64(salt), hash: b64(await pwHash(env, password, salt, ROUNDS)) });
}
async function checkPw(env, stored, password) {
  const r = JSON.parse(stored);
  return same(await pwHash(env, password, unb64(r.salt), r.rounds), unb64(r.hash));
}
// Unknown emails take as long as wrong passwords, so timing doesn't reveal which accounts exist.
const notAUser = (env, password) => pwHash(env, password, new Uint8Array(16), ROUNDS).then(() => false);

export function weakPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters for the password.';
  if (pw.length > 200) return 'Use at most 200 characters for the password.';
  if (!pw.trim()) return 'The password can’t be only spaces.';
  const low = pw.toLowerCase();
  const name = String(email || '').split('@')[0];
  if (name.length >= 3 && low.split(name).join('').length < 10) return 'That password is mostly your email address. Pick something else.';
  if (/^(.)\1+$/.test(pw) || COMMON.has(low)) return 'That password is too easy to guess. Pick another one.';
  return '';
}

/* ---------- recovery codes ---------- */

const RC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols without 0/O/1/I, 5 bits each
const newRecoveryCode = () => [...random(20)].map((b) => RC[b & 31]).join('').match(/.{4}/g).join('-');
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const recoveryHash = async (env, email, code) => b64(await mac(env, 'recovery-code', `${email}:${cleanCode(code)}`));

/* ---------- two-step codes (TOTP) ---------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export async function hotp(secret, counter, digits = 6) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  for (let i = 7, c = counter; i >= 0; i--, c = Math.floor(c / 256)) msg[i] = c & 0xff;
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
/** The time step the code belongs to (now, or 30 s either side), or null. Steps <= `last` were used already. */
async function totpStep(secret, code, last, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    if (s > last && same(await hotp(secret, s), c)) return s;
  }
  return null;
}
const totpKey = (env) => secretKey(env, 'totp-secret', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
async function seal(env, uid, secret) {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`journal:totp:${uid}`) }, await totpKey(env), secret);
  return { iv: b64(iv), ct: b64(ct) };
}
async function unseal(env, uid, box) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(`journal:totp:${uid}`) }, await totpKey(env), unb64(box.ct));
  return new Uint8Array(plain);
}

/* ---------- rate limits ---------- */

const LIMITS = {
  login: [10, 15 * MIN],      // wrong passwords: per address, and per account email
  code: [6, 15 * MIN],        // wrong two-step codes, per account
  recover: [6, 60 * MIN],     // wrong recovery codes: per address, and per account email
  reauth: [8, 15 * MIN],      // wrong current password inside the app, per account
  signup: [5, 60 * MIN],      // new accounts per address
  signupAll: [100, DAY],      // new accounts in total
};
const ipOf = (req) => req.headers.get('cf-connecting-ip') || 'local';
async function limited(env, pairs) {
  const now = Date.now();
  const res = await env.DB.batch(pairs.map(([kind, key]) =>
    env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE kind = ? AND key = ? AND ts > ?').bind(kind, key, now - LIMITS[kind][1])));
  return res.some((r, i) => r.results[0].n >= LIMITS[pairs[i][0]][0]);
}
const record = (env, pairs) => {
  const now = Date.now();
  return env.DB.batch(pairs.map(([kind, key]) => env.DB.prepare('INSERT INTO attempts (kind, key, ts) VALUES (?, ?, ?)').bind(kind, key, now)));
};
const wait = (minutes) => fail(429, `Too many wrong tries. Wait ${minutes} minutes, then try again.`);

/* ---------- sessions ---------- */

function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
// The cookie itself may live as long as browsers allow; the session row decides how long it works.
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearCookie = () => cookie('', 0);

function deviceName(req) {
  const ua = req.headers.get('user-agent') || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux|CrOS/.test(ua) ? 'Linux' : 'a device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

async function startSession(env, uid, req) {
  const token = b64url(random(32));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(uid, now),
    env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, seen_at, agent) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256(token), uid, now, now + SESSION_DAYS * DAY, now, deviceName(req)),
  ]);
  return cookie(token, 400 * 86400);
}

/** The signed-in account ({ id, email, sid, fresh }) or null. `fresh`: signed in within FRESH_MIN minutes. */
export async function currentUser(req, env) {
  const token = readCookie(req, COOKIE);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sid = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT s.user_id, s.created_at, s.expires_at, s.seen_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').bind(sid).first();
  if (!row || row.expires_at <= now) return null;
  if (now - row.seen_at > 60 * MIN) {
    await env.DB.prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?').bind(now, now + SESSION_DAYS * DAY, sid).run();
  }
  return { id: row.user_id, email: row.username, sid, fresh: now - row.created_at < FRESH_MIN * MIN };
}

export async function accountInfo(env, user) {
  const now = Date.now();
  const [u, s] = await env.DB.batch([
    env.DB.prepare('SELECT username, created_at, pw_changed_at, recovery_at, totp IS NOT NULL AS two FROM users WHERE id = ?').bind(user.id),
    env.DB.prepare('SELECT id, agent, seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY seen_at DESC').bind(user.id, now),
  ]);
  const a = u.results[0];
  return {
    email: a.username, createdAt: a.created_at, pwChangedAt: a.pw_changed_at, recoveryAt: a.recovery_at, twoStep: Boolean(a.two),
    devices: s.results.map((x) => ({ name: x.agent, seenAt: x.seen_at, current: x.id === user.sid })),
  };
}

/* ---------- checks used by several actions ---------- */

const setupMissing = () => fail(503, 'Finish setup first: the ENCRYPTION_KEY secret is missing. The README has the command.');
const normEmail = (v) => String(v || '').trim().toLowerCase();
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);

/** Inside the app: the account's password again, for sensitive changes. null = fine. */
export async function confirmPassword(env, user, password) {
  const key = 'u:' + user.id;
  if (await limited(env, [['reauth', key]])) return wait(15);
  const row = await env.DB.prepare('SELECT pw FROM users WHERE id = ?').bind(user.id).first();
  if (row && (await checkPw(env, row.pw, String(password || '')))) return null;
  await record(env, [['reauth', key]]);
  return fail(403, "That password isn't right.");
}

/** A two-step code for account row `u` ({ id, totp, totp_last }). Marks it used. null = fine. */
async function useCode(env, u, code, wrongStatus) {
  const key = 'u:' + u.id;
  if (await limited(env, [['code', key]])) return wait(15);
  const step = await totpStep(await unseal(env, u.id, JSON.parse(u.totp)), code, u.totp_last || 0);
  if (step !== null) {
    const r = await env.DB.prepare('UPDATE users SET totp_last = ? WHERE id = ? AND totp_last < ?').bind(step, u.id, step).run();
    if (r.meta.changes > 0) return null;          // a code already used (e.g. twice at once) doesn't count
  }
  await record(env, [['code', key]]);
  return fail(wrongStatus, "That code isn't right. Type the newest code from your authenticator app.", { need2fa: true });
}

/* ---------- signed-out actions ---------- */

export async function signup(req, env) {
  if (!canStore(env)) return setupMissing();
  const b = await readBody(req);
  const email = normEmail(b.email), name = cleanName(b.name), password = typeof b.password === 'string' ? b.password : '';
  if (!name) return fail(400, 'Type your name.');
  if (!isEmail(email)) return fail(400, 'Type a valid email address.');
  const weak = weakPassword(password, email);
  if (weak) return fail(400, weak);
  const ip = ipOf(req);
  if (await limited(env, [['signup', ip], ['signupAll', 'all']])) return fail(429, 'Too many new accounts were made just now. Try again later.');
  const taken = () => fail(409, 'That email already has an account. Sign in instead, or use Forgot password.');
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(email).first()) return taken();
  const code = newRecoveryCode(), now = Date.now();
  let row;
  try {
    row = await env.DB.prepare('INSERT INTO users (username, pw, recovery, created_at, pw_changed_at, recovery_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(email, await makePw(env, password), await recoveryHash(env, email, code), now, now, now).first();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return taken();
    throw e;
  }
  await env.DB.prepare("INSERT INTO kv (user_id, k, v) VALUES (?, 'settings', ?)").bind(row.id, JSON.stringify({ name })).run();
  await record(env, [['signup', ip], ['signupAll', 'all']]);
  return json({ ok: true, recoveryCode: code }, 200, { 'set-cookie': await startSession(env, row.id, req) });
}

export async function login(req, env) {
  if (!canStore(env)) return setupMissing();
  const b = await readBody(req);
  const email = normEmail(b.email), password = typeof b.password === 'string' ? b.password : '';
  const ip = ipOf(req);
  const keys = [['login', ip], ['login', 'u:' + email]];
  if (await limited(env, keys)) return wait(15);
  const u = isEmail(email) ? await env.DB.prepare('SELECT id, pw, totp, totp_last FROM users WHERE username = ?').bind(email).first() : null;
  const ok = u ? await checkPw(env, u.pw, password) : await notAUser(env, password);
  if (!ok) {
    await record(env, keys);
    return fail(401, "That email and password don't match.");
  }
  if (u.totp) {
    if (!String(b.code || '').trim()) return json({ need2fa: true });
    const refused = await useCode(env, u, b.code, 401);
    if (refused) return refused;
  }
  const sets = [env.DB.prepare('DELETE FROM attempts WHERE ts < ?').bind(Date.now() - DAY)];
  if (JSON.parse(u.pw).rounds !== ROUNDS) sets.push(env.DB.prepare('UPDATE users SET pw = ? WHERE id = ?').bind(await makePw(env, password), u.id));
  await env.DB.batch(sets);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, u.id, req) });
}

/** Forgot the password (or lost the phone): email + recovery code + new password. */
export async function recover(req, env) {
  if (!canStore(env)) return setupMissing();
  const b = await readBody(req);
  const email = normEmail(b.email), code = cleanCode(b.code), next = typeof b.next === 'string' ? b.next : '';
  const ip = ipOf(req);
  const keys = [['recover', ip], ['recover', 'u:' + email]];
  if (await limited(env, keys)) return wait(60);
  const weak = weakPassword(next, email);
  if (weak) return fail(400, weak);
  const u = isEmail(email) ? await env.DB.prepare('SELECT id, recovery, totp FROM users WHERE username = ?').bind(email).first() : null;
  const given = await recoveryHash(env, email, code);
  if (!u || code.length !== 20 || !same(given, u.recovery)) {
    await record(env, keys);
    return fail(401, "That email and recovery code don't match.");
  }
  const fresh = newRecoveryCode(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw = ?, recovery = ?, totp = NULL, totp_pending = NULL, pw_changed_at = ?, recovery_at = ? WHERE id = ?')
      .bind(await makePw(env, next), await recoveryHash(env, email, fresh), now, now, u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  return json({ ok: true, recoveryCode: fresh, twoStepOff: Boolean(u.totp) }, 200, { 'set-cookie': await startSession(env, u.id, req) });
}

export async function logout(req, env) {
  const user = await currentUser(req, env);
  if (user) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.sid).run();
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}

/* ---------- signed-in account settings ---------- */

export async function changePassword(req, env, user) {
  const b = await readBody(req);
  const refused = await confirmPassword(env, user, b.current);
  if (refused) return refused;
  const next = typeof b.next === 'string' ? b.next : '';
  const weak = weakPassword(next, user.email);
  if (weak) return fail(400, weak);
  if (next === b.current) return fail(400, "That's your current password. Pick a new one.");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw = ?, pw_changed_at = ? WHERE id = ?').bind(await makePw(env, next), now, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, user.sid),
  ]);
  return json({ ok: true, changedAt: now });
}

export async function newRecovery(req, env, user) {
  const refused = await confirmPassword(env, user, (await readBody(req)).password);
  if (refused) return refused;
  const code = newRecoveryCode(), now = Date.now();
  await env.DB.prepare('UPDATE users SET recovery = ?, recovery_at = ? WHERE id = ?').bind(await recoveryHash(env, user.email, code), now, user.id).run();
  return json({ ok: true, recoveryCode: code, at: now });
}

export async function twoStepSetup(req, env, user) {
  const refused = await confirmPassword(env, user, (await readBody(req)).password);
  if (refused) return refused;
  const secret = random(20);
  const box = { ...(await seal(env, user.id, secret)), at: Date.now() };
  await env.DB.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').bind(JSON.stringify(box), user.id).run();
  const key = base32(secret);
  const label = encodeURIComponent(`MEDUSA:${user.email}`);
  return json({ key, uri: `otpauth://totp/${label}?secret=${key}&issuer=MEDUSA&algorithm=SHA1&digits=6&period=30` });
}

export async function twoStepEnable(req, env, user) {
  const b = await readBody(req);
  const key = 'u:' + user.id;
  if (await limited(env, [['code', key]])) return wait(15);
  const row = await env.DB.prepare('SELECT totp, totp_pending FROM users WHERE id = ?').bind(user.id).first();
  if (row.totp) return fail(400, 'Two-step login is already on.');
  const box = row.totp_pending ? JSON.parse(row.totp_pending) : null;
  if (!box || Date.now() - box.at > 15 * MIN) return fail(400, 'That setup expired. Start again.');
  const step = await totpStep(await unseal(env, user.id, box), b.code, 0);
  if (step === null) {
    await record(env, [['code', key]]);
    return fail(400, "That code isn't right. Check that your phone's clock is set automatically, then type the newest code.");
  }
  await env.DB.prepare('UPDATE users SET totp = ?, totp_pending = NULL, totp_last = ? WHERE id = ?')
    .bind(JSON.stringify({ iv: box.iv, ct: box.ct }), step, user.id).run();
  return json({ ok: true });
}

export async function twoStepDisable(req, env, user) {
  const b = await readBody(req);
  const refused = await confirmPassword(env, user, b.password);
  if (refused) return refused;
  const u = await env.DB.prepare('SELECT id, totp, totp_last FROM users WHERE id = ?').bind(user.id).first();
  if (u.totp) {
    const bad = await useCode(env, u, b.code, 403);
    if (bad) return bad;
  }
  await env.DB.prepare('UPDATE users SET totp = NULL, totp_pending = NULL WHERE id = ?').bind(user.id).run();
  return json({ ok: true });
}

export async function signOutOthers(env, user) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, user.sid).run();
  return json({ ok: true });
}

/** Deletes the account and everything in it. Needs the email typed, the password, and a code if two-step is on. */
export async function deleteAccount(req, env, user) {
  const b = await readBody(req);
  if (normEmail(b.confirm) !== user.email) return fail(400, 'Type your email address to confirm.');
  const refused = await confirmPassword(env, user, b.password);
  if (refused) return refused;
  const u = await env.DB.prepare('SELECT id, totp, totp_last FROM users WHERE id = ?').bind(user.id).first();
  if (u.totp) {
    const bad = await useCode(env, u, b.code, 403);
    if (bad) return bad;
  }
  const db = env.DB;
  await forgetMetrics(env, user.id);             // its own Markets definitions, in the lakehouse and here
  const lab = await deleteLabData(env, user.id); // Lab files in KV first, then their lists go with the rest
  lab.push(await deleteLogs(env, user.id));
  await db.batch([
    ...['orders', 'txs', 'trades', 'triggers', 'annotations', 'days', 'kv', 'sessions'].map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)),
    ...lab,
    db.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
}
