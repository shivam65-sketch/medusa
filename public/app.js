/* Medusa: one-page trading journal. Data comes from the Worker's /api; the math lives in stats.js (window.JournalStats). */
(() => {
  'use strict';
  const S = window.JournalStats;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const pad = S.pad;

  /* ---------- icons ---------- */
  const ICONS = {
    bank: '<path d="M3 20.5h18M5.5 20.5V10.5M9.8 20.5V10.5M14.2 20.5V10.5M18.5 20.5V10.5M2.5 10.5 12 4l9.5 6.5z"/>',
    percent: '<path d="M18.5 5.5l-13 13"/><circle cx="7" cy="7" r="2.3"/><circle cx="17" cy="17" r="2.3"/>',
    factor: '<path d="M14 10l6.5-6.5M14 10V5.2M14 10h4.8M10 14l-6.5 6.5M10 14v4.8M10 14H5.2"/>',
    up: '<path d="M3 16.5l6-6 4 4 8-8"/><path d="M15.5 6.5H21V12"/>',
    down: '<path d="M3 7.5l6 6 4-4 8 8"/><path d="M15.5 17.5H21V12"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    recover: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4.5 4.5v4h4"/>',
    sharpe: '<path d="M4 20h16"/><path d="M5.5 16l4-5 3 3 5.5-7.5"/><path d="M15 6.5h3v3"/>',
    dot: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
    chart: '<path d="M7 4v3M7 17v3M17 3v4M17 15v5"/><rect x="5" y="7" width="4" height="10" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/>',
    calc: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M8.5 6.5h7M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18.5h.01M12 18.5h3.5"/>',
  };
  const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const store = {
    get(k, d) { try { const v = localStorage.getItem('j.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('j.' + k, JSON.stringify(v)); } catch { /* optional */ } },
  };

  /* ---------- logs (the Logs page) ---------- */
  // Short lines about what happened, sent to MEDUSA in small batches (and when the page is hidden). "debug"
  // lines are kept only with detailed logging on (Logs page). Anything that looks like a key, password or code
  // is removed before it leaves the page. Each line has its own id, so a batch sent twice is stored once.
  const LOG = { buf: [], timer: null, on: false, verbose: store.get('logVerbose', false) };
  const SECRET = /key|secret|pass|token|code|otp|recovery|cookie|session/i;
  function scrub(v, depth = 0) {
    if (v == null || depth > 3) return v ?? null;
    if (Array.isArray(v)) return v.slice(0, 30).map((x) => scrub(x, depth + 1));
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, SECRET.test(k) ? '[removed]' : scrub(x, depth + 1)]));
    return typeof v === 'string' ? v.slice(0, 400) : v;
  }
  const lineId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => (b % 36).toString(36)).join('');
  function log(area, msg, data = null, level = 'info') {
    if (level === 'debug' && !LOG.verbose) return;
    LOG.buf.push({ cid: lineId(), at: Date.now(), level, area: String(area).slice(0, 20), msg: String(msg).slice(0, 400), data: data ? scrub(data) : null });
    if (LOG.buf.length > 500) LOG.buf.splice(0, LOG.buf.length - 500);
    clearTimeout(LOG.timer);
    LOG.timer = setTimeout(() => flushLogs(), LOG.buf.length >= 30 ? 0 : 4000);
  }
  const ERRORS = [];
  function noteError(msg, where) {
    ERRORS.push({ at: Date.now(), msg: String(msg || 'Error').slice(0, 300), where: where ? String(where).slice(0, 200) : '' });
    if (ERRORS.length > 30) ERRORS.shift();
    if (ERRORS.length <= 10) log('error', String(msg || 'Error').slice(0, 300), where ? { where } : null, 'error');
  }
  addEventListener('error', (e) => { if (e.message) noteError(e.message, e.filename ? `${e.filename.replace(location.origin, '')}:${e.lineno}` : ''); });
  const signedOutError = (r) => { try { return r instanceof SignedOut; } catch { return false; } };   // (defined further down)
  addEventListener('unhandledrejection', (e) => { const r = e.reason; if (!signedOutError(r) && !(r && r.stopped)) noteError(r && r.message ? r.message : String(r), 'promise'); });
  async function flushLogs(keepalive = false) {
    if (!LOG.on || !LOG.buf.length) return;
    const batch = LOG.buf.splice(0, 100);
    try {
      const r = await fetch('/api/logs', {
        method: 'POST', keepalive, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'journal' },
        body: JSON.stringify({ entries: batch, tz: -new Date().getTimezoneOffset() }),
      });
      if (!r.ok && r.status !== 401) throw new Error(String(r.status));
    } catch { LOG.buf.unshift(...batch); }                 // kept and sent with the next batch (stored once)
    if (LOG.buf.length) LOG.timer = setTimeout(() => flushLogs(), 8000);
  }

  /* ---------- money: USDT, or INR with the INR switch (CoinDCX's USDT/INR rate) ---------- */
  const fxListeners = [];
  const fxRate = () => (state.fx.on && state.fx.rate > 0 ? state.fx.rate : null);
  const fxJ = () => (state.mcur !== 'INR' ? fxRate() : null);          // INR-margined trades are already in rupees
  const cur = () => (fxJ() || state.mcur === 'INR' ? '₹' : '$');
  function money(v, dp = 2) {
    if (!isNum(v)) return '-';
    const r = fxJ();
    if (r) v *= r;
    const a = Math.abs(v);
    const s = a.toLocaleString(cur() === '₹' ? 'en-IN' : 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return (v < 0 ? '-' : '') + cur() + s;
  }
  const moneyAxis = (v, span) => money(v, span * (fxJ() || 1) >= 1000 ? 0 : 2);
  const cls = (v) => (isNum(v) && v !== 0 ? (v > 0 ? 'pos' : 'neg') : '');
  function price(v) {
    if (!isNum(v)) return '-';
    const r = fxJ();
    if (r) v *= r;
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(r ? 'en-IN' : 'en-US', { maximumFractionDigits: 2 });
    if (a === 0) return '0';
    return String(Number(v.toFixed(a >= 1 ? 4 : Math.min(12, -Math.floor(Math.log10(a)) + 4))));
  }
  const qty = (v) => (isNum(v) ? String(Number(v.toPrecision(10))) : '-');
  function dur(ms) {
    if (!isNum(ms)) return '0m';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return d + 'd' + (hh ? ' ' + hh + 'h' : '');
  }
  const dateShort = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const dateFull = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const dateTime = (ms) => { const d = new Date(ms); return `${dateShort(ms)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function ago(ms) {
    if (!isNum(ms)) return 'never';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return dateTime(ms);
  }
  function isoWeek(ms) {
    const d = new Date(ms);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }
  const coin = (t, big) => `<img class="coin${big ? ' lg' : ''}" src="/logo/${encodeURIComponent(t.base)}" alt="" loading="lazy" width="${big ? 32 : 22}" height="${big ? 32 : 22}">`;
  const side = (t) => `<span class="side ${t.side === 'short' ? 'short' : 'long'}">${t.side === 'short' ? 'Short' : 'Long'}</span>`;

  /* ---------- API ---------- */
  class SignedOut extends Error {}
  const AUTH_PATHS = new Set(['/api/login', '/api/signup', '/api/recover']); // a 401 there is a wrong password, not a lost session
  async function call(method, path, body) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Requested-With'] = 'journal';
      if (body !== undefined) opts.body = JSON.stringify(body);
    }
    let r;
    const t0 = performance.now();
    try { r = await fetch(path, opts); } catch { log('api', `${method} ${path.split('?')[0]}: no connection`, null, 'error'); throw new Error("Couldn't reach your journal. Check your connection."); }
    log('api', `${method} ${path.split('?')[0]} → ${r.status} (${Math.round(performance.now() - t0)} ms)`, null, 'debug');
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !AUTH_PATHS.has(path)) { showLogin(); throw new SignedOut('Signed out'); }
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status}).`), { status: r.status, data });
    return data;
  }

  /* ---------- state ---------- */
  const PRESETS = S.PERIODS.filter((p) => p.id !== 'custom');
  const state = {
    loaded: false, raw: [], notes: new Map(), importInfo: {}, hasKey: false, cdx: {}, settings: {}, name: '', account: null,
    trades: [], mcur: 'USDT', mcurs: ['USDT'], fx: { on: false, rate: null, at: null },
    period: 'all', range: null, perf: 'pnl', cal: null, day: null, limit: 25, importing: false,
    pv: null, symOff: 0, // what the performance chart shows ({ t0, t1 } in ms; null = default) and how far the coin chart is moved
  };
  let memo = null;

  /* What each number means, for the (i) buttons. */
  const INFO = {
    net: ['Net PnL', 'Your total profit or loss from the closed trades in this range, after trading fees and funding. Under it, the same trades before fees and funding.'],
    win: ['Win rate', 'The share of trades that made money. Trades that closed at exactly zero are left out.'],
    pf: ['Profit factor', 'Money made on winning trades divided by money lost on losing trades. Above 1 means you made more than you lost.'],
    avg: ['Average win and loss', 'The average profit of a winning trade and the average loss of a losing trade. The number in the title is the first divided by the second.'],
    dd: ['Max drawdown', 'The biggest fall in your running profit, from a high point down to a later low, within this range.'],
    daily: ['Daily PnL', 'Your average net profit per trading day: the total divided by the number of days on which you closed a trade.'],
    best: ['Best trade', 'Your most profitable single trade in this range.'],
    worst: ['Worst trade', 'Your biggest losing single trade in this range.'],
    windays: ['Winning days', 'The share of your trading days that ended in profit.'],
    fees: ['Total commissions', 'All the trading fees you paid on these trades. Funding payments are not included.'],
    sharpe: ['Sharpe ratio', 'How steady your daily results are: average daily profit divided by how much it swings from day to day, scaled to a year. Days without trades count as zero. Higher is steadier.'],
    tpd: ['Average trades per day', 'How many trades you closed on an average trading day.'],
    hold: ['Average trade length', 'How long your positions stayed open, on average.'],
    recovery: ['Recovery factor', 'Net profit divided by the max drawdown. Above 1 means your profit is bigger than your worst fall.'],
    wins: ['Max consecutive wins', 'Your longest run of winning trades in a row. A trade that closed at exactly zero ends a run.'],
    losses: ['Max consecutive losses', 'Your longest run of losing trades in a row. A trade that closed at exactly zero ends a run.'],
    activity: ['Activity period', 'The number of days from your first to your last trade in this range, counting both.'],
    lasttrade: ['Last trade date', 'When the most recent trade in this range closed.'],
  };
  const infoBtn = (key) => `<button class="info" type="button" data-action="info" data-info="${key}" aria-label="${esc(INFO[key][0] + ': ' + INFO[key][1])}">${icon('info')}</button>`;

  function build() {
    const list = state.raw.map((t) => {
      const n = state.notes.get(t.id) || {};
      const d = S.derive({ id: t.id, sym: t.sym, side: t.side, entryAt: t.open_ts, exitAt: t.close_ts, entry: t.entry, exit: t.exit, qty: t.qty, fees: t.fees, pnl: t.net });
      return Object.assign(d, { base: t.base, pair: t.pair, mcur: t.mcur, gross: t.pnl, funding: t.funding, lev: t.lev, exitKind: t.exit_kind, orders: t.orders, note: n });
    });
    list.sort((a, b) => a.closeAt - b.closeAt || (a.id < b.id ? -1 : 1));
    state.trades = list;
    const counts = {};
    list.forEach((t) => { counts[t.mcur] = (counts[t.mcur] || 0) + 1; });
    state.mcurs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (!state.mcurs.length) state.mcurs = ['USDT'];
    if (!state.mcurs.includes(state.mcur)) state.mcur = state.mcurs[0];
    memo = null;
  }

  /* Everything the page shows for the chosen period. */
  function current() {
    if (memo) return memo;
    const range = S.periodRange(state.period, Date.now(), state.range);
    const all = state.trades.filter((t) => t.mcur === state.mcur);
    const trades = all.filter((t) => t.closeAt >= range.from && t.closeAt < range.to);
    const s = S.summarize(trades, null);
    const days = S.byDay(trades);
    const keys = Object.keys(days).sort();
    const tradingDays = keys.length;
    let sharpe = null, activity = null;
    if (trades.length) {
      const first = S.startOfDay(trades[0].closeAt), last = S.startOfDay(trades[trades.length - 1].closeAt);
      const series = [];
      for (let d = first; d <= last; d = S.addDays(d, 1)) series.push(days[S.dayKey(d)] ? days[S.dayKey(d)].net : 0);
      activity = series.length;
      if (series.length > 1) {
        const mean = series.reduce((a, b) => a + b, 0) / series.length;
        const sd = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1));
        sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
      }
    }
    const holds = trades.map((t) => t.hold).filter(isNum);
    // A day picked on the calendar narrows the charts and the trade history (the KPIs keep the whole range).
    const shown = state.day ? trades.filter((t) => S.dayKey(t.closeAt) === state.day) : trades;
    memo = {
      all, trades, s, days, range, shown, shownDays: state.day ? S.byDay(shown) : days,
      tradingDays,
      dailyAvg: tradingDays ? s.net / tradingDays : 0,
      winningDays: tradingDays ? keys.filter((k) => days[k].net > 0).length / tradingDays : 0,
      tradesPerDay: tradingDays ? trades.length / tradingDays : 0,
      avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      recovery: s.maxDD > 0 ? s.net / s.maxDD : null,
      sharpe, activity,
      lastTrade: trades.length ? trades[trades.length - 1].closeAt : null,
    };
    return memo;
  }

  /* ---------- date range ---------- */
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && S.dayKey(S.parseDay(s)) === s;
  const validRange = (r) => Boolean(r && isDay(r.from) && isDay(r.to) && r.from <= r.to);

  /* What the date button says: the preset's name, or the custom dates. */
  function rangeLabel() {
    if (state.period !== 'custom') return (PRESETS.find((p) => p.id === state.period) || PRESETS[PRESETS.length - 1]).label;
    const a = S.parseDay(state.range.from), b = S.parseDay(state.range.to), da = new Date(a), db = new Date(b);
    if (da.getFullYear() !== db.getFullYear()) return `${dateFull(a)} – ${dateFull(b)}`;
    const end = db.getFullYear() === new Date().getFullYear() ? dateShort(b) : dateFull(b); // no year for this year's dates
    if (a === b) return end;
    return `${da.getMonth() === db.getMonth() ? da.getDate() : dateShort(a)} – ${end}`;
  }

  /* The calendar shows the month the range ends in (this month for ranges that run to today). */
  function endMonth() {
    const r = S.periodRange(state.period, Date.now(), state.range);
    const d = new Date(Math.min(r.to - 1, Date.now()));
    return { y: d.getFullYear(), m: d.getMonth() };
  }

  function setPeriod(period, range = null) {
    state.period = period;
    state.range = period === 'custom' ? range : null;
    state.day = null;
    state.limit = 25;
    state.pv = null;
    state.symOff = 0;
    state.cal = endMonth();
    store.set('period', state.period);
    store.set('range', state.range);
    setRangePop(false);
    render();
  }

  /* Opening the panel fills in the dates the current range covers, so they're easy to adjust. */
  function setRangePop(open) {
    const pop = $('#range-pop');
    if (open === !pop.hidden) return;
    if (open) {
      const now = Date.now(), today = S.dayKey(now);
      const r = S.periodRange(state.period, now, state.range);
      const first = current().all[0];
      $('#range-from').value = Number.isFinite(r.from) ? S.dayKey(r.from) : S.dayKey(first ? first.closeAt : now);
      $('#range-to').value = Number.isFinite(r.to) ? S.dayKey(r.to - 1) : today;
      $('#range-from').max = today;
      $('#range-to').max = today;
      $('#range-err').hidden = true;
      $$('#range-presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === state.period)));
    }
    pop.hidden = !open;
    $('#range-btn').setAttribute('aria-expanded', String(open));
  }

  function applyRange() {
    let from = $('#range-from').value, to = $('#range-to').value;
    if (!isDay(from) || !isDay(to)) {
      $('#range-err').textContent = 'Pick a start date and an end date.';
      $('#range-err').hidden = false;
      return;
    }
    if (from > to) [from, to] = [to, from];
    setPeriod('custom', { from, to });
  }

  /* The sign-in page only says good morning/afternoon/evening; your name appears once you're signed in. */
  function paintGreeting() {
    const now = Date.now(), d = new Date(now), hello = S.greeting(now);
    const who = state.name ? `, <b>${esc(state.name)}</b>` : '';
    const add = !state.name && state.loaded ? '<button class="link" type="button" data-action="name">Add your name</button>' : '';
    $('#greet').innerHTML = `<span class="hello">${hello}${who}</span><span class="date">${WEEKDAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}</span>${add}`;
    $('#login-greet').textContent = hello;
  }

  function openName() {
    openId = null;
    showModal(`<div class="modal-head"><h2 id="modal-title">Your name</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <form class="modal-body" id="name-form" novalidate>
        <label><span class="label">What should Medusa call you?</span><input class="input" id="name-input" maxlength="40" autocomplete="given-name" value="${esc(state.name)}"></label>
        <p class="dim small">It shows in the greeting at the top once you're signed in. Leave it empty to remove it.</p>
        <button type="submit" hidden></button>
      </form>
      <div class="modal-foot"><button class="btn" data-action="close">Cancel</button><button class="btn btn-green" data-action="save-name" id="save-name">Save</button></div>`);
    setTimeout(() => { const i = $('#name-input'); if (i) i.focus(); }, 30);
  }

  async function saveName() {
    const btn = $('#save-name');
    btn.disabled = true;
    try {
      const res = await call('PUT', '/api/settings', { ...state.settings, name: $('#name-input').value.trim().slice(0, 40) });
      state.settings = res.settings || {};
      state.name = state.settings.name || '';
      store.set('name', state.name);
      closeTrade();
      paintGreeting();
      toast(state.name ? `Nice to meet you, ${state.name}` : 'Name removed');
    } catch (e) {
      btn.disabled = false;
      if (!(e instanceof SignedOut)) toast(e.message, 'error');
    }
  }

  /* ---------- accounts: sign in, sign up, recovery ---------- */
  // New accounts go: create account -> save the recovery code -> connect CoinDCX -> import (on request) -> journal.
  const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
  const auth = { mode: 'signin', email: '', password: '', code: '', next: 'app', hint: '' }; // password is kept only while the two-step code is asked
  const field = (id, label, type, ac, extra = '', hint = '') =>
    `<label><span class="label">${label}</span><input class="input" id="${id}" type="${type}" autocomplete="${ac}" autocapitalize="off" spellcheck="false" ${extra}>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  const codeField = (id, label = 'Code') => field(id, label, 'text', 'one-time-code', 'inputmode="numeric" maxlength="7"');
  const val = (id) => { const el = $('#' + id); return el ? el.value : ''; };

  function recoveryHTML(code, note = '') {
    return `<div class="stack">
      ${note ? `<div class="box small">${note}</div>` : ''}
      <p class="dim small">This recovery code is the only way back in if you forget your password or lose your phone. Nobody can reset your account without it, and it is shown only now.</p>
      <div class="code-box" id="rc-code">${esc(code)}</div>
      <div class="row-btns"><button class="btn btn-sm" type="button" data-action="copy" data-copy="rc-code">Copy</button><button class="btn btn-sm" type="button" data-action="download-code">Download as a file</button></div>
      <label class="check"><input type="checkbox" id="rc-ok"><span>I saved my recovery code somewhere safe, like a password manager or on paper.</span></label>
    </div>`;
  }

  function renderAuth(mode, note = '') {
    auth.mode = mode;
    if (mode !== 'code') auth.password = '';
    $('#login-sub').textContent = {
      signin: 'Sign in to your trading journal.', code: 'One more step.', signup: 'Create your free account.',
      recover: 'Reset your password with your recovery code.', saved: 'Save your recovery code.',
      connect: 'Connect your CoinDCX account.', import: 'Bring in your trades.',
    }[mode];
    const links = (...l) => `<div class="auth-links">${l.map(([m, t]) => `<button class="link" type="button" data-action="auth" data-mode="${m}">${t}</button>`).join('')}</div>`;
    const form = (body, button, foot) => `<form class="auth-form" id="auth-form" novalidate>${body}<div class="err" id="a-err" role="alert" hidden></div>
      <button class="btn btn-green" type="submit" id="a-btn">${button}</button>${foot}</form>`;
    let html;
    const emailField = (value = '') => field('a-email', 'Email', 'email', 'email', `value="${esc(value)}" maxlength="254" inputmode="email"`);
    const steps = (n) => `<div class="faint small">Step ${n} of 3</div>`;
    if (mode === 'signin') {
      html = form(emailField(auth.email) + field('a-pw', 'Password', 'password', 'current-password', 'maxlength="200"'),
        'Sign in', links(['signup', 'Create an account'], ['recover', 'Forgot password?']));
    } else if (mode === 'code') {
      html = form(`<p class="dim small">Two-step login is on for <b>${esc(auth.email)}</b>. Open your authenticator app and type the 6-digit code for MEDUSA.</p>${codeField('a-code')}`,
        'Verify', links(['signin', 'Back'], ['recover', 'Lost your phone?']));
    } else if (mode === 'signup') {
      html = form(steps(1) + field('a-name', 'Your name', 'text', 'given-name', 'maxlength="40" autocapitalize="words"', 'Used to greet you on your dashboard.')
        + emailField()
        + field('a-pw', 'Password', 'password', 'new-password', 'maxlength="200"', 'At least 12 characters. A short sentence is easy to remember and hard to guess.')
        + field('a-pw2', 'Password again', 'password', 'new-password', 'maxlength="200"'),
        'Create account', links(['signin', 'I already have an account']));
    } else if (mode === 'recover') {
      html = form(`<p class="dim small">Use the recovery code you saved when you created your account. It also turns two-step login off, so it works if you lost your phone too.</p>`
        + emailField(auth.email)
        + field('a-rc', 'Recovery code', 'text', 'off', 'placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" maxlength="40"')
        + field('a-pw', 'New password (at least 12 characters)', 'password', 'new-password', 'maxlength="200"')
        + field('a-pw2', 'New password again', 'password', 'new-password', 'maxlength="200"'),
        'Reset password', links(['signin', 'Back to sign in']));
    } else if (mode === 'saved') {
      const next = auth.next === 'connect'
        ? '<button class="btn btn-green" type="button" data-action="auth" data-mode="connect" data-needs-saved disabled>Next: connect CoinDCX</button>'
        : '<button class="btn btn-green" type="button" data-action="auth-done" data-needs-saved disabled>Open my journal</button>';
      html = `<div class="auth-form">${auth.next === 'connect' ? steps(2) : ''}${recoveryHTML(auth.code, note)}${next}</div>`;
    } else if (mode === 'connect') {
      html = form(steps(3) + `<p class="dim small">MEDUSA imports your closed CoinDCX futures trades with a read-only key. On coindcx.com open <b>API dashboard → Create API key</b>, make a new key just for MEDUSA, and leave <b>Bind IP address</b> unticked. Then paste the key and secret here.</p>`
        + field('a-key', 'API key', 'password', 'off', 'maxlength="200" placeholder="Paste your CoinDCX API key"')
        + field('a-secret', 'API secret', 'password', 'off', 'maxlength="200" placeholder="Paste your CoinDCX API secret"')
        + `<div id="a-pw-wrap" hidden>${field('a-pw', 'Your MEDUSA password', 'password', 'current-password', 'maxlength="200"', 'Asked because you signed in a while ago.')}</div>`
        + `<div class="box safety small"><ul><li>Checked with CoinDCX before anything is saved.</li><li>Stored encrypted; never shown again or sent back to your browser.</li><li>MEDUSA can only read your trade history. It has no code that places orders or moves money.</li></ul></div>`,
        'Connect', `<div class="auth-links"><button class="link" type="button" data-action="auth-done">Skip for now</button></div>`);
    } else {
      html = `<div class="auth-form"><div class="status-line"><span class="dot on"></span>CoinDCX connected${auth.hint ? ` · key ending ••••${esc(auth.hint)}` : ''}</div>
        <p class="dim small">Import your trade history now? The first import reads all your closed futures trades and can take up to a minute. After that, MEDUSA only imports when you press <b>Import</b>.</p>
        <button class="btn btn-green" type="button" data-action="auth-import">Import my trades</button>
        <div class="auth-links"><button class="link" type="button" data-action="auth-done">Not now</button></div></div>`;
    }
    $('#auth').innerHTML = html;
    setTimeout(() => { const i = $('#auth input:not([type=checkbox])'); if (i) (i.value && i.id === 'a-email' ? $('#a-pw') || i : i).focus(); }, 30);
  }

  function authError(msg) {
    const err = $('#a-err');
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

  async function submitAuth() {
    const btn = $('#a-btn'), label = btn.textContent;
    $('#a-err').hidden = true;
    const email = val('a-email').trim().toLowerCase(), pw = val('a-pw'), pw2 = val('a-pw2');
    const busy = (text) => { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${text}`; };
    try {
      if (auth.mode === 'signin') {
        if (!email || !pw) return authError('Type your email and password.');
        busy('Signing in…');
        auth.email = email;
        const res = await call('POST', '/api/login', { email, password: pw });
        if (res.need2fa) { auth.password = pw; return renderAuth('code'); }
        return enterApp();
      }
      if (auth.mode === 'code') {
        const code = val('a-code').replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) return authError('Type the 6-digit code from your authenticator app.');
        busy('Checking…');
        await call('POST', '/api/login', { email: auth.email, password: auth.password, code });
        return enterApp();
      }
      if (auth.mode === 'signup') {
        const name = val('a-name').trim();
        if (!name) return authError('Type your name.');
        if (!EMAIL.test(email)) return authError('Type a valid email address.');
        if (pw.length < 12) return authError('Use at least 12 characters for the password.');
        if (pw !== pw2) return authError("The two passwords don't match.");
        busy('Creating your account…');
        const res = await call('POST', '/api/signup', { name, email, password: pw });
        Object.assign(auth, { email, code: res.recoveryCode, next: 'connect' });
        store.set('name', name.slice(0, 40));
        return renderAuth('saved');
      }
      if (auth.mode === 'recover') {
        const code = val('a-rc');
        if (!email || !code) return authError('Type your email and your recovery code.');
        if (pw.length < 12) return authError('Use at least 12 characters for the new password.');
        if (pw !== pw2) return authError("The two new passwords don't match.");
        busy('Resetting…');
        const res = await call('POST', '/api/recover', { email, code, next: pw });
        Object.assign(auth, { email, code: res.recoveryCode, next: 'app' });
        return renderAuth('saved', `Your password was changed${res.twoStepOff ? ' and two-step login was turned off' : ''}, and every other device was signed out. Your old recovery code no longer works; this is your new one.`);
      }
      if (auth.mode === 'connect') {
        const apiKey = val('a-key').trim(), apiSecret = val('a-secret').trim();
        if (!apiKey || !apiSecret) return authError('Paste both the API key and the API secret.');
        if (!$('#a-pw-wrap').hidden && !pw) return authError('Type your MEDUSA password.');
        busy('Checking with CoinDCX…');
        const res = await call('POST', '/api/coindcx', { apiKey, apiSecret, ...(pw ? { password: pw } : {}) });
        auth.hint = (res.coindcx && res.coindcx.hint) || '';
        return renderAuth('import');
      }
    } catch (e) {
      if (auth.mode === 'connect' && e.data && e.data.needPassword) {
        $('#a-pw-wrap').hidden = false;
        $('#a-pw').focus();
      }
      // A password that stopped working while the code was asked (changed elsewhere): start over.
      if (auth.mode === 'code' && e.status === 401 && !(e.data && e.data.need2fa)) { renderAuth('signin'); return authError(e.message); }
      authError(e.message);
      if (auth.mode === 'code') $('#a-code').value = '';
      else if ($('#a-pw') && (e.status === 401 || e.status === 429)) $('#a-pw').value = '';
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function enterApp(importNow = false) {
    auth.password = '';
    auth.code = '';
    $('#login').hidden = true;
    openApp(importNow, true);
  }

  function copyText(id) {
    const el = $('#' + id);
    if (!el) return;
    const text = el.dataset.raw || el.textContent.trim();
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy. Select the text and copy it yourself.', 'error'));
  }

  function downloadCode() {
    const code = $('#rc-code') ? $('#rc-code').textContent.trim() : '';
    const who = (state.account && state.account.email) || auth.email;
    const text = `MEDUSA recovery code\r\n\r\nEmail: ${who}\r\nRecovery code: ${code}\r\nMade: ${dateFull(Date.now())}\r\n\r\n`
      + `Use it on the sign-in page (Forgot password?) if you forget your password or lose the phone with your authenticator app.\r\n`
      + `Keep it private: with your email address it can reset your account.\r\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `medusa-recovery-${who.replace(/[^a-z0-9._-]+/gi, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- account & security ---------- */
  const acct = { step: null };
  async function refreshAccount() {
    try { state.account = await call('GET', '/api/account'); } catch (e) { if (e instanceof SignedOut) throw e; }
  }
  function acctModal(title, body, foot) {
    openId = null;
    showModal(`<div class="modal-head"><h2 id="modal-title">${title}</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <form class="modal-body" id="acct-form" novalidate>${body}<div class="err" id="m-err" role="alert" hidden></div><button type="submit" hidden></button></form>
      <div class="modal-foot">${foot}</div>`);
    setTimeout(() => { const i = $('#acct-form input:not([type=checkbox])'); if (i) i.focus(); }, 30);
  }
  const mSay = (m) => { const e = $('#m-err'); if (e) { e.textContent = m; e.hidden = false; } };
  const footBtns = (back, label, cls = 'btn-green') =>
    `<button class="btn" type="button" data-action="${back ? 'account' : 'close'}">${back ? 'Back' : 'Cancel'}</button><button class="btn ${cls}" type="button" data-action="acct-submit" id="m-btn">${label}</button>`;

  function openAccount() {
    acct.step = null;
    openId = null;
    const a = state.account || {};
    const devs = a.devices || [];
    const row = (title, text, button = '') => `<div class="acct-row"><div><b>${title}</b><span class="faint small">${text}</span></div>${button}</div>`;
    showModal(`<div class="modal-head"><h2 id="modal-title">Account &amp; security</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body"><div class="acct">
        ${row(`Signed in as ${esc(a.email || '')}`, a.createdAt ? `Account created ${esc(dateFull(a.createdAt))}.` : '')}
        ${row('Password', a.pwChangedAt ? `Last changed ${esc(dateFull(a.pwChangedAt))}.` : '', '<button class="btn btn-sm" data-action="password">Change password</button>')}
        ${row(`Two-step login${a.twoStep ? '<span class="on-badge">On</span>' : ''}`,
          a.twoStep ? 'After your password, a code from your authenticator app is needed.' : 'Off. Turn it on so a stolen password alone can’t open your journal.',
          a.twoStep ? '<button class="btn btn-sm" data-action="2fa-off">Turn off</button>' : '<button class="btn btn-sm btn-green" data-action="2fa-on">Turn on</button>')}
        ${row('Recovery code', `${a.recoveryAt ? `Made ${esc(dateFull(a.recoveryAt))}. ` : ''}Lost it? Make a new one; the old one stops working.`, '<button class="btn btn-sm" data-action="recovery-new">Make a new code</button>')}
        <div class="acct-row"><div><b>Signed-in devices</b><ul class="devices">${devs.map((d) => `<li>${esc(d.name || 'A device')}${d.current ? ' (this one)' : ` · last used ${esc(ago(d.seenAt))}`}</li>`).join('')}</ul></div>
          ${devs.length > 1 ? '<button class="btn btn-sm" data-action="signout-others">Sign out the others</button>' : ''}</div>
        ${row('Delete account', 'Deletes your journal, notes and saved CoinDCX key for good.', '<button class="btn btn-sm danger" data-action="delete-account">Delete…</button>')}
      </div></div>`);
  }

  function openPassword() {
    acct.step = 'password';
    acctModal('Change password',
      field('m-pw', 'Current password', 'password', 'current-password')
      + field('m-new', 'New password (at least 12 characters)', 'password', 'new-password')
      + field('m-new2', 'New password again', 'password', 'new-password')
      + `<div class="box safety"><b>How it works</b><ul>
          <li>You stay signed in here. Every other device is signed out and needs the new password.</li>
          <li>Forgot your password? Use your recovery code on the sign-in page (Forgot password?).</li></ul></div>`,
      footBtns(true, 'Change password'));
  }
  const openTwoStepOn = () => {
    acct.step = '2fa-pw';
    acctModal('Turn on two-step login', `<p class="dim small">After your password, MEDUSA will also ask for a 6-digit code from an authenticator app on your phone. Google Authenticator, Microsoft Authenticator, Authy and 2FAS all work. Someone who learns your password still can't get in.</p>`
      + field('m-pw', 'Your password', 'password', 'current-password'), footBtns(true, 'Continue'));
  };
  function showTwoStepKey(r) {
    acct.step = '2fa-code';
    acctModal('Turn on two-step login', `<ol class="steps">
        <li>Install an authenticator app on your phone if you don't have one.</li>
        <li><b>On this phone:</b> <a class="link" href="${esc(r.uri)}">add MEDUSA to your authenticator app</a>.<br>
          <b>On a computer:</b> in the app, add an account, choose <b>Enter a setup key</b>, pick <b>time-based</b>, and type this key:
          <div class="code-box key" id="tk" data-raw="${esc(r.key)}">${esc(r.key.match(/.{1,4}/g).join(' '))}</div>
          <div class="row-btns" style="margin-top:8px"><button class="btn btn-sm" type="button" data-action="copy" data-copy="tk">Copy key</button></div></li>
        <li>Type the 6-digit code the app now shows for MEDUSA.</li></ol>` + codeField('m-code'),
    footBtns(true, 'Turn on'));
  }
  const openTwoStepOff = () => {
    acct.step = '2fa-off';
    acctModal('Turn off two-step login', '<p class="dim small">Your password alone will open your journal again.</p>'
      + field('m-pw', 'Your password', 'password', 'current-password') + codeField('m-code', 'Code from your authenticator app'), footBtns(true, 'Turn off'));
  };
  const openRecoveryNew = () => {
    acct.step = 'rc-pw';
    acctModal('New recovery code', '<p class="dim small">Your current recovery code stops working, and a new one is shown once.</p>'
      + field('m-pw', 'Your password', 'password', 'current-password'), footBtns(true, 'Make a new code'));
  };
  const openDelete = () => {
    acct.step = 'delete';
    const a = state.account || {};
    acctModal('Delete account', `<div class="err">This deletes your account with all imported trades, notes, day journals and your saved CoinDCX key. It can't be undone. Want a copy first? Use ⋯ → Export trades (CSV).</div>`
      + field('m-confirm', `Type your email (<b>${esc(a.email || '')}</b>) to confirm`, 'email', 'off')
      + field('m-pw', 'Your password', 'password', 'current-password')
      + (a.twoStep ? codeField('m-code', 'Code from your authenticator app') : ''), footBtns(true, 'Delete my account', 'btn-red'));
  };

  async function submitAcct() {
    const btn = $('#m-btn');
    if (!btn || btn.disabled) return;
    const label = btn.textContent;
    $('#m-err').hidden = true;
    const pw = val('m-pw'), code = val('m-code').replace(/\s/g, '');
    const run = async (fn) => {
      btn.disabled = true;
      btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
      try {
        await fn();
      } catch (e) {
        if (e instanceof SignedOut) return;
        mSay(e.message);
        if ($('#m-code')) $('#m-code').value = '';
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    const needCode = () => !$('#m-code') || /^\d{6}$/.test(code);
    switch (acct.step) {
      case 'password': {
        const next = val('m-new');
        if (!pw || !next) return mSay('Type your current password and a new one.');
        if (next.length < 12) return mSay('Use at least 12 characters for the new password.');
        if (next !== val('m-new2')) return mSay("The two new passwords don't match.");
        if (next === pw) return mSay("That's your current password. Pick a new one.");
        return run(async () => { await call('POST', '/api/password', { current: pw, next }); await refreshAccount(); closeTrade(); toast('Password changed. Your other devices were signed out.'); });
      }
      case '2fa-pw':
        if (!pw) return mSay('Type your password.');
        return run(async () => showTwoStepKey(await call('POST', '/api/2fa/setup', { password: pw })));
      case '2fa-code':
        if (!/^\d{6}$/.test(code)) return mSay('Type the 6-digit code from your authenticator app.');
        return run(async () => { await call('POST', '/api/2fa/enable', { code }); await refreshAccount(); openAccount(); toast('Two-step login is on'); });
      case '2fa-off':
        if (!pw || !needCode()) return mSay('Type your password and the 6-digit code from your authenticator app.');
        return run(async () => { await call('POST', '/api/2fa/disable', { password: pw, code }); await refreshAccount(); openAccount(); toast('Two-step login is off'); });
      case 'rc-pw':
        if (!pw) return mSay('Type your password.');
        return run(async () => {
          const r = await call('POST', '/api/recovery', { password: pw });
          await refreshAccount();
          acct.step = null;
          acctModal('New recovery code', recoveryHTML(r.recoveryCode), '<button class="btn btn-green" type="button" data-action="account" data-needs-saved disabled>Done</button>');
        });
      case 'delete': {
        const a = state.account || {};
        if (val('m-confirm').trim().toLowerCase() !== a.email) return mSay('Type your email address exactly to confirm.');
        if (!pw || !needCode()) return mSay(a.twoStep ? 'Type your password and the 6-digit code.' : 'Type your password.');
        return run(async () => {
          await call('DELETE', '/api/account', { confirm: a.email, password: pw, code });
          store.set('name', '');
          closeTrade();
          toast('Your account was deleted.');
          setTimeout(() => location.replace('/'), 1200);
        });
      }
      default:
    }
  }

  async function loadJournal() {
    const d = await call('GET', '/api/journal');
    state.raw = d.trades || [];
    state.notes = new Map((d.notes || []).map((n) => [n.trade_id, n]));
    state.importInfo = d.import || {};
    state.cdx = d.coindcx || {};
    state.hasKey = Boolean(state.cdx.connected);
    state.settings = d.settings || {};
    state.name = state.settings.name || '';
    store.set('name', state.name);
    if (d.account) state.account = d.account;
    state.loaded = true;
    build();
  }

  /* ---------- rendering ---------- */
  function render() {
    memo = null;
    hideTip();
    paintGreeting();
    paintHeader();
    paintBanner();
    paintDayNote();
    renderKPIs();
    renderAdvanced();
    renderPerformance();
    // The calendar is for browsing your whole history, so it only shows with "All time"; otherwise the coin chart gets the row.
    const cal = state.period === 'all';
    $('#cal-card').hidden = !cal;
    $('#row-b').classList.toggle('solo', !cal);
    if (cal) renderCalendar();
    renderSymbols();
    renderHistory();
  }

  function paintHeader() {
    $('#range-label').textContent = rangeLabel();
    const info = state.importInfo || {};
    const btn = $('#import-btn');
    btn.disabled = state.importing;
    btn.innerHTML = state.importing ? '<span class="spin"></span>Importing…' : `${icon('download')}Import`;
    $('#last-import').textContent = state.importing ? '' : info.lastError ? 'Last import failed' : info.lastAt ? `Last import ${ago(info.lastAt)}` : state.hasKey ? 'Not imported yet' : '';
    $$('[data-action="perf"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.perf)));
  }

  function paintBanner() {
    const info = state.importInfo || {};
    let html = '';
    if (!state.hasKey) {
      html = state.cdx.broken
        ? `<div class="banner"><div><b>Your saved CoinDCX key can't be read any more</b>, because the server's encryption key changed. Connect it again.</div><button class="btn btn-green btn-sm" data-action="connect">Connect CoinDCX</button></div>`
        : `<div class="banner"><div><b>Connect your CoinDCX account to import your trades.</b> Your key is checked with CoinDCX, then stored encrypted. Medusa only reads your trade history.</div><button class="btn btn-green btn-sm" data-action="connect">Connect CoinDCX</button></div>`;
    } else if (info.lastError && !state.importing) {
      html = `<div class="banner"><div><b>The last import didn’t finish.</b> ${esc(info.lastError.message)}</div></div>`;
    } else if (state.loaded && !state.raw.length && !state.importing) {
      html = `<div class="banner"><div><b>No trades yet.</b> Press Import to fetch your closed CoinDCX futures trades. Open positions appear once you close them.</div></div>`;
    }
    $('#banner').innerHTML = html;
  }

  function renderKPIs() {
    const { s } = current();
    const zero = (v) => (!v ? ' zero' : '');
    const k = (ic, text, key) => `<div class="k">${icon(ic)}<span class="kt">${text}</span>${infoBtn(key)}</div>`;
    // Right under the net: the same trades before fees and funding (CoinDCX's own P&L for each trade).
    const gross = s.trades.reduce((a, t) => a + (isNum(t.gross) ? t.gross : t.net + t.feesPaid), 0);
    const net = `<div class="kpi">${k('bank', 'Net PnL', 'net')}<div class="v ${cls(s.net)}${zero(s.net)}">${money(s.net)}</div>
      <div class="s fee">Before fees: <span class="${cls(gross)}">${money(gross)}</span></div><div class="s">${plural(s.n, 'Trade')}</div></div>`;
    const win = `<div class="kpi">${k('percent', 'Win Rate', 'win')}<div class="v">${((s.winRate || 0) * 100).toFixed(1)}%</div><div class="s">${s.wins} wins / ${s.losses} losses</div></div>`;
    const pf = `<div class="kpi">${k('factor', 'Profit factor', 'pf')}<div class="v">${s.pf === Infinity ? '∞' : (s.pf || 0).toFixed(2)}</div><div class="s">${money(s.grossWin)} / ${money(s.grossLoss)}</div></div>`;
    // On phones this card takes a whole row, so both amounts fit side by side.
    const avg = `<div class="kpi wide">${k('up', `Avg Win/Loss: ${isNum(s.payoff) ? s.payoff.toFixed(2) : '0.00'}`, 'avg')}
      <div class="pair"><div><span class="v pos">${money(s.avgWin || 0)}</span><span class="s"><span class="long-label">Average Win</span><span class="short-label">Avg win</span></span></div>
      <div><span class="v neg">${money(s.avgLoss ? -s.avgLoss : 0)}</span><span class="s"><span class="long-label">Average loss</span><span class="short-label">Avg loss</span></span></div></div></div>`;
    const dd = `<div class="kpi">${k('down', 'Max drawdown', 'dd')}<div class="v neg">${money(s.maxDD ? -s.maxDD : 0)}</div><div class="s">from the highest point</div></div>`;
    $('#kpis').innerHTML = net + win + pf + avg + dd;
  }

  function renderAdvanced() {
    const c = current(), s = c.s;
    const row = (ic, label, key, value, klass = '') => `<div class="stat">${icon(ic)}<span class="label">${label}</span>${infoBtn(key)}<b class="${klass}">${value}</b></div>`;
    const best = s.best ? s.best.net : 0, worst = s.worst ? s.worst.net : 0;
    $('#adv').innerHTML = `
      <div class="adv-sec">Performance Metrics</div>
      <div class="adv-grid">
        <div class="adv-col">
          ${row('bank', 'Daily PnL', 'daily', money(c.dailyAvg), cls(c.dailyAvg))}
          ${row('up', 'Best Trade', 'best', money(best), best > 0 ? 'pos' : '')}
          ${row('down', 'Worst Trade', 'worst', money(worst), worst < 0 ? 'neg' : '')}
        </div><div class="sep"></div>
        <div class="adv-col">
          ${row('calendar', 'Winning Days', 'windays', (c.winningDays * 100).toFixed(1) + '%')}
          ${row('bank', 'Total Commissions', 'fees', money(s.fees))}
          ${row('sharpe', 'Sharpe Ratio', 'sharpe', isNum(c.sharpe) ? c.sharpe.toFixed(2) : '0.00', cls(c.sharpe))}
        </div>
      </div>
      <div class="adv-sec">Trading Patterns</div>
      <div class="adv-grid">
        <div class="adv-col">
          ${row('calendar', 'Avg Trades/Day', 'tpd', c.tradesPerDay.toFixed(1))}
          ${row('clock', 'Avg Trade Length', 'hold', dur(c.avgHold))}
          ${row('recover', 'Recovery factor', 'recovery', isNum(c.recovery) ? c.recovery.toFixed(2) : '0.00', cls(c.recovery))}
        </div><div class="sep"></div>
        <div class="adv-col">
          ${row('up', 'Max Consecutive Wins', 'wins', String(s.maxWinStreak))}
          ${row('down', 'Max Consecutive Losses', 'losses', String(s.maxLossStreak))}
        </div>
      </div>
      <div class="adv-sec" style="margin-top:22px">Account Information</div>
      <div class="adv-grid">
        <div class="adv-col">${row('dot', 'Activity Period (days)', 'activity', c.activity ? String(c.activity) : '-')}</div><div class="sep"></div>
        <div class="adv-col">${row('calendar', 'Last Trade Date', 'lasttrade', c.lastTrade ? dateFull(c.lastTrade) : '-')}</div>
      </div>`;
  }

  /* ---------- charts ---------- */
  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function showTip(html, x, y) {
    const el = $('#tip');
    el.innerHTML = html;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 12;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 18;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  const hideTip = () => { $('#tip').hidden = true; };
  const coarse = () => matchMedia('(pointer: coarse)').matches;

  function showInfo(el) {
    const it = INFO[el.dataset.info];
    if (!it) return;
    const r = el.getBoundingClientRect();
    showTip(`<b>${esc(it[0])}</b>${esc(it[1])}`, r.left + r.width / 2, r.top);
  }

  /* Redraws a chart on the next animation frame, at most once per frame. */
  const queued = new Set();
  function redraw(fn) {
    if (!queued.size) requestAnimationFrame(() => { const fns = [...queued]; queued.clear(); fns.forEach((f) => f()); });
    queued.add(fn);
  }

  /*
   * Moving a chart sideways like a trading chart: drag with the mouse or swipe with a finger, scroll
   * sideways on a trackpad, pinch or Ctrl + scroll to zoom (when h.zoom is given), and double-click or
   * double-tap to go back to the start. Up-and-down swipes still scroll the page. The host element
   * stays while its SVG is redrawn, so everything listens on the host. Points are in the SVG's own
   * units ({ x, y }; the SVG shrinks on very narrow screens) plus the screen position ({ cx, cy }).
   */
  function chartGestures(host, h) {
    const pts = new Map();
    let drag = null, pinch = null, lastTap = 0;
    const scale = () => { const svg = host.querySelector('svg'), m = svg && svg.getScreenCTM(); return m && m.a ? 1 / m.a : 1; };
    const at = (ev) => {
      const svg = host.querySelector('svg'), m = svg && svg.getScreenCTM();
      const p = m ? new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()) : { x: ev.clientX - host.getBoundingClientRect().left, y: ev.clientY - host.getBoundingClientRect().top };
      return { x: p.x, y: p.y, cx: ev.clientX, cy: ev.clientY };
    };
    host.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const p = at(ev);
      pts.set(ev.pointerId, p);
      try { host.setPointerCapture(ev.pointerId); } catch { /* not supported */ }
      if (pts.size === 1) drag = { x0: p.x, x: p.x, moved: false };
      else if (pts.size === 2 && h.zoom) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.max(20, Math.abs(a.x - b.x)) };
        drag = null;
      }
    });
    host.addEventListener('pointermove', (ev) => {
      const p = at(ev);
      if (!pts.has(ev.pointerId)) { if (ev.pointerType === 'mouse') h.hover(p); return; }
      pts.set(ev.pointerId, p);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.max(20, Math.abs(a.x - b.x));
        h.zoom(d / pinch.d, (a.x + b.x) / 2);
        pinch.d = d;
        return;
      }
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(p.x - drag.x0) < 5 * scale()) { if (ev.pointerType === 'mouse') h.hover(p); return; }
        drag.moved = true;
        h.leave();
        host.classList.add('dragging');
      }
      h.pan(p.x - drag.x);
      drag.x = p.x;
    });
    const end = (ev) => {
      if (!pts.has(ev.pointerId)) return;
      pts.delete(ev.pointerId);
      if (ev.type === 'pointerup' && drag && !drag.moved && !pinch) {
        const now = Date.now();
        if (now - lastTap < 350) { lastTap = 0; h.reset(); } else { lastTap = now; h.tap(at(ev)); }
      }
      if (pts.size < 2) pinch = null;
      if (!pts.size) { drag = null; host.classList.remove('dragging'); }
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse' && !pts.size) h.leave(); });
    host.addEventListener('wheel', (ev) => {
      if (h.zoom && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); h.zoom(Math.exp(-ev.deltaY / 300), at(ev).x); return; }
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && Math.abs(ev.deltaX) > 1) { ev.preventDefault(); h.leave(); h.pan(-ev.deltaX * scale()); }
    }, { passive: false });
  }

  /* Is the pointer on a bar? Thin or short bars get a few pixels of slack so they can still be hovered. */
  function onBar(p, cx, bw, y, y0) {
    const top = Math.min(y, y0), bot = Math.max(y, y0), slack = Math.max(3, (16 - (bot - top)) / 2);
    return Math.abs(p.x - cx) <= Math.max(bw / 2, 5) + 1 && p.y >= top - slack && p.y <= bot + slack;
  }

  /* Time-axis ticks on calendar boundaries (hours, days, weeks or months), at least `gap` px apart. */
  const TICK_STEPS = [['h', 1], ['h', 2], ['h', 3], ['h', 6], ['h', 12], ['d', 1], ['d', 2], ['d', 7], ['d', 14], ['m', 1], ['m', 2], ['m', 3], ['m', 6], ['m', 12]];
  const A_MONDAY = new Date(2001, 0, 1).getTime(); // weekly ticks land on Mondays
  function timeTicks(t0, t1, width, gap) {
    const perMs = width / (t1 - t0);
    const len = ([u, n]) => n * (u === 'h' ? S.HOUR : u === 'd' ? S.DAY : 30 * S.DAY);
    const [unit, n] = TICK_STEPS.find((s) => len(s) * perMs >= gap) || TICK_STEPS[TICK_STEPS.length - 1];
    const out = [];
    if (unit === 'm') {
      const d = new Date(t0);
      let y = d.getFullYear(), m = d.getMonth();
      for (let ms = new Date(y, m, 1).getTime(); ms <= t1; ms = new Date(y, m, 1).getTime()) {
        if (ms >= t0 && (y * 12 + m) % n === 0) out.push([ms, m === 0 || n === 12 ? `${MONTHS[m]} ${y}` : MONTHS[m]]);
        if (++m === 12) { m = 0; y++; }
      }
    } else if (unit === 'd') {
      for (let ms = S.startOfDay(t0); ms <= t1; ms = S.addDays(ms, 1)) {
        if (ms >= t0 && Math.round((ms - A_MONDAY) / S.DAY) % n === 0) out.push([ms, dateShort(ms)]);
      }
    } else {
      for (let ms = S.startOfDay(t0); ms <= t1; ms += n * S.HOUR) {
        if (ms >= t0) { const hr = new Date(ms).getHours(); out.push([ms, hr === 0 ? dateShort(ms) : `${pad(hr)}:00`]); }
      }
    }
    return out;
  }

  /* Y axis + plot background, shared by the performance and symbol charts. */
  function frame(W, H, P, lo, hi) {
    const r = fxJ() || 1;                          // round numbers in the currency shown
    const ticks = niceTicks(lo * r, hi * r, 5).map((v) => v / r);
    lo = ticks[0]; hi = ticks[ticks.length - 1];
    const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
    const span = hi - lo;
    const svg = `<rect class="plot" x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}"/>
      ${ticks.map((v) => `<line class="${v === 0 && lo < 0 ? 'zero' : 'grid'}" x1="${P.l}" x2="${W - P.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
        <line class="axis" x1="${P.l - 5}" x2="${P.l}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
        <text class="tick" x="${P.l - 9}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${moneyAxis(v, span)}</text>`).join('')}
      <line class="axis" x1="${P.l}" x2="${P.l}" y1="${P.t}" y2="${H - P.b}"/>`;
    return { svg, Y, lo, hi };
  }

  /* ---------- performance chart ---------- */
  // Below this many pixels per day the chart opens on the latest part and you swipe back for the rest.
  // Daily bars need more room than the P&L line.
  const MIN_DAY_PX = { pnl: 3, daily: 8 };
  let perfCtx = null;

  /* A window of `span` ms starting at t0, kept inside [D0, D1] and no narrower than minSpan. */
  function clampWindow(t0, span, D0, D1, minSpan) {
    span = Math.min(Math.max(span, Math.min(minSpan, D1 - D0)), D1 - D0);
    t0 = Math.min(Math.max(t0, D0), D1 - span);
    return { t0, t1: t0 + span };
  }

  function renderPerformance() {
    const host = $('#perf-chart');
    const c = current();
    const W = Math.max(280, Math.round(host.clientWidth)), H = W < 600 ? 260 : 340;
    const P = { l: W < 600 ? 58 : 66, r: 12, t: 12, b: 34 };
    const iw = W - P.l - P.r;
    const trades = c.shown, daily = state.perf === 'daily';
    perfCtx = null;
    if (!trades.length) {
      const f = frame(W, H, P, 0, 1);
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="No trades in this period">${f.svg}</svg>`;
      host.classList.remove('pannable');
      $('#perf-hint').textContent = '';
      return;
    }
    // The whole range with a little room at both ends, and the part of it on screen.
    const first = daily ? S.startOfDay(trades[0].closeAt) : trades[0].closeAt;
    const last = daily ? S.addDays(S.startOfDay(trades[trades.length - 1].closeAt), 1) : Math.max(trades[trades.length - 1].closeAt, first + S.HOUR);
    const D0 = first - (last - first) * 0.02, D1 = last + (last - first) * 0.02;
    const minSpan = daily ? 3 * S.DAY : 3 * S.HOUR, fit = (iw / MIN_DAY_PX[state.perf]) * S.DAY;
    const { t0, t1 } = state.pv
      ? clampWindow(state.pv.t0, state.pv.t1 - state.pv.t0, D0, D1, minSpan)
      : clampWindow(D1 - fit, fit, D0, D1, minSpan);
    const X = (ms) => P.l + ((ms - t0) / (t1 - t0)) * iw;
    const xAxis = timeTicks(t0, t1, iw, W < 600 ? 72 : 96).map(([ms, label]) => `<line class="axis" x1="${X(ms).toFixed(1)}" x2="${X(ms).toFixed(1)}" y1="${H - P.b}" y2="${H - P.b + 5}"/><text class="tick" x="${X(ms).toFixed(1)}" y="${H - P.b + 20}" text-anchor="middle">${label}</text>`).join('');
    // Everything that moves sits inside the plot's clip; the money axis on the left stays put.
    const clip = `<clipPath id="pc-plot"><rect x="${P.l}" y="0" width="${iw}" height="${H}"/></clipPath>`;
    const ctx = { daily, W, H, P, iw, t0, t1, D0, D1, minSpan, X };

    if (daily) {
      const keys = Object.keys(c.shownDays).sort();
      const vals = keys.map((k) => c.shownDays[k].net);
      const f = frame(W, H, P, Math.min(0, ...vals), Math.max(0, ...vals));
      const bw = Math.max(2, Math.min(26, (S.DAY / (t1 - t0)) * iw * 0.7));
      const y0 = f.Y(0);
      const bars = keys.map((k, i) => {
        const cx = X(S.parseDay(k) + S.DAY / 2);
        if (cx < P.l - bw || cx > W - P.r + bw) return '';
        const y = f.Y(vals[i]);
        return `<rect class="${vals[i] >= 0 ? 'bar-up' : 'bar-down'}" data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(y, y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y - y0)).toFixed(1)}" rx="2"/>`;
      }).join('');
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Daily profit and loss"><defs>${clip}</defs>${f.svg}
        <g clip-path="url(#pc-plot)">${xAxis}<line class="zero" x1="${P.l}" x2="${W - P.r}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"/>${bars}</g></svg>`;
      perfCtx = Object.assign(ctx, { f, y0, bw, keys, vals, days: c.shownDays, index: new Map(keys.map((k, i) => [k, i])) });
    } else {
      // Cumulative P&L after each closed trade.
      const pts = [[first - 1, 0]];
      let cum = 0;
      for (const t of trades) { cum += t.net; pts.push([t.closeAt, cum]); }
      const vals = pts.map((p) => p[1]);
      const f = frame(W, H, P, Math.min(0, ...vals), Math.max(0, ...vals));
      const y0 = f.Y(0);
      let line = '';
      pts.forEach(([ms, v], i) => { line += `${i ? 'L' : 'M'}${X(ms).toFixed(1)},${f.Y(v).toFixed(1)}`; });
      const area = `${line}L${X(pts[pts.length - 1][0]).toFixed(1)},${y0.toFixed(1)}L${X(pts[0][0]).toFixed(1)},${y0.toFixed(1)}Z`;
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Cumulative profit and loss, ending at ${money(cum)}">
        <defs>${clip}<clipPath id="pc-above"><rect x="0" y="0" width="${W}" height="${y0.toFixed(1)}"/></clipPath><clipPath id="pc-below"><rect x="0" y="${y0.toFixed(1)}" width="${W}" height="${(H - y0).toFixed(1)}"/></clipPath></defs>
        ${f.svg}
        <g clip-path="url(#pc-plot)">${xAxis}
          <path class="fill-up" d="${area}" clip-path="url(#pc-above)"/><path class="fill-down" d="${area}" clip-path="url(#pc-below)"/>
          <path class="line-up" d="${line}" clip-path="url(#pc-above)"/><path class="line-down" d="${line}" clip-path="url(#pc-below)"/></g>
        <g id="perf-hover" visibility="hidden"><line class="cross" y1="${P.t}" y2="${H - P.b}"/><circle class="dot" r="4.5"/></g></svg>`;
      perfCtx = Object.assign(ctx, { f, pts, trades });
    }
    const moved = t1 - t0 < D1 - D0 - 1;
    host.classList.toggle('pannable', moved);
    $('#perf-hint').textContent = coarse()
      ? (moved ? 'Swipe to move · Pinch to zoom · Double-tap to reset' : 'Pinch to zoom in')
      : (moved ? 'Drag to move · Ctrl + scroll to zoom · Double-click to reset' : 'Ctrl + scroll to zoom in');
  }

  function perfLeave() {
    hideTip();
    const g = $('#perf-hover');
    if (g) g.setAttribute('visibility', 'hidden');
    $$('#perf-chart rect.hover').forEach((b) => b.classList.remove('hover'));
  }

  function perfHover(p) {
    const c = perfCtx;
    if (!c || p.x < c.P.l || p.x > c.W - c.P.r || p.y < c.P.t || p.y > c.H - c.P.b) return perfLeave();
    const ms = c.t0 + ((p.x - c.P.l) / c.iw) * (c.t1 - c.t0);
    if (c.daily) {
      const k = S.dayKey(ms), i = c.index.get(k);
      if (i === undefined || !onBar(p, c.X(S.parseDay(k) + S.DAY / 2), c.bw, c.f.Y(c.vals[i]), c.y0)) return perfLeave();
      $$('#perf-chart rect.hover').forEach((b) => b.classList.remove('hover'));
      const bar = $(`#perf-chart rect[data-i="${i}"]`);
      if (bar) bar.classList.add('hover');
      const d = c.days[k];
      showTip(`<b class="${cls(d.net)}">${money(d.net)}</b>${dateFull(S.parseDay(k))} · ${plural(d.n, 'trade')}`, p.cx, p.cy);
      return;
    }
    // The closest trade on screen.
    let k = -1;
    for (let i = 1; i < c.pts.length; i++) {
      const at = c.pts[i][0];
      if (at >= c.t0 && at <= c.t1 && (k < 0 || Math.abs(at - ms) < Math.abs(c.pts[k][0] - ms))) k = i;
    }
    if (k < 0) return perfLeave();
    const [pms, pv] = c.pts[k], t = c.trades[k - 1], x = c.X(pms).toFixed(1), g = $('#perf-hover');
    g.setAttribute('visibility', 'visible');
    $('line', g).setAttribute('x1', x);
    $('line', g).setAttribute('x2', x);
    const dot = $('circle', g);
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', c.f.Y(pv).toFixed(1));
    dot.setAttribute('fill', pv >= 0 ? 'var(--green)' : 'var(--red)');
    showTip(`<b class="${cls(pv)}">${money(pv)}</b>${esc(t.sym)} ${money(t.net)}<br>${dateTime(pms)}`, p.cx, p.cy);
  }

  /* The window pan and zoom start from: the latest one asked for (several can arrive between redraws), kept in range. */
  const perfView = (c) => (state.pv ? clampWindow(state.pv.t0, state.pv.t1 - state.pv.t0, c.D0, c.D1, c.minSpan) : c);

  function perfPan(dx) {
    const c = perfCtx;
    if (!c) return;
    const v = perfView(c), span = v.t1 - v.t0;
    state.pv = clampWindow(v.t0 - (dx / c.iw) * span, span, c.D0, c.D1, c.minSpan);
    redraw(renderPerformance);
  }

  function perfZoom(k, x) {
    const c = perfCtx;
    if (!c) return;
    const v = perfView(c), span = v.t1 - v.t0, f = Math.min(1, Math.max(0, (x - c.P.l) / c.iw));
    const at = v.t0 + f * span, next = span / k;
    state.pv = clampWindow(at - f * next, next, c.D0, c.D1, c.minSpan);
    redraw(renderPerformance);
  }

  /* ---------- coin chart ---------- */
  const COIN_PX = 58; // width per coin; when they don't all fit, the chart moves sideways
  let symCtx = null;

  function renderSymbols() {
    const host = $('#sym-chart');
    const rows = S.groupBy(current().shown, 'sym').sort((a, b) => b.net - a.net);
    const W = Math.max(280, Math.round(host.clientWidth)), H = 330;
    const P = { l: W < 500 ? 58 : 66, r: 10, t: 12, b: 50 };
    const iw = W - P.l - P.r;
    const vals = rows.map((r) => r.net);
    const f = frame(W, H, P, Math.min(0, ...vals), Math.max(rows.length ? 0 : 1, ...vals));
    symCtx = null;
    if (!rows.length) {
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="No trades in this period">${f.svg}</svg>`;
      host.classList.remove('pannable');
      $('#sym-hint').textContent = '';
      return;
    }
    const band = Math.max(iw / rows.length, COIN_PX), maxOff = Math.max(0, band * rows.length - iw);
    const off = (state.symOff = Math.min(Math.max(state.symOff, 0), maxOff));
    const bw = Math.min(40, band * 0.6), y0 = f.Y(0);
    const bars = rows.map((r, i) => {
      const cx = P.l + band * (i + 0.5) - off;
      if (cx < P.l - band || cx > W - P.r + band) return '';
      const y = f.Y(r.net), t = r.items[0];
      return `<rect class="${r.net >= 0 ? 'bar-up' : 'bar-down'}" data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(y, y0).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y - y0)).toFixed(1)}" rx="3"/>
        <image href="/logo/${encodeURIComponent(t.base)}" x="${(cx - 9).toFixed(1)}" y="${H - P.b + 7}" width="18" height="18"/>
        <text class="tick" x="${cx.toFixed(1)}" y="${H - P.b + 40}" text-anchor="middle">${esc(t.base.length > 8 ? t.base.slice(0, 7) + '…' : t.base)}</text>`;
    }).join('');
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Net profit and loss by symbol">
      <defs><clipPath id="sc-plot"><rect x="${P.l}" y="0" width="${iw}" height="${H}"/></clipPath></defs>${f.svg}
      <line class="zero" x1="${P.l}" x2="${W - P.r}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"/><g clip-path="url(#sc-plot)">${bars}</g></svg>`;
    symCtx = { rows, band, bw, off, maxOff, P, W, f, y0 };
    host.classList.toggle('pannable', maxOff > 0);
    $('#sym-hint').textContent = maxOff > 0 ? `${coarse() ? 'Swipe' : 'Drag'} to see all ${rows.length} coins` : '';
  }

  function symLeave() {
    hideTip();
    $$('#sym-chart rect.hover').forEach((b) => b.classList.remove('hover'));
  }

  /* Only a bar itself shows its numbers; the gaps between bars show nothing. */
  function symHover(p) {
    const c = symCtx;
    if (!c || p.x < c.P.l || p.x > c.W - c.P.r) return symLeave();
    const i = Math.floor((p.x - c.P.l + c.off) / c.band);
    const r = c.rows[i];
    if (!r || !onBar(p, c.P.l + c.band * (i + 0.5) - c.off, c.bw, c.f.Y(r.net), c.y0)) return symLeave();
    $$('#sym-chart rect.hover').forEach((b) => b.classList.remove('hover'));
    const bar = $(`#sym-chart rect[data-i="${i}"]`);
    if (bar) bar.classList.add('hover');
    showTip(`<b class="${cls(r.net)}">${money(r.net)}</b>${esc(r.key)} · ${plural(r.n, 'trade')} · ${((r.winRate || 0) * 100).toFixed(0)}% won`, p.cx, p.cy);
  }

  function symPan(dx) {
    const c = symCtx;
    if (!c) return;
    state.symOff = Math.min(Math.max(state.symOff - dx, 0), c.maxOff);
    redraw(renderSymbols);
  }

  /* ---------- calendar ---------- */
  /* Picking a day narrows the charts and the trade history to it; picking the same day again shows everything again. */
  function setDay(day) {
    state.day = day;
    state.limit = 25;
    state.pv = null;
    state.symOff = 0;
    memo = null;
    hideTip();
    paintDayNote();
    renderPerformance();
    renderSymbols();
    renderCalendar();
    renderHistory();
  }

  function paintDayNote() {
    const note = state.day ? `Showing ${esc(dateFull(S.parseDay(state.day)))} · <button class="link" type="button" data-action="clear-day">Show all days</button>` : '';
    $('#perf-sub').innerHTML = note || 'Your trading performance over time';
    $('#sym-sub').innerHTML = note || 'Profit/loss by instrument';
  }

  function renderCalendar() {
    const { y, m } = state.cal;
    $('#cal-month').textContent = `${MONTHS_LONG[m]} ${y}`;
    const { days, range } = current();
    const first = new Date(y, m, 1).getTime();
    const start = S.addDays(first, -S.weekdayIndex(first));
    const lastDay = new Date(y, m + 1, 0).getTime();
    const end = S.addDays(lastDay, 6 - S.weekdayIndex(lastDay));
    const todayKey = S.dayKey(Date.now());
    const head = '<div class="cal-dow wkh"></div>' + ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => `<div class="cal-dow">${innerWidth < 640 ? d.slice(0, 3) : d}</div>`).join('');
    let cells = '', weeksSm = '';
    for (let w = start; w <= end; w = S.addDays(w, 7)) {
      let wkNet = 0, wkDays = 0, row = '';
      for (let i = 0; i < 7; i++) {
        const d = S.addDays(w, i), k = S.dayKey(d), v = days[k];
        const inMonth = new Date(d).getMonth() === m, inRange = d >= range.from && d < range.to;
        if (v) { wkNet += v.net; wkDays++; }
        const sel = v && k === state.day;
        const klass = ['cal-day', v ? (v.net > 0 ? 'pos' : v.net < 0 ? 'neg' : '') : '', inMonth ? '' : 'other', inRange ? '' : 'out', k === todayKey ? 'today' : '', v ? 'has' : '', sel ? 'sel' : ''].join(' ');
        const label = `${dateFull(d)}${v ? `, ${plural(v.n, 'trade')}, ${money(v.net)}` : ''}`;
        row += `<button class="${klass}" ${v ? `data-action="day" data-day="${k}" aria-pressed="${sel}"` : 'tabindex="-1"'} aria-label="${esc(label)}"><span class="d">${new Date(d).getDate()}</span>${v ? `<span class="amt">${money(v.net)}</span><span class="n">${plural(v.n, 'trade')}</span>` : ''}</button>`;
      }
      const wk = `Week ${isoWeek(w)}`;
      cells += `<div class="cal-week"><span class="wk">${wk}</span><span class="amt ${cls(wkNet)}">${money(wkNet)}</span><span class="days">${plural(wkDays, 'Day')}</span></div>${row}`;
      weeksSm += `<div>${wk}<b class="${cls(wkNet)}">${money(wkNet)}</b>${plural(wkDays, 'day')}</div>`;
    }
    $('#cal').innerHTML = `<div class="cal-grid">${head}${cells}</div><div class="weeks-sm">${weeksSm}</div>`;
  }

  /* ---------- trade history ---------- */
  function historyList() {
    return current().shown.slice().sort((a, b) => b.closeAt - a.closeAt);
  }
  function renderHistory() {
    const list = historyList();
    const shown = list.slice(0, state.limit);
    $('#hist-sub').innerHTML = state.day
      ? `Trades closed on ${esc(dateFull(S.parseDay(state.day)))} · <button class="btn btn-sm" data-action="clear-day">Show all</button>`
      : state.period === 'all' ? `${plural(list.length, 'closed trade')} imported from CoinDCX` : `${plural(list.length, 'closed trade')} · ${esc(rangeLabel())}`;
    if (!list.length) {
      $('#hist').innerHTML = `<p class="empty-note">${state.raw.length ? 'No trades in this period.' : 'Your closed trades will show up here after the first import.'}</p>`;
      return;
    }
    const table = `<div class="scroll-x"><table class="hist"><thead><tr>
        <th>Symbol</th><th class="l">Side</th><th class="md">Opened</th><th>Closed</th><th>Duration</th><th class="md">Size</th><th>Entry</th><th>Exit</th><th class="md">Fees</th><th>Net P&amp;L</th>
      </tr></thead><tbody>${shown.map((t) => `<tr data-action="trade" data-id="${esc(t.id)}" tabindex="0">
        <td><span class="sym">${coin(t)}${esc(t.sym)}</span></td><td class="l">${side(t)}</td>
        <td class="md dim">${dateTime(t.entryAt)}</td><td class="dim">${dateTime(t.closeAt)}</td><td class="dim">${dur(t.hold)}</td>
        <td class="md">${qty(t.qty)}</td><td>${price(t.entry)}</td><td>${price(t.exit)}</td><td class="md dim">${money(t.feesPaid)}</td>
        <td class="${cls(t.net)}" style="font-weight:700">${money(t.net)}</td></tr>`).join('')}</tbody></table></div>`;
    const cards = `<div class="hist-list">${shown.map((t) => `<button class="hist-row" data-action="trade" data-id="${esc(t.id)}">
        <span class="sym">${coin(t)}${esc(t.sym)} ${side(t)}</span><span class="res ${cls(t.net)}">${money(t.net)}</span>
        <span class="meta">${dateTime(t.closeAt)} · ${dur(t.hold)}</span><span class="meta" style="text-align:right">${esc(t.exitKind || '')}</span></button>`).join('')}</div>`;
    const more = list.length > shown.length ? `<div class="more"><button class="btn btn-sm" data-action="more">Show ${Math.min(25, list.length - shown.length)} more</button></div>` : '';
    $('#hist').innerHTML = table + cards + more;
  }

  /* ---------- one trade ---------- */
  let openId = null;
  function openTrade(id) {
    const t = state.trades.find((x) => x.id === id);
    if (!t) return;
    openId = id;
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const m = $('#modal');
    m.innerHTML = `<div class="modal-head">${coin(t, true)}<h2 id="modal-title">${esc(t.sym)}</h2>${side(t)}<span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body">
        <div><div class="big ${cls(t.net)}">${money(t.net)}</div>
          <div class="dim">${esc(dateTime(t.entryAt))} → ${esc(dateTime(t.closeAt))} · held ${dur(t.hold)}${t.lev ? ` · ${t.lev}x` : ''}</div></div>
        <dl class="facts">
          ${fact('Entry', price(t.entry))}${fact('Exit', price(t.exit))}${fact('Size', qty(t.qty))}${fact('Position value', money(t.qty * t.entry))}
          ${fact('P&amp;L before fees', `<span class="${cls(t.gross)}">${money(t.gross)}</span>`)}${fact('Fees', money(t.feesPaid))}${fact('Funding', `<span class="${cls(t.funding)}">${money(t.funding)}</span>`)}${fact('Exit', esc(t.exitKind || '-'))}
        </dl>
        <div class="box"><div class="chart" id="replay"><p class="dim">Loading the chart…</p></div></div>
        <label><span class="label">Notes</span><textarea class="input" id="note" placeholder="Why you took it, what happened, what you'd do again">${esc(t.note.notes || '')}</textarea></label>
      </div>
      <div class="modal-foot"><button class="btn" data-action="whatif">${icon('calc')}Leverage what-if</button><button class="btn" data-action="onchart" title="Open this trade on the Lab's chart, on a downloaded file of this coin">${icon('chart')}Show on chart</button><span style="flex:1"></span>
        <button class="btn" data-action="close">Close</button><button class="btn btn-green" data-action="save-note" id="save-note">Save note</button></div>`;
    showModal(m.innerHTML);
    drawReplay($('#replay'), t);
  }
  function showModal(html, cls = '') {
    const m = $('#modal');
    m.className = cls ? `modal ${cls}` : 'modal';
    m.innerHTML = html;
    m.hidden = false;
    $('#scrim').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  /* Closing wipes the window's HTML, so a typed key or secret never stays on the page. */
  function closeTrade() {
    openId = null;
    $('#modal').hidden = true;
    $('#modal').innerHTML = '';
    $('#modal').className = 'modal';
    $('#scrim').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- CoinDCX connection ---------- */
  function openConnect() {
    const c = state.cdx || {};
    const blocked = !c.canStore && c.source !== 'secret';
    const status = c.connected
      ? `<span class="dot on"></span>Connected · key ending ••••${esc(c.hint || '')}${c.at ? ` · since ${esc(dateFull(c.at))}` : ''}${c.source === 'secret' ? ' · set on the server' : ''}`
      : '<span class="dot"></span>Not connected';
    openId = null;
    showModal(`<div class="modal-head"><h2 id="modal-title">CoinDCX connection</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <form class="modal-body" id="cdx-form" autocomplete="off" novalidate>
        <div class="status-line">${status}</div>
        ${blocked ? '<div class="err">Finish setup first: the ENCRYPTION_KEY secret is missing on the server. The README has the one-line command.</div>' : ''}
        <div class="box safety"><b>How your key is kept safe</b><ul>
          <li>It is checked with CoinDCX before anything is saved.</li>
          <li>It is stored encrypted (AES-256). The encryption key sits in Cloudflare's secret store, not in the database.</li>
          <li>It is never shown again or sent back to your browser; you only see its last 4 characters.</li>
          <li>Medusa can only read your trade history. It has no code that places orders or moves money.</li></ul></div>
        <p class="dim small">On coindcx.com, open <b>API dashboard, then Create API key</b>. Make a new key just for Medusa and leave <b>Bind IP address</b> unticked.</p>
        <label><span class="label">API key</span><input class="input" id="cdx-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your CoinDCX API key" ${blocked ? 'disabled' : ''}></label>
        <label><span class="label">API secret</span><input class="input" id="cdx-secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your CoinDCX API secret" ${blocked ? 'disabled' : ''}></label>
        <label><span class="label">Your Medusa password</span><input class="input" id="cdx-pw" type="password" autocomplete="current-password" placeholder="To confirm it is you" ${blocked ? 'disabled' : ''}></label>
        <div class="err" id="cdx-error" role="alert" hidden></div>
        <button type="submit" hidden></button>
      </form>
      <div class="modal-foot">${c.connected && c.source === 'app' ? '<button class="btn" data-action="disconnect">Disconnect</button>' : ''}<span style="flex:1"></span>
        <button class="btn" data-action="close">Cancel</button>
        <button class="btn btn-green" data-action="connect-save" id="cdx-save" ${blocked ? 'disabled' : ''}>${c.connected ? 'Replace key' : 'Connect'}</button></div>`);
    setTimeout(() => { const k = $('#cdx-key'); if (k) k.focus(); }, 30);
  }

  async function connectSave() {
    const key = $('#cdx-key').value.trim(), secret = $('#cdx-secret').value.trim(), pw = $('#cdx-pw').value;
    const err = $('#cdx-error'), btn = $('#cdx-save');
    err.hidden = true;
    if (!key || !secret || !pw) { err.textContent = 'Fill in the API key, the API secret and your password.'; err.hidden = false; return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Checking with CoinDCX…';
    try {
      const res = await call('POST', '/api/coindcx', { apiKey: key, apiSecret: secret, password: pw });
      state.cdx = res.coindcx || {};
      state.hasKey = Boolean(state.cdx.connected);
      closeTrade();
      paintBanner();
      paintHeader();
      toast('CoinDCX connected. Press Import to bring in your trades.');
    } catch (e) {
      if (e instanceof SignedOut) return;
      $('#cdx-pw').value = '';
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = state.cdx.connected ? 'Replace key' : 'Connect';
    }
  }

  let disconnectArmed = false;
  async function disconnect(el) {
    if (!disconnectArmed) { disconnectArmed = true; el.textContent = 'Tap again to disconnect'; return; }
    disconnectArmed = false;
    try {
      const res = await call('DELETE', '/api/coindcx');
      state.cdx = res.coindcx || {};
      state.hasKey = Boolean(state.cdx.connected);
      closeTrade();
      paintBanner();
      toast('CoinDCX disconnected. Your imported trades are kept.');
    } catch (e) {
      if (!(e instanceof SignedOut)) toast(e.message, 'error');
    }
  }
  async function saveNote() {
    const t = state.trades.find((x) => x.id === openId);
    if (!t) return;
    const n = t.note || {};
    const btn = $('#save-note');
    btn.disabled = true;
    try {
      const res = await call('PUT', `/api/notes/${encodeURIComponent(t.id)}`, {
        setup: n.setup || null, tags: n.tags || [], mistakes: n.mistakes || [], emotion: n.emotion || null, rating: n.rating || null,
        plan: n.plan ?? null, risk: n.risk || null, chart: n.chart || '', notes: $('#note').value,
      });
      state.notes.set(t.id, { ...res.note, updated_at: Date.now() });
      build();
      closeTrade();
      toast('Note saved');
    } catch (e) {
      btn.disabled = false;
      if (!(e instanceof SignedOut)) toast(e.message, 'error');
    }
  }

  /*
   * Price chart around one trade: candles, the time it was open, entry and exit, plus the stop loss and
   * take profit found in your CoinDCX orders (dashed lines, with shaded risk and reward zones).
   */
  async function drawReplay(host, t) {
    let d, lv;
    try {
      [d, lv] = await Promise.all([
        call('GET', `/api/candles?pair=${encodeURIComponent(t.pair)}&from=${t.entryAt}&to=${t.closeAt}`),
        call('GET', `/api/levels?id=${encodeURIComponent(t.id)}`).catch((e) => { if (e instanceof SignedOut) throw e; return null; }),
      ]);
    } catch (e) {
      if (!(e instanceof SignedOut) && document.contains(host)) host.innerHTML = `<p class="dim">${esc(e.message)}</p>`;
      return;
    }
    if (!document.contains(host)) return;
    const cs = d.candles || [];
    if (cs.length < 2) { host.innerHTML = '<p class="dim">No chart data for this trade.</p>'; return; }
    const sl = lv && lv.sl && isNum(lv.sl.price) ? lv.sl : null, tp = lv && lv.tp && isNum(lv.tp.price) ? lv.tp : null;
    const levels = [sl, tp].filter(Boolean).map((x) => x.price);
    const W = Math.max(260, Math.round(host.clientWidth)), H = 230, P = { l: 4, r: 90, t: 10, b: 24 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const t0 = cs[0][0], t1 = cs[cs.length - 1][0] + d.step;
    let lo = Math.min(...cs.map((c) => c[3]), t.entry, t.exit, ...levels), hi = Math.max(...cs.map((c) => c[2]), t.entry, t.exit, ...levels);
    const padP = (hi - lo) * 0.08 || hi * 0.01;
    lo -= padP; hi += padP;
    const X = (ms) => Math.max(P.l, Math.min(P.l + iw, P.l + ((ms - t0) / (t1 - t0)) * iw));
    const Y = (p) => P.t + (1 - (p - lo) / (hi - lo)) * ih;
    const bw = Math.max(1.2, Math.min(9, (iw / cs.length) * 0.66));
    // Price tags on the right for entry, stop loss and take profit, nudged apart so they never overlap.
    const tags = [{ y: Y(t.entry), text: price(t.entry), fill: 'var(--text)' }];
    if (sl) tags.push({ y: Y(sl.price), text: `SL ${price(sl.price)}`, fill: 'var(--red)' });
    if (tp) tags.push({ y: Y(tp.price), text: `TP ${price(tp.price)}`, fill: 'var(--green)' });
    tags.sort((a, b) => a.y - b.y);
    for (let i = 1; i < tags.length; i++) tags[i].y = Math.max(tags[i].y, tags[i - 1].y + 13);
    const fx = fxJ() || 1;
    const ticks = niceTicks(lo * fx, hi * fx, 4).map((v) => v / fx).filter((v) => v >= lo && v <= hi && tags.every((g) => Math.abs(Y(v) - g.y) > 12));
    const hx = X(t.entryAt), hw = Math.max(2, X(t.closeAt) - X(t.entryAt));
    const zone = (p, fill) => `<rect x="${hx.toFixed(1)}" y="${Math.min(Y(p), Y(t.entry)).toFixed(1)}" width="${hw.toFixed(1)}" height="${Math.max(1, Math.abs(Y(p) - Y(t.entry))).toFixed(1)}" fill="${fill}"/>`;
    const level = (p, kind) => `<line class="lv lv-${kind}" x1="${P.l}" x2="${P.l + iw}" y1="${Y(p).toFixed(1)}" y2="${Y(p).toFixed(1)}"/>`;
    const exitColor = t.net >= 0 ? 'var(--green)' : 'var(--red)';
    const found = (x, name, color) => (x ? `<span><i class="dash" style="background:${color}"></i>${name}${x.hit ? ' (hit)' : ''}</span>` : '');
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Price of ${esc(t.sym)} around the trade">
      ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${P.l + iw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" style="stroke:rgba(255,255,255,.08)"/><text class="tick" x="${W - P.r + 8}" y="${(Y(v) + 4).toFixed(1)}">${price(v)}</text>`).join('')}
      <rect class="held" x="${hx.toFixed(1)}" y="${P.t}" width="${hw.toFixed(1)}" height="${ih}"/>
      ${tp ? zone(tp.price, 'rgba(34,197,94,0.16)') : ''}${sl ? zone(sl.price, 'rgba(240,75,75,0.16)') : ''}
      ${cs.map((c) => {
        const x = X(c[0] + d.step / 2), top = Y(Math.max(c[1], c[4])), bot = Y(Math.min(c[1], c[4]));
        return `<line class="candle" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${Y(c[2]).toFixed(1)}" y2="${Y(c[3]).toFixed(1)}"/><rect class="candle ${c[4] >= c[1] ? 'up' : 'down'}" x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/>`;
      }).join('')}
      ${tp ? level(tp.price, 'tp') : ''}${sl ? level(sl.price, 'sl') : ''}
      <line class="level" x1="${hx.toFixed(1)}" x2="${P.l + iw}" y1="${Y(t.entry).toFixed(1)}" y2="${Y(t.entry).toFixed(1)}"/>
      ${tags.map((g) => `<text x="${W - P.r + 8}" y="${(g.y + 4).toFixed(1)}" style="fill:${g.fill}">${g.text}</text>`).join('')}
      <circle cx="${hx.toFixed(1)}" cy="${Y(t.entry).toFixed(1)}" r="5" fill="#ffffff" stroke="#212121" stroke-width="2"/>
      <circle cx="${X(t.closeAt).toFixed(1)}" cy="${Y(t.exit).toFixed(1)}" r="5" fill="${exitColor}" stroke="#212121" stroke-width="2"/>
      <text class="tick" x="${P.l + 2}" y="${H - 5}">${dateTime(t0)}</text><text class="tick" x="${P.l + iw}" y="${H - 5}" text-anchor="end">${dateTime(t1)}</text></svg>
      <div class="legend"><span><i style="background:#fff"></i>Entry</span><span><i style="background:${exitColor}"></i>Exit</span>${found(sl, 'Stop loss', 'var(--red)')}${found(tp, 'Take profit', 'var(--green)')}<span><i style="background:rgba(255,255,255,.18);border-radius:2px"></i>Position open</span><span>${d.res === '1D' ? 'Daily' : d.res + '-minute'} candles</span>${sl || tp ? '' : '<span>No stop loss or take profit found</span>'}</div>`;
  }

  /* ---------- leverage calculator ---------- */
  let calcSide = 'long';
  const calcNum = (id) => { const el = $('#' + id); return el ? parseFloat(String(el.value).replace(/,/g, '')) : NaN; };
  const trimNum = (v, dp) => (isNum(v) ? String(Number(v.toFixed(dp))) : '');

  /* Opens the calculator. From a trade it starts with that trade's numbers, including the fee rate it really paid. */
  function openCalc(t) {
    const lev = t && t.lev > 0 ? t.lev : 20;
    const valued = t && isNum(t.entry) && isNum(t.qty) && t.qty > 0;
    const margin = valued && t.lev > 0 ? (t.qty * t.entry) / t.lev : 10;
    const feeRate = valued && isNum(t.exit) && t.feesPaid > 0 ? (t.feesPaid / (t.qty * (t.entry + t.exit))) * 100 : 0.05;
    const exact = (v) => (isNum(v) ? String(Number(v.toPrecision(8))) : '');
    calcSide = t && t.side === 'short' ? 'short' : 'long';
    const field = (label, id, value, hint = '') => `<label><span class="label">${label}</span><input class="input" id="${id}" inputmode="decimal" value="${esc(value)}"${hint ? ` placeholder="${hint}"` : ''}></label>`;
    openId = null;
    showModal(`<div class="modal-head">${icon('calc')}<h2 id="modal-title">Leverage calculator</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <form class="modal-body" id="calc-form" novalidate autocomplete="off">
        <p class="dim small">${t ? `Filled in from your ${esc(t.sym)} ${t.side} closed on ${esc(dateFull(t.closeAt))}. Change any number to see what would have happened.` : 'See what the same price move makes at two different leverages. Type a price move, or entry and exit prices.'}</p>
        <div class="toggle" role="group" aria-label="Direction">
          <button type="button" data-action="calc-side" data-side="long" aria-pressed="${calcSide === 'long'}">Long</button>
          <button type="button" data-action="calc-side" data-side="short" aria-pressed="${calcSide === 'short'}">Short</button>
        </div>
        <div class="calc-grid">
          ${field(`Margin (${esc(state.mcur)})`, 'c-margin', trimNum(margin, 4))}
          ${field('Leverage (x)', 'c-a', trimNum(lev, 2))}
          ${field('Compare with (x)', 'c-b', lev === 5 ? '10' : '5')}
          ${field('Fee per side (%)', 'c-fee', trimNum(feeRate, 4))}
          ${field('Entry price', 'c-entry', t ? exact(t.entry) : '', 'Optional')}
          ${field('Exit price', 'c-exit', t ? exact(t.exit) : '', 'Optional')}
          ${field('Price move (%)', 'c-move', t ? '' : '2')}
        </div>
        <div id="calc-out" aria-live="polite"></div>
        <button type="submit" hidden></button>
      </form>`);
    if (t) syncMove();
    calcUpdate();
  }

  /* Entry, exit and price move stay in step: prices set the move, and a typed move sets the exit. */
  function syncMove() {
    const e = calcNum('c-entry'), x = calcNum('c-exit');
    if (e > 0 && x > 0) $('#c-move').value = trimNum((x / e - 1) * 100, 4);
  }
  function syncExit() {
    const e = calcNum('c-entry'), m = calcNum('c-move');
    $('#c-exit').value = e > 0 && isNum(m) ? String(Number((e * (1 + m / 100)).toPrecision(8))) : '';
  }

  function calcUpdate() {
    const out = $('#calc-out');
    if (!out) return;
    const margin = calcNum('c-margin'), move = calcNum('c-move') / 100, fee = calcNum('c-fee') / 100, entry = calcNum('c-entry');
    const dir = calcSide === 'short' ? -1 : 1;
    if (!(margin > 0) || !isNum(move) || !(fee >= 0)) {
      out.innerHTML = '<p class="dim small">Enter a margin and a price move (or entry and exit prices) to see the result.</p>';
      return;
    }
    // Position = margin × leverage. Fees are charged on the position when it opens and again when it closes.
    const [a, b] = [calcNum('c-a'), calcNum('c-b')].map((L) => {
      if (!(L >= 1 && L <= 200)) return null;
      const size = margin * L, gross = size * move * dir, fees = size * fee * (2 + move), net = gross - fees;
      return { L, size, gross, fees, net, roi: net / margin, wipe: 1 / L };
    });
    const lx = (c) => (c ? `${trimNum(c.L, 2)}x` : '-');
    const pct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
    const signed = (v) => `<span class="${cls(v)}">${v > 0 ? '+' : ''}${money(v)}</span>`;
    const rows = [
      ['Position size', (c) => money(c.size)],
      ['Profit before fees', (c) => signed(c.gross)],
      ['Fees (open + close)', (c) => money(-c.fees)],
      ['Net profit', (c) => `<b>${signed(c.net)}</b>`],
      ['Return on margin (ROI)', (c) => `<b class="${cls(c.roi)}">${pct(c.roi)}</b>`],
      ['Margin wiped out after', (c) => `${(c.wipe * 100).toFixed(2)}% ${dir > 0 ? 'drop' : 'rise'}${entry > 0 ? ` (${price(entry * (1 - dir * c.wipe))})` : ''}`],
    ];
    const cell = (c, fn) => (c ? fn(c) : '-');
    const sum = a && b
      ? `<p class="calc-sum">At <b>${lx(b)}</b> instead of <b>${lx(a)}</b> you'd make ${signed(b.net)} instead of ${signed(a.net)}: a <b class="${cls(b.roi)}">${pct(b.roi)}</b> return on your margin instead of <b class="${cls(a.roi)}">${pct(a.roi)}</b>.</p>`
      : '';
    out.innerHTML = `${sum}<div class="scroll-x"><table class="calc-table"><thead><tr><th></th><th>${lx(a)}</th><th>${lx(b)}</th></tr></thead><tbody>
      ${rows.map(([label, fn]) => `<tr><td>${label}</td><td>${cell(a, fn)}</td><td>${cell(b, fn)}</td></tr>`).join('')}</tbody></table></div>
      <p class="faint small">Price move ${pct(move)}. Funding isn't included, and the exchange closes a position a little before its margin is fully gone.</p>`;
  }

  /* ---------- import, export, sign-out ---------- */
  async function runImport(auto = false) {
    if (state.importing) return;
    if (!state.hasKey) { if (!auto) openConnect(); return; }
    state.importing = true;
    paintHeader();
    paintBanner();
    let res = null;
    try {
      for (let i = 0; i < 40; i++) {
        res = await call('POST', '/api/import');
        if (res.busy) { await sleep(1500); continue; }
        if (res.done) break;
      }
      await loadJournal();
      const n = (res && res.newTrades) || 0;
      if (!auto || n) toast(n ? `Imported ${plural(n, 'new trade')}` : 'You’re up to date. No new closed trades.');
    } catch (e) {
      if (!(e instanceof SignedOut)) {
        toast(e.message, 'error');
        await loadJournal().catch(() => {});
      }
    } finally {
      state.importing = false;
      render();
    }
  }

  function exportCSV() {
    const rows = state.trades.slice();
    if (!rows.length) return toast('There are no trades to export yet.');
    const cols = [
      ['Symbol', (t) => t.sym], ['Side', (t) => t.side], ['Opened', (t) => S.localStamp(t.entryAt)], ['Closed', (t) => S.localStamp(t.closeAt)],
      ['Duration (minutes)', (t) => (isNum(t.hold) ? Math.round(t.hold / 60000) : null)], ['Size', (t) => t.qty], ['Entry', (t) => t.entry], ['Exit', (t) => t.exit],
      ['Leverage', (t) => t.lev], ['P&L before fees', (t) => t.gross], ['Fees', (t) => t.feesPaid], ['Funding', (t) => t.funding], ['Net P&L', (t) => t.net],
      ['Exit', (t) => t.exitKind], ['Margin currency', (t) => t.mcur], ['Notes', (t) => t.note.notes || ''],
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([S.toCSV(cols, rows)], { type: 'text/csv;charset=utf-8' }));
    a.download = `medusa-trades-${S.dayKey(Date.now())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Export downloaded');
  }

  let toastTimer = null;
  function toast(msg, tone = '') {
    log('journal', msg, null, tone === 'error' ? 'error' : 'info');
    showToast(msg, tone);
  }
  function showToast(msg, tone = '', ms = 0) {
    const el = $('#toast');
    el.textContent = msg;
    el.dataset.tone = tone;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || (tone === 'error' ? 6000 : 2800));
  }
  function setMenu(open) {
    $('#menu').hidden = !open;
    $('#menu-btn').setAttribute('aria-expanded', String(open));
  }
  function showLogin(mode = 'signin') {
    closeTrade();
    setMenu(false);
    $('#app').hidden = true;
    $('#login').hidden = false;
    renderAuth(mode);
  }
  // Signing out reloads the page, so nothing from this account stays in memory or on screen.
  function signOut() {
    log('app', 'Signed out');
    flushLogs(true);
    store.set('name', '');
    call('POST', '/api/logout').catch(() => {}).finally(() => location.replace('/'));
  }

  /* ---------- events ---------- */
  let reimportArmed = false;
  function onClick(ev) {
    if (!ev.target.closest('.menu-wrap')) setMenu(false);
    if (!ev.target.closest('.range-wrap')) setRangePop(false);
    if (!ev.target.closest('.info, .chart, [data-tip]')) hideTip();
    if (ev.target.id === 'scrim') return closeTrade();
    const el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    switch (el.dataset.action) {
      case 'import': runImport(false); break;
      case 'nav': setPhoneMenu(false); setView(el.dataset.nav); if (isPhone()) window.scrollTo({ top: 0 }); break;
      case 'side': if (isPhone()) setPhoneMenu(!$('#side').classList.contains('open')); else setSide(!$('#side').classList.contains('collapsed')); break;
      case 'about': setMenu(false); setPhoneMenu(false); openAbout(); break;
      case 'reload': location.reload(); break;
      case 'dev-tab': setView(`devtools:${el.dataset.tab}`); break;
      case 'update-later': { const bar = $('#update-bar'); if (bar) bar.remove(); break; }
      case 'fx': setFx(!state.fx.on); break;
      case 'log-view': showLogDay(el.dataset.day); break;
      case 'log-dl': downloadLogDay(el.dataset.day); break;
      case 'log-del': deleteLogs(el.dataset.day); break;
      case 'log-del-all': deleteLogs(null); break;
      case 'log-refresh': openLogs(); break;
      case 'log-filter': LOGV.filter = el.dataset.f; paintLogDay(); break;
      case 'menu': setMenu($('#menu').hidden); break;
      case 'range': setRangePop($('#range-pop').hidden); break;
      case 'range-close': setRangePop(false); break;
      case 'preset': setPeriod(el.dataset.period); break;
      case 'info': showInfo(el); break;
      case 'calc': openCalc(null); break;
      case 'whatif': openCalc(state.trades.find((x) => x.id === openId) || null); break;
      case 'onchart': { const id = openId; closeTrade(); setView('lab:chart'); if (labLoad) labLoad.then((m) => { if (m && m.showMyTrade) m.showMyTrade(id); }); break; }
      case 'calc-side':
        calcSide = el.dataset.side;
        $$('[data-action="calc-side"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === calcSide)));
        calcUpdate();
        break;
      case 'name': setMenu(false); openName(); break;
      case 'save-name': saveName(); break;
      case 'account': setMenu(false); refreshAccount().then(openAccount).catch(() => {}); break;
      case 'password': openPassword(); break;
      case '2fa-on': openTwoStepOn(); break;
      case '2fa-off': openTwoStepOff(); break;
      case 'recovery-new': openRecoveryNew(); break;
      case 'delete-account': openDelete(); break;
      case 'signout-others':
        call('DELETE', '/api/sessions/others').then(refreshAccount).then(() => { openAccount(); toast('Your other devices were signed out'); })
          .catch((e) => { if (!(e instanceof SignedOut)) toast(e.message, 'error'); });
        break;
      case 'acct-submit': submitAcct(); break;
      case 'auth': renderAuth(el.dataset.mode); break;
      case 'auth-done': enterApp(); break;
      case 'auth-import': enterApp(true); break;
      case 'copy': copyText(el.dataset.copy); break;
      case 'download-code': downloadCode(); break;
      case 'export': setMenu(false); exportCSV(); break;
      case 'connect': setMenu(false); openConnect(); break;
      case 'connect-save': connectSave(); break;
      case 'disconnect': disconnect(el); break;
      case 'reimport':
        if (!reimportArmed) { reimportArmed = true; el.textContent = 'Tap again to re-import everything'; return; }
        reimportArmed = false;
        setMenu(false);
        el.textContent = 'Re-import everything';
        call('POST', '/api/import/reset').then(() => runImport(false)).catch((e) => { if (!(e instanceof SignedOut)) toast(e.message, 'error'); });
        break;
      case 'logout':
        setMenu(false);
        signOut();
        break;
      case 'perf': state.perf = el.dataset.mode; store.set('perf', state.perf); paintHeader(); renderPerformance(); break;
      case 'cal': { const d = new Date(state.cal.y, state.cal.m + Number(el.dataset.step), 1); state.cal = { y: d.getFullYear(), m: d.getMonth() }; renderCalendar(); break; }
      case 'cal-now': { const d = new Date(); state.cal = { y: d.getFullYear(), m: d.getMonth() }; renderCalendar(); break; }
      case 'day': setDay(state.day === el.dataset.day ? null : el.dataset.day); break;
      case 'clear-day': setDay(null); break;
      case 'more': state.limit += 25; renderHistory(); break;
      case 'trade': openTrade(el.dataset.id); break;
      case 'close': closeTrade(); break;
      case 'save-note': saveNote(); break;
      default: break;
    }
  }

  function bind() {
    document.addEventListener('click', onClick);
    document.addEventListener('submit', (ev) => {
      if (ev.target.id === 'cdx-form') { ev.preventDefault(); connectSave(); }
      if (ev.target.id === 'range-form') { ev.preventDefault(); applyRange(); }
      if (ev.target.id === 'name-form') { ev.preventDefault(); saveName(); }
      if (ev.target.id === 'auth-form') { ev.preventDefault(); submitAuth(); }
      if (ev.target.id === 'acct-form') { ev.preventDefault(); submitAcct(); }
      if (ev.target.id === 'calc-form') ev.preventDefault();
    });
    // "I saved my recovery code" unlocks the button that leaves the code screen.
    document.addEventListener('change', (ev) => {
      if (ev.target.id === 'rc-ok') $$('[data-needs-saved]').forEach((b) => { b.disabled = !ev.target.checked; });
      if (ev.target.id === 'log-verbose') {
        LOG.verbose = ev.target.checked;
        store.set('logVerbose', LOG.verbose);
        log('app', `Detailed logging ${LOG.verbose ? 'on' : 'off'}`);
      }
    });
    // A drag that selected text in a table's row isn't a click on the row, on any page.
    document.addEventListener('click', (ev) => {
      if (ev.target.closest('tbody tr') && !ev.target.closest('a, button, summary') && !getSelection().isCollapsed) ev.stopPropagation();
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        hideTip();
        if (!$('#modal').hidden) closeTrade();
        setMenu(false);
        if (!$('#range-pop').hidden) { setRangePop(false); $('#range-btn').focus(); }
      }
      if (ev.key === 'Enter' && ev.target.matches('tr[data-action="trade"]')) openTrade(ev.target.dataset.id);
    });
    document.addEventListener('input', (ev) => {
      if (!ev.target.closest('#calc-form')) return;
      const id = ev.target.id;
      if (id === 'c-move') syncExit();
      else if (id === 'c-exit') syncMove();
      else if (id === 'c-entry') { if ($('#c-exit').value) syncMove(); else syncExit(); }
      calcUpdate();
    });
    // (i) buttons: hover with a mouse, tap on a phone, or reach them with the keyboard.
    document.addEventListener('pointerover', (ev) => { const el = ev.target.closest && ev.target.closest('.info'); if (el && ev.pointerType === 'mouse') showInfo(el); });
    const tipFor = (el) => { const r = el.getBoundingClientRect(); showTip(esc(el.dataset.tip), r.left + r.width / 2, r.top); };
    document.addEventListener('pointerover', (ev) => { const el = ev.target.closest && ev.target.closest('.mkt[data-tip], #fx-btn[data-tip]'); if (el) tipFor(el); });
    document.addEventListener('pointerout', (ev) => { const el = ev.target.closest && ev.target.closest('.mkt[data-tip], #fx-btn[data-tip]'); if (el && !el.contains(ev.relatedTarget)) hideTip(); });
    document.addEventListener('focusin', (ev) => { if (ev.target.matches && ev.target.matches('.mkt[data-tip]')) tipFor(ev.target); });
    document.addEventListener('pointerout', (ev) => { const el = ev.target.closest && ev.target.closest('.info'); if (el && ev.pointerType === 'mouse' && !el.contains(ev.relatedTarget)) hideTip(); });
    document.addEventListener('focusin', (ev) => { if (ev.target.classList && ev.target.classList.contains('info')) showInfo(ev.target); });
    document.addEventListener('focusout', (ev) => { if (ev.target.classList && ev.target.classList.contains('info')) hideTip(); });
    addEventListener('scroll', hideTip, { passive: true });
    chartGestures($('#perf-chart'), {
      hover: perfHover, tap: perfHover, leave: perfLeave, pan: perfPan, zoom: perfZoom,
      reset: () => { state.pv = null; redraw(renderPerformance); },
    });
    chartGestures($('#sym-chart'), {
      hover: symHover, tap: symHover, leave: symLeave, pan: symPan, zoom: null,
      reset: () => { state.symOff = 0; redraw(renderSymbols); },
    });
    $('#range-presets').innerHTML = PRESETS.map((p) => `<button type="button" data-action="preset" data-period="${p.id}" aria-pressed="false">${p.label}</button>`).join('');
    // The greeting follows the clock while the page stays open.
    setInterval(paintGreeting, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) paintGreeting(); });
    let lastW = innerWidth;
    addEventListener('resize', debounce(() => { if (innerWidth !== lastW) { lastW = innerWidth; if (state.loaded && view === 'journal') render(); } }, 200));
  }

  // Imports only ever start from the Import button (or "Import my trades" right after setting up).
  async function openApp(importNow = false, signedIn = false) {
    $('#app').hidden = false;
    try {
      await loadJournal();
    } catch (e) {
      if (!(e instanceof SignedOut)) $('#banner').innerHTML = `<div class="banner"><div><b>Couldn’t open your journal.</b> ${esc(e.message)}</div></div>`;
      return;
    }
    LOG.on = true;
    if (signedIn) log('app', 'Signed in');
    log('app', `Opened (${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] || 'browser'}, ${innerWidth}x${innerHeight})`, null, 'debug');
    flushLogs();
    if (state.fx.on) loadFx(true).then((ok) => { if (!ok) state.fx.on = false; applyFx(); });
    const fromHash = (fallback) => {
      const h = location.hash.slice(1);
      if (h === 'logs' || h === 'devtools/logs') return 'devtools:logs';   // the Logs used to be a page of their own
      return h.startsWith('lab') ? `lab:${h.split('/')[1] || 'dashboard'}` : h === 'devtools' ? 'devtools:tools' : h === 'markets' || h === 'journal' ? h : fallback;
    };
    const want = fromHash(store.get('view', 'journal'));
    if (want !== 'journal') setView(want, false);
    else { markNav(); render(); }
    addEventListener('hashchange', () => setView(fromHash('journal')));   // a #lab/... link or the address bar
    if (!store.get('menuHint', false)) {                                   // once: where the pages went
      store.set('menuHint', true);
      setTimeout(() => showToast('The Journal, Markets, the Lab’s pages (Dashboard, Get data, Files, Chart, Strategies, Python, Strategy guide) and Dev tools (with the Logs) are in the menu on the left.', '', 10000), 1200);
    }
    if (importNow && state.hasKey) runImport(false);
  }

  /* ---------- the left sidebar: Journal, the Lab's pages, Logs ---------- */
  // MEDUSA Lab (backtesting) lives in /lab/ and is only downloaded the first time it is opened.
  let view = 'journal';
  let labTab = 'dashboard';
  let labLoad = null;
  let devTab = 'tools';                                       // Dev tools' tab: tools or logs
  function markNav() {
    const key = view === 'lab' ? `lab:${labTab}` : view;
    $$('[data-nav]').forEach((b) => b.setAttribute('aria-current', b.dataset.nav === key ? 'page' : 'false'));
  }
  function setView(v, save = true) {
    let tab = null;
    if (v.startsWith('lab:')) { tab = v.slice(4); v = 'lab'; }
    if (v === 'logs') v = 'devtools:logs';
    if (v.startsWith('devtools:')) { devTab = v.slice(9) === 'logs' ? 'logs' : 'tools'; v = 'devtools'; }
    view = v === 'lab' || v === 'devtools' || v === 'markets' ? v : 'journal';
    if (tab) labTab = tab;
    $('#app').dataset.view = view;
    $('#journal').hidden = view !== 'journal';
    $('#markets').hidden = view !== 'markets';
    $('#lab').hidden = view !== 'lab';
    $('#devtools').hidden = view !== 'devtools';
    if (save) store.set('view', view === 'lab' ? `lab:${labTab}` : view === 'devtools' ? `devtools:${devTab}` : view);
    history.replaceState(null, '', view === 'journal' ? location.pathname + location.search : view === 'markets' ? '#markets' : view === 'lab' ? `#lab/${labTab}` : devTab === 'logs' ? '#devtools/logs' : '#devtools');
    markNav();
    if (view !== 'lab') log('nav', view === 'devtools' ? (devTab === 'logs' ? 'Logs' : 'Dev tools') : view === 'markets' ? 'Markets' : 'Journal', null, 'debug');   // the Lab logs its own pages
    if (view !== 'markets' && mktLoad) mktLoad.then((m) => { if (m && view !== 'markets') m.stop(); });   // close Binance's live stream
    if (view === 'lab') openLab(labTab);
    else if (view === 'devtools') openDevtools();
    else if (view === 'markets') openMarkets();
    else if (state.loaded) render();
  }
  /* On a phone the menu is a slim bar of icons; its button slides the full menu over the page (with a
     shade behind it: a tap there, or picking a page, closes it). */
  const isPhone = () => matchMedia('(max-width: 700px)').matches;
  function setPhoneMenu(open) {
    const side = $('#side');
    if (side.classList.contains('open') === open) return;
    side.classList.toggle('open', open);
    $('#side-toggle').setAttribute('aria-expanded', String(open));
    let shade = $('#side-shade');
    if (open && !shade) {
      shade = document.createElement('div');
      shade.id = 'side-shade';
      shade.className = 'side-shade';
      shade.addEventListener('pointerdown', () => setPhoneMenu(false));
      side.after(shade);
    } else if (!open && shade) shade.remove();
  }
  addEventListener('resize', () => { if (!isPhone()) setPhoneMenu(false); });
  function setSide(collapsed) {
    $('#side').classList.toggle('collapsed', collapsed);
    $('#side-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('#side-toggle').dataset.tip = collapsed ? 'Expand the menu' : 'Collapse the menu';
    store.set('side', collapsed);
  }
  const LAB_JS = '/lab/main.js?v=7', LAB_CSS = '/lab/lab.css?v=11';
  function openLab(tab) {
    if (labLoad) { labLoad.then((m) => { if (m) m.goTab(tab); }); return; }
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LAB_CSS;
    document.head.appendChild(css);
    $('#lab').innerHTML = '<div class="loading">Opening the Lab…</div>';
    labLoad = import(LAB_JS)
      .then((m) => { m.mount($('#lab'), window.MedusaApp, tab); return m; })
      .catch((e) => {
        labLoad = null;
        log('lab', `The Lab couldn't be opened: ${e.message}`, null, 'error');
        $('#lab').innerHTML = `<div class="banner"><div><b>The Lab couldn’t be opened.</b> ${esc(e.message)} Reload the page to try again.</div></div>`;
        return null;
      });
  }

  /* ---------- Markets, the live scanner (markets.js, downloaded only when the page is opened) ---------- */
  // Every market's move today against its normal from the market data lakehouse, with live prices
  // streamed from Binance to this browser while the page is open, calculated by SQL in the browser.
  let mktLoad = null;
  function openMarkets() {
    const host = $('#markets');
    if (!mktLoad) {
      host.innerHTML = '<div class="loading">Opening Markets…</div>';
      mktLoad = import('/markets.js?v=13').catch((e) => {
        mktLoad = null;
        log('markets', `Markets couldn't be opened: ${e.message}`, null, 'error');
        host.innerHTML = `<div class="banner"><div><b>Markets couldn’t be opened.</b> ${esc(e.message)} Reload the page to try again.</div></div>`;
        return null;
      });
    }
    mktLoad.then((m) => { if (m && view === 'markets') m.render(host, mktApi); });
  }
  const mktApi = { call, log, store, toast: showToast };

  /* ---------- Dev tools (devtools.js, downloaded only when the page is opened) ---------- */
  let devLoad = null;
  function openDevtools() {
    $$('[data-action="dev-tab"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === devTab)));
    $('#logs').hidden = devTab !== 'logs';
    $('#dev-tools').hidden = devTab !== 'tools';
    if (devTab === 'logs') { openLogs(); return; }
    const host = $('#dev-tools');
    if (!devLoad) {
      host.innerHTML = '<div class="loading">Opening Dev tools…</div>';
      devLoad = import('/devtools.js?v=3').catch((e) => {
        devLoad = null;
        host.innerHTML = `<div class="banner"><div><b>Dev tools couldn’t be opened.</b> ${esc(e.message)} Reload the page to try again.</div></div>`;
        return null;
      });
    }
    devLoad.then((m) => { if (m && view === 'devtools' && devTab === 'tools') m.render(host, devApi); });
  }
  const devApi = {
    release: () => release, errors: () => ERRORS.slice(), store, call, log, flushLogs, toast: showToast,
    checkVersion: () => checkVersion(true), openAbout, preloadLab: () => preloadLab(true),
    lab: () => labLoad, go: (v) => setView(v === 'logs' ? 'devtools:logs' : v),
  };

  /* Optional (Dev tools): once the journal has loaded and the browser is idle, fetch the Lab's and the
     Chart's code, so they open at once. The Python engine still starts only in the Lab. */
  function preloadLab(now = false) {
    if ((!now && !store.get('preloadLab', false)) || labLoad) return;
    const go = () => {
      if (labLoad) return;
      import(LAB_JS).then(() => import('/lab/chart.js')).catch(() => {});
      const css = document.createElement('link');
      css.rel = 'prefetch';
      css.href = LAB_CSS;
      document.head.appendChild(css);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 8000 }); else setTimeout(go, 3000);
  }

  /* ---------- market hours (the strip under the header) ---------- */
  // Regular hours of the markets crypto follows most, shown in your time zone and worked out with each
  // exchange's own time zone (so daylight saving is handled). Exchange holidays aren't included.
  const WEEK = [1, 2, 3, 4, 5];
  const MARKETS = [
    { name: 'US stocks', full: 'New York Stock Exchange and Nasdaq', tz: 'America/New_York', days: WEEK, s: [[570, 960]] },
    { name: 'CME futures', full: 'CME Bitcoin futures (Globex, Chicago): Sunday evening to Friday, with a daily one-hour break', tz: 'America/Chicago', cme: true },
    { name: 'London', full: 'London Stock Exchange', tz: 'Europe/London', days: WEEK, s: [[480, 990]] },
    { name: 'Frankfurt', full: 'Frankfurt Stock Exchange (Xetra)', tz: 'Europe/Berlin', days: WEEK, s: [[540, 1050]] },
    { name: 'India', full: 'National Stock Exchange of India', tz: 'Asia/Kolkata', days: WEEK, s: [[555, 930]] },
    { name: 'Shanghai', full: 'Shanghai Stock Exchange (closed for lunch 11:30-13:00 Shanghai time)', tz: 'Asia/Shanghai', days: WEEK, s: [[570, 690], [780, 900]] },
    { name: 'Hong Kong', full: 'Hong Kong Exchanges (closed for lunch 12:00-13:00 Hong Kong time)', tz: 'Asia/Hong_Kong', days: WEEK, s: [[570, 720], [780, 960]] },
    { name: 'Seoul', full: 'Korea Exchange', tz: 'Asia/Seoul', days: WEEK, s: [[540, 930]] },
    { name: 'Tokyo', full: 'Tokyo Stock Exchange (closed for lunch 11:30-12:30 Tokyo time)', tz: 'Asia/Tokyo', days: WEEK, s: [[540, 690], [750, 930]] },
  ];
  const tzFmt = {};
  function tzParts(ms, tz) {
    const f = tzFmt[tz] || (tzFmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, min: (+p.hour % 24) * 60 + +p.minute };
  }
  function zoned(y, m, d, minutes, tz) {                 // a wall-clock time in tz -> ms
    const guess = Date.UTC(y, m - 1, d, 0, minutes);
    const off = (t) => { const p = tzParts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, 0, p.min) - Math.floor(t / 60000) * 60000; };
    let t = guess - off(guess);
    const o2 = off(t);
    if (guess - o2 !== t) t = guess - o2;
    return t;
  }
  function sessions(mk, now) {                           // open intervals around now, joined where they touch
    const p = tzParts(now, mk.tz);
    const out = [];
    for (let k = -2; k <= 8; k++) {
      const day = new Date(Date.UTC(p.y, p.m - 1, p.d + k));
      const wd = day.getUTCDay();
      const spans = mk.cme ? (wd === 0 ? [[1020, 1440]] : wd === 6 ? [] : wd === 5 ? [[0, 960]] : [[0, 960], [1020, 1440]])
        : mk.days.includes(wd) ? mk.s : [];
      for (const [a, b] of spans) out.push([zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), a, mk.tz), zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), b, mk.tz)]);
    }
    out.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const iv of out) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push([...iv]); }
    return merged;
  }
  const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function whenText(ms, now) {
    const d = new Date(ms), t = new Date(now);
    const sameDay = d.toDateString() === t.toDateString();
    const tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).toDateString() === d.toDateString();
    return `${sameDay ? '' : tomorrow ? 'tomorrow ' : `${WEEKDAYS_LONG[d.getDay()].slice(0, 3)} `}${hm(ms)}`;
  }
  function paintMarkets() {
    const el = $('#mkts');
    if (!el) return;
    const now = Date.now(), left = el.scrollLeft;
    el.innerHTML = MARKETS.map((mk) => {
      const iv = sessions(mk, now);
      const open = iv.find(([a, b]) => a <= now && now < b);
      const next = iv.find(([a]) => a > now);
      const shown = open || next;
      const hours = shown ? `${whenText(shown[0], now)} to ${whenText(shown[1], now)}` : '';
      return `<span class="mkt ${open ? 'on' : ''}" role="listitem" tabindex="0" data-tip="${esc(`${mk.full}. ${open ? 'Open now' : 'Next session'}: ${hours} (your time). Regular hours; holidays not included.`)}">
        <i aria-hidden="true"></i><b>${esc(mk.name)}</b><span>${open ? `open · closes ${whenText(open[1], now)}` : next ? `opens ${whenText(next[0], now)}` : 'closed'}</span></span>`;
    }).join('');
    el.scrollLeft = left;
  }

  /* ---------- the INR switch ---------- */
  async function loadFx(quiet = false) {
    try {
      const r = await call('GET', '/api/fx');
      Object.assign(state.fx, { rate: r.rate, at: r.at });
      return true;
    } catch (e) {
      if (!(e instanceof SignedOut) && !quiet) toast(`Couldn’t get the USDT/INR rate: ${e.message}`, 'error');
      return false;
    }
  }
  function paintFx() {
    const b = $('#fx-btn');
    if (!b) return;
    b.setAttribute('aria-pressed', String(state.fx.on));
    $('#fx-rate').textContent = state.fx.on && state.fx.rate ? `₹${state.fx.rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/USDT` : '';
    b.dataset.tip = state.fx.rate ? `USDT amounts in rupees at CoinDCX’s last USDT/INR price, ₹${state.fx.rate} (${hm(state.fx.at || Date.now())}). Percentages don’t change.` : 'Show USDT amounts in Indian rupees (CoinDCX’s USDT/INR price)';
  }
  async function setFx(on) {
    if (on && !(await loadFx())) on = false;
    state.fx.on = on;
    store.set('fx', on);
    log('app', on ? `Amounts shown in INR (₹${state.fx.rate} per USDT)` : 'Amounts shown in USDT');
    applyFx();
  }
  function applyFx() {
    paintFx();
    if (view === 'journal' && state.loaded) render();
    for (const cb of fxListeners) { try { cb(); } catch { /* a page that is gone */ } }
  }

  /* ---------- the Logs page ---------- */
  const LOGV = { days: null, day: null, lines: null, max: 0, armed: null, filter: 'all' };
  const dayTitle = (day) => { const d = new Date(`${day}T00:00:00`); return `${WEEKDAYS_LONG[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  async function openLogs() {
    paintLogs();
    await flushLogs();
    try {
      const r = await call('GET', '/api/logs');
      Object.assign(LOGV, { days: r.days, max: r.max });
    } catch (e) { if (!(e instanceof SignedOut)) LOGV.error = e.message; }
    paintLogs();
    if (LOGV.days && LOGV.days.length) showLogDay(LOGV.day && LOGV.days.some((d) => d.day === LOGV.day) ? LOGV.day : LOGV.days[0].day);
  }
  function paintLogs() {
    const el = $('#logs');
    const days = LOGV.days;
    const row = (d) => `<tr class="${d.day === LOGV.day ? 'on' : ''}"><td class="l"><button class="link" data-action="log-view" data-day="${d.day}">${dayTitle(d.day)}</button></td>
      <td>${d.n.toLocaleString('en-US')}</td><td class="${d.errors ? 'neg' : 'faint'}">${d.errors || 0}</td><td class="faint">${clock(d.first)} – ${clock(d.last)}</td>
      <td class="acts"><button class="btn btn-sm" data-action="log-dl" data-day="${d.day}" title="Download this day as a text file">${icon('download')}<span class="sr-only">Download</span></button>
      <button class="btn btn-sm" data-action="log-del" data-day="${d.day}">${LOGV.armed === d.day ? 'Tap again' : 'Delete'}</button></td></tr>`;
    el.innerHTML = `<section class="card logs-card">
      <div class="card-head"><div><h2>Logs</h2><p>What happened in MEDUSA, a file per day (your time). Kept on MEDUSA’s server for your account only, up to ${(LOGV.max || 20000).toLocaleString('en-US')} lines (the oldest go first); keys, passwords and codes are never written.</p></div>
        <label class="check"><input type="checkbox" id="log-verbose" ${LOG.verbose ? 'checked' : ''}><span>Detailed logging (for debugging)</span></label></div>
      ${LOGV.error ? `<div class="banner"><div>${esc(LOGV.error)}</div></div>` : ''}
      ${!days ? '<p class="dim"><span class="spin"></span> Loading…</p>' : !days.length ? '<p class="dim">No logs yet. Everything you do from now on is written here.</p>'
        : `<div class="scroll-x"><table class="hist logs-tbl"><thead><tr><th class="l">Logs folder: day</th><th>Lines</th><th>Errors</th><th>From – to</th><th></th></tr></thead><tbody>${days.map(row).join('')}</tbody></table></div>`}
      <div class="row-btns"><button class="btn btn-sm" data-action="log-refresh">Refresh</button>${days && days.length ? `<button class="btn btn-sm" data-action="log-del-all">${LOGV.armed === '*' ? 'Tap again to delete all logs' : 'Delete all logs'}</button>` : ''}</div>
    </section>
    <section class="card" id="log-day" ${LOGV.day ? '' : 'hidden'}></section>`;
    paintLogDay();
  }
  function paintLogDay() {
    const el = $('#log-day');
    if (!el || !LOGV.day) return;
    const lines = (LOGV.lines || []).filter((l) => LOGV.filter === 'all' || l.level === LOGV.filter);
    el.innerHTML = `<div class="card-head"><div><h2>${dayTitle(LOGV.day)}</h2><p>${LOGV.lines ? `${LOGV.lines.length.toLocaleString('en-US')} lines` : 'Loading…'}</p></div>
      <div class="toggle" role="group" aria-label="Show">${[['all', 'All'], ['error', 'Errors'], ['debug', 'Detailed']].map(([k, l]) => `<button data-action="log-filter" data-f="${k}" aria-pressed="${LOGV.filter === k}">${l}</button>`).join('')}</div></div>
      <div class="loglines">${lines.map((l) => `<div class="logline lv-${l.level}"><time>${clock(l.at)}</time><span class="area">${esc(l.area)}</span><span class="msg">${esc(l.msg)}${l.data ? `<details><summary>details</summary><pre>${esc(JSON.stringify(l.data, null, 1))}</pre></details>` : ''}</span></div>`).join('') || '<p class="faint">Nothing to show.</p>'}</div>`;
  }
  async function showLogDay(day) {
    Object.assign(LOGV, { day, lines: null });
    paintLogs();
    try { LOGV.lines = (await call('GET', `/api/logs?day=${day}`)).lines.reverse(); } catch (e) { if (!(e instanceof SignedOut)) toast(e.message, 'error'); }
    paintLogs();
  }
  async function downloadLogDay(day) {
    try {
      const { lines } = await call('GET', `/api/logs?day=${day}`);
      const text = lines.map((l) => `${clock(l.at)}  ${l.level.padEnd(5)}  ${l.area.padEnd(8)}  ${l.msg}${l.data ? `  ${JSON.stringify(l.data)}` : ''}`).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`MEDUSA logs, ${dayTitle(day)} (your time)\n\n${text}\n`], { type: 'text/plain;charset=utf-8' }));
      a.download = `medusa-logs-${day}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { if (!(e instanceof SignedOut)) toast(e.message, 'error'); }
  }
  async function deleteLogs(day) {
    const key = day || '*';
    if (LOGV.armed !== key) { LOGV.armed = key; paintLogs(); setTimeout(() => { if (LOGV.armed === key) { LOGV.armed = null; if (view === 'devtools' && devTab === 'logs') paintLogs(); } }, 4000); return; }
    LOGV.armed = null;
    try {
      const r = await call('DELETE', day ? `/api/logs?day=${day}` : '/api/logs');
      showToast(day ? `Deleted the logs of ${dayTitle(day)} (${r.deleted} lines)` : `Deleted all logs (${r.deleted} lines)`);
      if (!day || LOGV.day === day) Object.assign(LOGV, { day: null, lines: null });
      await openLogs();
    } catch (e) { if (!(e instanceof SignedOut)) toast(e.message, 'error'); }
  }

  // What the Lab borrows from the journal page. Losing the session there reloads the page, so nothing
  // from one account can stay on screen for the next one.
  window.MedusaApp = {
    toast: showToast, showModal, closeModal: closeTrade, signedOut: () => location.reload(), log,
    trades: () => state.trades,                       // the journal's closed trades (the Lab's chart draws them)
    fx: fxRate, onFx: (cb) => fxListeners.push(cb),
    navChanged: (key) => {
      if (!key.startsWith('lab:') || view !== 'lab') return;
      labTab = key.slice(4);
      store.set('view', key);
      history.replaceState(null, '', `#lab/${labTab}`);
      markNav();
    },
  };

  /** The release version, kept in one place (/version.json), shown in the menu and on the sign-in card. */
  let release = null;
  function paintVersion() {
    fetch('/version.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((v) => {
      if (!v || !v.version) return;
      release = v;
      for (const el of document.querySelectorAll('[data-version]')) {
        el.textContent = `v${v.version}`;
        el.title = `MEDUSA ${v.version}${v.date ? `, released ${v.date}` : ''}`;
        el.hidden = false;
      }
    }).catch(() => {});
  }

  /* A newer release is noticed while MEDUSA is open (every 30 minutes, and when you come back to it), and a
     small bar offers to reload. It can be switched off in Dev tools. */
  let versionAt = Date.now();
  function checkVersion(force = false) {
    if (!force && (!store.get('autoUpdate', true) || Date.now() - versionAt < 30 * 60_000)) return Promise.resolve(null);
    versionAt = Date.now();
    return fetch('/version.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => {
      if (v && v.version && release && v.version !== release.version && !force) showUpdate(v);
      return v;
    }).catch(() => null);
  }
  function showUpdate(v) {
    let bar = $('#update-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'update-bar';
      bar.className = 'update-bar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span>MEDUSA ${esc(v.version)} is ready.</span><button class="btn btn-sm btn-green" data-action="reload">Reload</button><button class="btn btn-sm btn-icon" data-action="update-later" aria-label="Not now">${icon('close')}</button>`;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  setInterval(() => { if (!document.hidden) checkVersion(); }, 30 * 60_000);

  /* ---------- About MEDUSA: the version, when it was released, what changed, and how your data is protected ---------- */
  const SECURITY = [
    ['Your CoinDCX key', 'encrypted with AES-256-GCM, tied to your account, and never sent back to the browser (only its last 4 characters are shown). The encryption key sits in Cloudflare’s secret store, not in the database.'],
    ['Read-only by design', 'the key can only sign CoinDCX’s two trade-history calls. MEDUSA has no code that places, changes or cancels orders or moves money. Connecting or replacing the key asks for your password again.'],
    ['Passwords', 'stored only as a salted PBKDF2-SHA256 hash (25,000 rounds) of a keyed HMAC, so a copy of the database can’t reveal or test them.'],
    ['Sign-in', 'optional two-step login with an authenticator app (each code works once, the secret is stored encrypted), and a recovery code shown once.'],
    ['Sessions', 'a random 256-bit token in an HttpOnly, Secure, SameSite=Strict cookie; only its SHA-256 is stored. Changing the password signs out every other device.'],
    ['Guessing is slowed down', '10 wrong passwords per address or account in 15 minutes, 6 wrong two-step codes, 6 wrong recovery codes an hour, and limits on new accounts.'],
    ['Your data stays yours', 'every database query is limited to the signed-in account; deleting the account removes its trades, notes, key, sessions and Lab files.'],
    ['The page itself', 'a strict Content Security Policy (only MEDUSA’s own scripts), HTTPS everywhere (HSTS), no framing, no referrer, no sniffing, camera/microphone/location off, and changes are accepted only from MEDUSA’s own pages.'],
    ['Backtests', 'your Python strategies run in your own browser, in a background thread with network access switched off.'],
    ['No tracking or request logs', 'no analytics or third-party scripts, and Cloudflare’s request logging is off, so nothing you send is logged. The Logs (in Dev tools) never record keys, passwords or codes.'],
  ];
  function openAbout() {
    const v = release || {};
    const date = v.date ? new Date(`${v.date}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const li = (items) => `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    showModal(`<div class="modal-head"><img class="logo" src="/medusa.svg" alt="" width="36" height="36"><h2 id="modal-title">About MEDUSA</h2><span style="flex:1"></span>
        <button class="btn btn-icon" data-action="close" aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body">
        <div><div class="big">${v.version ? `Version ${esc(v.version)}` : 'Version unknown'}</div><div class="dim">${date ? `Released ${esc(date)}` : ''}</div></div>
        ${v.changes && v.changes.length ? `<div class="about-sec"><h3>New in this version</h3>${li(v.changes.map(esc))}</div>` : ''}
        <div class="about-sec"><h3>How your data is protected</h3>${li(SECURITY.map(([k, d]) => `<b>${esc(k)}:</b> ${esc(d)}`))}</div>
      </div>
      <div class="modal-foot"><span style="flex:1"></span><button class="btn" data-action="close">Close</button></div>`);
  }

  async function start() {
    paintVersion();
    state.period = store.get('period', 'all');
    state.range = store.get('range', null);
    if (state.period === 'custom' ? !validRange(state.range) : !PRESETS.some((p) => p.id === state.period)) state.period = 'all';
    if (state.period !== 'custom') state.range = null;
    state.cal = endMonth();
    state.perf = store.get('perf', 'pnl') === 'daily' ? 'daily' : 'pnl';
    state.name = String(store.get('name', '') || '').slice(0, 40); // shown right away; the journal load refreshes it
    state.fx.on = Boolean(store.get('fx', false));
    paintGreeting();
    bind();
    setSide(Boolean(store.get('side', false)));
    paintMarkets();
    setInterval(paintMarkets, 30_000);
    setInterval(() => { if (state.fx.on) loadFx(true).then(applyFx); }, 5 * 60_000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushLogs(true); else paintMarkets(); });
    let session;
    try {
      session = await call('GET', '/api/session');
    } catch (e) {
      showLogin();
      authError(e.message);
      return;
    }
    if (!session.signedIn) {
      store.set('name', '');
      state.name = '';
      paintGreeting();
      showLogin();
      if (!session.ready) authError('This app isn’t finished setting up: the ENCRYPTION_KEY secret is missing. The README has the command.');
      return;
    }
    state.account = session.account;
    openApp();
    preloadLab();
  }
  start();
})();
