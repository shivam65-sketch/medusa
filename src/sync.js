// Medusa: incremental import from CoinDCX. Each call does a small, bounded piece of work (the free plan
// allows 10 ms of CPU and 50 outside requests per call) and remembers where it stopped, so the app
// just calls again until `done`. Only orders and records that aren't stored yet are fetched and
// saved; nothing is ever duplicated. Closed trades are then rebuilt for the coins that changed.

import { normOrder, normTx, buildTrades, normTrigger, attachedTriggers } from './trades.js';

const PAGE = 100;
const PAGES_PER_CALL = 6;
const PAIRS_PER_CALL = 10;
const LOCK_MS = 30_000;
// Stop-loss and take-profit orders are read in these status groups, newest first.
const TRIG_GROUPS = ['cancelled', 'untriggered', 'filled,partially_filled,partially_cancelled'];
const TRIG_OVERLAP = 3 * 86_400_000; // re-read a little before the last pass, to pick up late changes

// Everything below works on one account: `uid` is in every query.
const kvGet = async (db, uid, k) => {
  const r = await db.prepare('SELECT v FROM kv WHERE user_id = ? AND k = ?').bind(uid, k).first();
  return r ? JSON.parse(r.v) : null;
};
const kvSet = (db, uid, k, v) =>
  db.prepare('INSERT INTO kv (user_id, k, v) VALUES (?3, ?1, ?2) ON CONFLICT(user_id, k) DO UPDATE SET v = ?2').bind(k, JSON.stringify(v), uid).run();

async function takeLock(db, uid, now) {
  const r = await db
    .prepare("INSERT INTO kv (user_id, k, v) VALUES (?3, 'import_lock', ?1) ON CONFLICT(user_id, k) DO UPDATE SET v = ?1 WHERE CAST(kv.v AS INTEGER) < ?2")
    .bind(String(now + LOCK_MS), now, uid)
    .run();
  return r.meta.changes > 0;
}
const dropLock = (db, uid) => db.prepare("DELETE FROM kv WHERE user_id = ? AND k = 'import_lock'").bind(uid).run();

const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
// Past the last page some CoinDCX lists answer with an error instead of an empty page.
const endOfList = (e) => e && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;

async function existing(db, uid, table, col, extra, ids) {
  const out = new Map();
  for (const part of chunk(ids, 90)) {
    if (!part.length) continue;
    const q = `SELECT ${col} AS id${extra ? `, ${extra} AS x` : ''} FROM ${table} WHERE user_id = ? AND ${col} IN (${part.map(() => '?').join(',')})`;
    const r = await db.prepare(q).bind(uid, ...part).all();
    for (const row of r.results) out.set(row.id, extra ? row.x : true);
  }
  return out;
}

const ORDER_SQL = `INSERT INTO orders (user_id, id, pair, mcur, side, qty, price, fee, lev, otype, stage, status, created_at, updated_at)
  VALUES (?14, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
  ON CONFLICT(user_id, id) DO UPDATE SET qty = ?5, price = ?6, fee = ?7, lev = ?8, stage = ?10, status = ?11, updated_at = ?13`;
const TX_SQL = `INSERT OR IGNORE INTO txs (user_id, k, pair, mcur, order_id, stage, amount, fee, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const TRIGGER_SQL = `INSERT INTO triggers (user_id, id, pair, mcur, side, kind, price, status, created_at, updated_at)
  VALUES (?10, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  ON CONFLICT(user_id, id) DO UPDATE SET price = ?6, status = ?7, updated_at = ?9`;
const TRADE_SQL = `INSERT INTO trades (user_id, id, pair, sym, base, mcur, side, open_ts, close_ts, qty, entry, exit, pnl, fees, funding, net, lev, entry_type, exit_kind, orders, pnl_source)
  VALUES (?21, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
  ON CONFLICT(user_id, id) DO UPDATE SET close_ts = ?8, qty = ?9, entry = ?10, exit = ?11, pnl = ?12, fees = ?13, funding = ?14, net = ?15,
    lev = ?16, entry_type = ?17, exit_kind = ?18, orders = ?19, pnl_source = ?20`;

function touch(run, rows) {
  for (const r of rows) {
    const key = `${r.pair}|${r.mcur}`;
    if (r.pair && !run.touched.includes(key)) run.touched.push(key);
  }
}

/** Ask CoinDCX with both margin currencies; if the account rejects that, fall back to USDT only. */
async function ask(st, fn) {
  const mcur = st.mcur || ['USDT', 'INR'];
  try {
    const rows = await fn(mcur);
    st.mcur = mcur;
    return rows;
  } catch (e) {
    if (!st.mcur && endOfList(e)) {
      st.mcur = ['USDT'];
      return fn(st.mcur);
    }
    throw e;
  }
}

async function ordersPage(db, uid, api, run, st) {
  let rows;
  try {
    rows = await ask(st, (mcur) => api.orders({ side: run.side, page: run.page, size: PAGE, mcur }));
  } catch (e) {
    if (run.page > 1 && endOfList(e)) rows = [];
    else throw e;
  }
  if (!Array.isArray(rows)) throw new Error('CoinDCX sent an unexpected order list.');
  const list = rows.map((o) => normOrder(o)).filter((o) => o.id && o.pair);
  const nextSide = () => {
    Object.assign(run, run.side === 'buy' ? { side: 'sell', page: 1, desc: null, jumped: false } : { phase: 'txs', page: 1, desc: null, jumped: false });
  };
  if (!list.length) return nextSide();
  if (run.desc === null && list.length >= 2) run.desc = list[0].created_at >= list[list.length - 1].created_at;

  const known = await existing(db, uid, 'orders', 'id', 'updated_at', list.map((o) => o.id));
  const changed = list.filter((o) => !known.has(o.id) || known.get(o.id) < o.updated_at);
  if (changed.length) {
    for (const part of chunk(changed, 50)) {
      await db.batch(part.map((o) => db.prepare(ORDER_SQL).bind(o.id, o.pair, o.mcur, o.side, o.qty, o.price, o.fee, o.lev, o.otype, o.stage, o.status, o.created_at, o.updated_at, uid)));
    }
    run.newOrders += changed.filter((o) => !known.has(o.id)).length;
    touch(run, changed);
  }
  if (run.desc === false) {
    // Oldest first: skip the pages that are already stored, then read to the end.
    if (!run.jumped) {
      run.jumped = true;
      const n = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND side = ?').bind(uid, run.side).first('n');
      const skipTo = Math.floor(n / PAGE);
      if (skipTo > run.page) { run.page = skipTo; return; }
    }
    run.page++;
    return;
  }
  // Newest first (the usual case): a page that reaches stored orders means everything older is stored.
  if (known.size > 0) return nextSide();
  run.page++;
}

async function txPage(db, uid, api, run, st) {
  let rows;
  try {
    rows = await ask(st, (mcur) => api.transactions({ page: run.page, size: PAGE, mcur }));
  } catch (e) {
    if (run.page > 1 && endOfList(e)) rows = [];
    else throw e;
  }
  if (!Array.isArray(rows)) throw new Error('CoinDCX sent an unexpected list of trade records.');
  const list = rows.map((t) => normTx(t)).filter((t) => t.created_at > 0);
  const finish = () => Object.assign(run, { phase: 'rebuild', page: 1, desc: null, jumped: false });
  if (!list.length) return finish();
  if (run.desc === null && list.length >= 2) run.desc = list[0].created_at >= list[list.length - 1].created_at;

  const known = await existing(db, uid, 'txs', 'k', null, list.map((t) => t.k));
  const fresh = list.filter((t) => !known.has(t.k));
  if (fresh.length) {
    for (const part of chunk(fresh, 50)) {
      await db.batch(part.map((t) => db.prepare(TX_SQL).bind(uid, t.k, t.pair, t.mcur, t.order_id, t.stage, t.amount, t.fee, t.created_at)));
    }
    run.newTxs += fresh.length;
    touch(run, fresh);
  }
  if (run.desc === false) {
    if (!run.jumped) {
      run.jumped = true;
      const n = await db.prepare('SELECT COUNT(*) AS n FROM txs WHERE user_id = ?').bind(uid).first('n');
      const skipTo = Math.floor(n / PAGE);
      if (skipTo > run.page) { run.page = skipTo; return; }
    }
    run.page++;
    return;
  }
  if (known.size > 0) return finish();
  run.page++;
}

/**
 * One page of stop-loss / take-profit orders. This step can't fail an import: if CoinDCX refuses a
 * status group, that group is skipped until the next import and the reason is kept in st.trig.errors.
 */
async function trigPage(db, uid, api, run, st) {
  const tg = st.trig || (st.trig = {});
  tg.since = tg.since || {};
  tg.errors = tg.errors || {};
  const r = run.trig || (run.trig = { g: 0, side: 'buy', page: 1, newest: 0 });
  const group = TRIG_GROUPS[r.g];
  if (!group) { run.phase = 'done'; return; }
  const nextGroup = () => Object.assign(r, { g: r.g + 1, side: 'buy', page: 1, newest: 0 });
  const nextSide = () => {
    if (r.side === 'buy') return Object.assign(r, { side: 'sell', page: 1 });
    if (r.newest) tg.since[group] = Math.max(tg.since[group] || 0, r.newest);
    delete tg.errors[group];
    nextGroup();
  };
  let rows;
  try {
    rows = await ask(st, (mcur) => api.orders({ side: r.side, page: r.page, size: PAGE, mcur, status: group }));
  } catch (e) {
    if (r.page > 1 && endOfList(e)) return nextSide();
    tg.errors[group] = String((e && e.message) || e).slice(0, 200);
    return nextGroup();
  }
  if (!Array.isArray(rows) || !rows.length) return nextSide();
  const found = [];
  let oldest = Infinity;
  for (const o of rows) {
    const created = Number(o.created_at) || 0;
    if (created) { oldest = Math.min(oldest, created); r.newest = Math.max(r.newest, created); }
    const t = normTrigger(o);
    if (t) found.push(t);
    if (group.startsWith('filled')) found.push(...attachedTriggers(o));
  }
  try {
    for (const part of chunk(found, 50)) {
      await db.batch(part.map((t) => db.prepare(TRIGGER_SQL).bind(t.id, t.pair, t.mcur, t.side, t.kind, t.price, t.status, t.created_at, t.updated_at, uid)));
    }
  } catch (e) {
    tg.errors[group] = String((e && e.message) || e).slice(0, 200);
    return nextGroup();
  }
  // Newest-first lists stop once they reach orders from before the previous pass; others are read to the end.
  const newestFirst = rows.length < 2 || Number(rows[0].created_at) >= Number(rows[rows.length - 1].created_at);
  const since = tg.since[group] || 0;
  if (newestFirst && since && oldest < since - TRIG_OVERLAP) return nextSide();
  if (++r.page > 400) nextSide();
}

/** Rebuild the closed trades of one coin from everything stored for it. Notes live in another table and are untouched. */
export async function rebuildPair(db, uid, key) {
  const [pair, mcur] = key.split('|');
  const [o, t, ex] = await db.batch([
    db.prepare('SELECT * FROM orders WHERE user_id = ? AND pair = ? AND mcur = ?').bind(uid, pair, mcur),
    db.prepare('SELECT order_id, stage, amount, fee, created_at FROM txs WHERE user_id = ? AND pair = ? AND mcur = ?').bind(uid, pair, mcur),
    db.prepare('SELECT id FROM trades WHERE user_id = ? AND pair = ? AND mcur = ?').bind(uid, pair, mcur),
  ]);
  const trades = buildTrades(o.results, t.results);
  const keep = new Set(trades.map((x) => x.id));
  const stmts = ex.results.filter((r) => !keep.has(r.id)).map((r) => db.prepare('DELETE FROM trades WHERE user_id = ? AND id = ?').bind(uid, r.id));
  for (const x of trades) {
    stmts.push(db.prepare(TRADE_SQL).bind(x.id, x.pair, x.sym, x.base, x.mcur, x.side, x.open_ts, x.close_ts, x.qty, x.entry, x.exit,
      x.pnl, x.fees, x.funding, x.net, x.lev, x.entry_type, x.exit_kind, x.orders, x.pnl_source, uid));
  }
  for (const part of chunk(stmts, 50)) await db.batch(part);
}

/**
 * One step of the import. Returns { done, newTrades?, busy?, noKey? }.
 * The caller keeps calling while done is false.
 */
export async function importStep(env, uid, api, now = Date.now()) {
  const db = env.DB;
  if (!api.hasKey) return { done: true, noKey: true };
  if (!(await takeLock(db, uid, now))) return { done: false, busy: true };
  let st = null;
  try {
    st = (await kvGet(db, uid, 'import')) || {};
    if (!st.run) {
      const before = await db.prepare('SELECT COUNT(*) AS n FROM trades WHERE user_id = ?').bind(uid).first('n');
      st.run = { phase: 'orders', side: 'buy', page: 1, desc: null, jumped: false, touched: [], newOrders: 0, newTxs: 0, before, started: now };
    }
    const run = st.run;
    let pages = 0;
    while (run.phase !== 'done') {
      if (run.phase === 'orders' || run.phase === 'txs') {
        if (pages >= PAGES_PER_CALL) break;
        pages++;
        await (run.phase === 'orders' ? ordersPage(db, uid, api, run, st) : txPage(db, uid, api, run, st));
        if (run.page > 400) throw new Error('CoinDCX kept sending pages. The import stopped to be safe.');
      } else if (run.phase === 'trig') {
        if (pages >= PAGES_PER_CALL) break;
        pages++;
        await trigPage(db, uid, api, run, st);
      } else {
        for (const key of run.touched.splice(0, PAIRS_PER_CALL)) await rebuildPair(db, uid, key);
        if (run.touched.length) break;
        run.phase = 'trig';
      }
    }
    if (run.phase !== 'done') {
      await kvSet(db, uid, 'import', st);
      return { done: false, phase: run.phase };
    }
    const after = await db.prepare('SELECT COUNT(*) AS n FROM trades WHERE user_id = ?').bind(uid).first('n');
    st.lastAt = now;
    st.lastResult = { newTrades: Math.max(0, after - run.before), newOrders: run.newOrders, at: now };
    st.lastError = null;
    st.run = null;
    await kvSet(db, uid, 'import', st);
    return { done: true, ...st.lastResult };
  } catch (e) {
    if (st) {
      st.lastError = { message: String(e.message || e), at: now };
      await kvSet(db, uid, 'import', st).catch(() => {});
    }
    throw e;
  } finally {
    await dropLock(db, uid).catch(() => {});
  }
}

/** Forget everything imported (notes and day journals stay) so the next import starts from scratch. */
export async function resetImport(db, uid) {
  await db.batch([
    db.prepare('DELETE FROM orders WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM txs WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM trades WHERE user_id = ?').bind(uid),
    db.prepare('DELETE FROM triggers WHERE user_id = ?').bind(uid),
    db.prepare("DELETE FROM kv WHERE user_id = ? AND k IN ('import', 'import_lock')").bind(uid),
  ]);
}

export async function importInfo(db, uid) {
  const st = (await kvGet(db, uid, 'import')) || {};
  const levelErrors = st.trig && Object.keys(st.trig.errors || {}).length ? st.trig.errors : null;
  return { lastAt: st.lastAt || null, lastResult: st.lastResult || null, lastError: st.lastError || null, running: Boolean(st.run), levelErrors };
}
