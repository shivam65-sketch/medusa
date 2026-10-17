// MEDUSA Lab report: what a backtest result looks like on screen. The numbers come from the Python
// engine (labrun.py); this file only draws them: warnings, headline tiles, account value against buy
// and hold, a price chart with every trade, and the tables.

import { esc, money, pct, num, rr, price, tone, dateLocal, zoneLabel, MONTHS, isNum, icon, $, $$, inrRate } from './util.js';

const C = { g: '#22c55e', r: '#f04b4b', grid: 'rgba(255,255,255,0.08)', t3: '#8b8b91', t2: '#b4b4b8', line: '#9a9aa0', a: '#e5b23b', plot: '#212121' };
const v = (x) => (x === 'inf' ? Infinity : x === '-inf' ? -Infinity : x);

/* What each headline number means (the (i) buttons). */
export const EXPLAIN = {
  net: 'Money made or lost over the whole test, after fees, slippage and funding, starting from the capital in the settings.',
  cagr: 'The steady yearly growth rate that would turn the starting capital into the final balance over the same time. Lets you compare tests of different lengths.',
  dd: 'The biggest fall of the account from a previous high to a later low. The part of a strategy that is hardest to live through.',
  trades: 'How many trades closed. Under about 100, the results can be luck; under 30, they say almost nothing.',
  win: 'The share of trades that made money. A strategy can win rarely and still profit if its winners are much bigger than its losers.',
  pf: 'All money won on winning trades divided by all money lost on losing trades. Above 1 = profitable; 1.3+ after costs is good.',
  avg: 'The average trade in R. 1R is what a trade loses if it hits its first stop, so +0.20R means each trade made a fifth of its risk on average. The t number says how sure that is: about 2 or more means it is unlikely to be luck.',
  sharpe: 'Average daily return divided by how much daily returns swing, scaled to a year. Above 1 is good, above 2 is excellent (and suspicious in a backtest).',
};

/* ---------- canvas helpers ---------- */
function canvasIn(host) {
  host.innerHTML = '';
  const cv = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'lab-tip';
  tip.hidden = true;
  host.append(cv, tip);
  const fit = () => {
    const r = host.getBoundingClientRect();
    const k = devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * k));
    cv.height = Math.max(1, Math.round(r.height * k));
    const x = cv.getContext('2d');
    x.setTransform(k, 0, 0, k, 0, 0);
    x.font = '11.5px "Segoe UI", system-ui, sans-serif';
    return { x, w: r.width, h: r.height };
  };
  const showTip = (html, px, py) => {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = host.clientWidth;
    tip.style.left = Math.max(4, Math.min(px + 14, w - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, py) + 'px';
  };
  return { host, cv, tip, fit, showTip, hideTip: () => { tip.hidden = true; } };
}

/** Round-number ticks in the currency shown (money = true: USDT values, labelled in rupees when ₹ is on). */
function ticks(lo, hi, n, money = false) {
  const r = money ? inrRate() || 1 : 1;
  if (r !== 1) return ticks(lo * r, hi * r, n).map((v) => v / r);
  const s = (hi - lo) / n || 1;
  const m = 10 ** Math.floor(Math.log10(s));
  const f = [1, 2, 2.5, 5, 10].find((q) => q * m >= s) * m;
  const out = [];
  for (let x = Math.ceil(lo / f) * f; x <= hi + 1e-9; x += f) out.push(x);
  return out;
}

const fmtD = (ms, time) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; return time ? `${s} ${p(d.getHours())}:${p(d.getMinutes())}` : s; };
function timeTicks(t0, t1, w) {
  const span = t1 - t0, day = 864e5;
  const steps = [36e5, 6 * 36e5, day, 7 * day, 30 * day, 91 * day, 365 * day, 730 * day];
  const st = steps.find((s) => span / s <= Math.max(2, w / 110)) || steps[steps.length - 1];
  const out = [];
  if (st >= 30 * day) {
    let d = new Date(t0);
    const mm = Math.round(st / (30 * day));
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    while (+d <= t1) { out.push(+d); d = new Date(d.getFullYear(), d.getMonth() + mm, 1); }
  } else {
    for (let x = Math.ceil(t0 / st) * st; x <= t1; x += st) out.push(x);
  }
  return out.map((x) => [x, st >= 365 * day ? fmtD(x).slice(0, 4) : st >= day ? fmtD(x).slice(0, st >= 30 * day ? 7 : 10) : fmtD(x, true).slice(5)]);
}
/** Axis labels: $12.5k, or in rupees (₹ on) ₹12.4L / ₹1.24Cr. */
const moneyShort = (x) => {
  const r = inrRate(), v = r ? x * r : x, a = Math.abs(v);
  const body = r
    ? (a >= 1e7 ? (a / 1e7).toFixed(2) + 'Cr' : a >= 1e5 ? (a / 1e5).toFixed(2) + 'L' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 2))
    : (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : a.toFixed(a >= 100 ? 0 : 2));
  return (v < 0 ? '-' : '') + (r ? '₹' : '$') + body;
};

/** Watches a host's width and redraws (charts are drawn at the size they are shown). */
function onResize(host, draw) {
  let w = host.clientWidth;
  const ro = new ResizeObserver(() => { if (host.clientWidth !== w && host.clientWidth > 0) { w = host.clientWidth; draw(); } });
  ro.observe(host);
}

/* ---------- account value + drawdown ---------- */
function equityChart(eqHost, ddHost, R) {
  const E = R.equity;
  if (!E || !E.t.length) return;
  const A = canvasIn(eqHost), B = canvasIn(ddHost);
  const P = { l: 64, r: 12, t: 12, b: 24 };
  let hover = null;
  function draw() {
    const { x, w, h } = A.fit();
    const t0 = E.t[0], t1 = E.t[E.t.length - 1];
    const all = E.s.concat(E.bh).filter(isNum);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad; hi += pad;
    const X = (t) => P.l + ((t - t0) / (t1 - t0 || 1)) * (w - P.l - P.r);
    const Y = (q) => P.t + ((hi - q) / (hi - lo)) * (h - P.t - P.b);
    x.fillStyle = C.t3; x.strokeStyle = C.grid;
    for (const q of ticks(lo, hi, 5, true)) { x.beginPath(); x.moveTo(P.l, Y(q)); x.lineTo(w - P.r, Y(q)); x.stroke(); x.fillText(moneyShort(q), 4, Y(q) + 4); }
    for (const [tv, l] of timeTicks(t0, t1, w)) x.fillText(l, X(tv) - 18, h - 6);
    x.setLineDash([4, 4]); x.strokeStyle = '#555'; x.beginPath(); x.moveTo(P.l, Y(R.settings.capital)); x.lineTo(w - P.r, Y(R.settings.capital)); x.stroke(); x.setLineDash([]);
    const line = (arr, col, wd) => { x.beginPath(); x.strokeStyle = col; x.lineWidth = wd; arr.forEach((q, i) => { const px = X(E.t[i]), py = Y(q); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); x.lineWidth = 1; };
    line(E.bh, C.line, 1.2);
    line(E.s, C.g, 1.8);
    const d = B.fit();
    const dlo = Math.min(...E.dd, -0.01);
    const DY = (q) => 6 + ((0 - q) / (0 - dlo)) * (d.h - 12);
    d.x.fillStyle = 'rgba(240,75,75,0.35)';
    d.x.beginPath(); d.x.moveTo(X(t0), DY(0)); E.dd.forEach((q, i) => d.x.lineTo(X(E.t[i]), DY(q))); d.x.lineTo(X(t1), DY(0)); d.x.fill();
    d.x.fillStyle = C.t3;
    for (const q of ticks(dlo, 0, 3)) d.x.fillText((q * 100).toFixed(0) + '%', 8, DY(q) + 4);
    if (hover !== null) {
      const i = hover, px = X(E.t[i]);
      for (const [c, hh] of [[x, h], [d.x, d.h]]) { c.strokeStyle = 'rgba(255,255,255,0.4)'; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, hh); c.stroke(); }
      A.showTip(`${fmtD(E.t[i], true)}<br><b class="pos">Strategy ${money(E.s[i])}</b>Buy &amp; hold ${money(E.bh[i])}<br>Below its high ${(E.dd[i] * 100).toFixed(1)}%`, px, 8);
    } else A.hideTip();
    A.X = X;
  }
  draw();
  onResize(eqHost, draw);
  const move = (e) => {
    const r = A.cv.getBoundingClientRect();
    const t = E.t[0] + ((e.clientX - r.left - P.l) / (r.width - P.l - P.r)) * (E.t[E.t.length - 1] - E.t[0]);
    let lo = 0, hi = E.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (E.t[m] < t) lo = m; else hi = m; }
    hover = Math.max(0, Math.min(E.t.length - 1, hi));
    draw();
  };
  A.cv.addEventListener('pointermove', move);
  A.cv.addEventListener('pointerdown', move);
  A.cv.addEventListener('pointerleave', () => { hover = null; draw(); });
}

/* ---------- price chart with every trade ---------- */
function priceChart(host, bar, candles, R, onSelect) {
  const K = candles, n = K.n, T = R.trades;
  const A = canvasIn(host);
  const P = { l: 8, r: 72, t: 10, b: 24 };
  let v0 = 0, v1 = n, sel = -1;
  const idxOf = (t) => {
    if (t <= K.t[0]) return 0;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (K.t[m] <= t) lo = m; else hi = m; }
    return K.t[hi] <= t ? hi : lo;
  };
  function draw() {
    const { x, w, h } = A.fit();
    const a = Math.max(0, Math.floor(v0)), b = Math.min(n, Math.ceil(v1));
    if (b - a < 2) return;
    const cw = (w - P.l - P.r) / (v1 - v0);
    const step = Math.max(1, Math.floor(1.5 / cw));
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < b; i++) { if (K.l[i] < lo) lo = K.l[i]; if (K.h[i] > hi) hi = K.h[i]; }
    const s = sel >= 0 ? T[sel] : null;
    if (s) for (const q of [s.stop, s.tp]) if (isNum(q)) { lo = Math.min(lo, q); hi = Math.max(hi, q); }
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    const X = (i) => P.l + (i - v0 + 0.5) * cw;
    const Y = (p) => P.t + ((hi - p) / (hi - lo)) * (h - P.t - P.b);
    x.fillStyle = C.t3; x.strokeStyle = C.grid;
    for (const q of ticks(lo, hi, 6, true)) { x.beginPath(); x.moveTo(P.l, Y(q)); x.lineTo(w - P.r, Y(q)); x.stroke(); x.fillText(price(q), w - P.r + 6, Y(q) + 4); }
    for (const [tv, l] of timeTicks(K.t[a], K.t[b - 1], w)) x.fillText(l, X(idxOf(tv)) - 18, h - 6);
    for (let i = a; i < b; i += step) {
      const j1 = Math.min(b, i + step);
      const o = K.o[i], c = K.c[j1 - 1];
      let hh = -Infinity, ll = Infinity;
      for (let j = i; j < j1; j++) { if (K.h[j] > hh) hh = K.h[j]; if (K.l[j] < ll) ll = K.l[j]; }
      const up = c >= o;
      x.strokeStyle = x.fillStyle = up ? C.g : C.r;
      const cx = X(i + (step - 1) / 2);
      x.beginPath(); x.moveTo(cx, Y(hh)); x.lineTo(cx, Y(ll)); x.stroke();
      const bw = Math.max(1, cw * step * 0.7);
      if (bw > 2) x.fillRect(cx - bw / 2, Math.min(Y(o), Y(c)), bw, Math.max(1, Math.abs(Y(o) - Y(c))));
    }
    const ta = K.t[a], tb = K.t[b - 1];
    T.forEach((tr, k) => {
      if (tr.xt < ta || tr.et > tb) return;
      const ei = idxOf(tr.et), xi = idxOf(tr.xt);
      const col = tr.pnl >= 0 ? C.g : C.r;
      x.globalAlpha = sel < 0 || k === sel ? 1 : 0.45;
      x.strokeStyle = col; x.setLineDash([3, 3]);
      x.beginPath(); x.moveTo(X(ei), Y(tr.ep)); x.lineTo(X(xi), Y(tr.xp)); x.stroke(); x.setLineDash([]);
      const ex = X(ei), ey = Y(tr.ep);
      x.fillStyle = tr.side > 0 ? C.g : C.r;
      x.beginPath();
      if (tr.side > 0) { x.moveTo(ex, ey + 2); x.lineTo(ex - 5, ey + 10); x.lineTo(ex + 5, ey + 10); } else { x.moveTo(ex, ey - 2); x.lineTo(ex - 5, ey - 10); x.lineTo(ex + 5, ey - 10); }
      x.fill();
      x.fillStyle = col; x.beginPath(); x.arc(X(xi), Y(tr.xp), 3.5, 0, 7); x.fill();
      x.globalAlpha = 1;
    });
    if (s) {
      const ei = idxOf(s.et), xi = idxOf(s.xt);
      for (const [q, col, l] of [[s.stop, C.r, 'stop'], [s.tp, C.g, 'target']]) {
        if (!isNum(q)) continue;
        x.strokeStyle = col; x.setLineDash([6, 4]);
        x.beginPath(); x.moveTo(X(ei), Y(q)); x.lineTo(X(xi), Y(q)); x.stroke(); x.setLineDash([]);
        x.fillStyle = col; x.fillText(l, X(xi) + 4, Y(q) + 4);
      }
      x.strokeStyle = 'rgba(229,178,59,0.6)';
      x.strokeRect(X(ei) - cw / 2, P.t, Math.max(2, X(xi) - X(ei) + cw), h - P.t - P.b);
    }
    A.cw = cw;
  }
  const label = $('[data-sel]', bar);
  function show(k) {
    if (k < 0 || k >= T.length) return;
    sel = k;
    const tr = T[k];
    const ei = idxOf(tr.et), xi = idxOf(tr.xt);
    const span = Math.max(60, (xi - ei) * 2.2);
    v0 = Math.max(0, (ei + xi) / 2 - span / 2);
    v1 = Math.min(n, v0 + span);
    v0 = Math.max(0, v1 - span);
    label.textContent = `Trade ${k + 1}: ${tr.side > 0 ? 'long' : 'short'} ${fmtD(tr.et, true)} → ${fmtD(tr.xt, true)} · ${tr.why} · ${money(tr.pnl)}${isNum(tr.r) ? ` (${rr(tr.r)})` : ''}`;
    draw();
    onSelect(k);
  }
  const zoom = (f, at = 0.5) => {
    const span = v1 - v0, ns = Math.min(n, Math.max(20, span * f));
    const c = v0 + at * span;
    v0 = Math.max(0, c - at * ns); v1 = Math.min(n, v0 + ns); v0 = Math.max(0, v1 - ns);
    draw();
  };
  A.cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = A.cv.getBoundingClientRect();
    zoom(e.deltaY > 0 ? 1.25 : 0.8, Math.min(1, Math.max(0, (e.clientX - r.left - P.l) / (r.width - P.l - P.r))));
  }, { passive: false });
  const pts = new Map();
  let drag = null, pinch = null;
  A.cv.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, e.clientX);
    A.cv.setPointerCapture(e.pointerId);
    if (pts.size === 2) { const xs = [...pts.values()]; pinch = { d: Math.abs(xs[0] - xs[1]) || 1, v0, v1 }; drag = null; } else drag = { x: e.clientX, v0, v1 };
  });
  A.cv.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, e.clientX);
    if (pinch && pts.size === 2) {
      const xs = [...pts.values()];
      const f = pinch.d / (Math.abs(xs[0] - xs[1]) || 1);
      const span = pinch.v1 - pinch.v0, ns = Math.min(n, Math.max(20, span * f)), c = (pinch.v0 + pinch.v1) / 2;
      v0 = Math.max(0, c - ns / 2); v1 = Math.min(n, v0 + ns); v0 = Math.max(0, v1 - ns);
      draw();
      return;
    }
    if (drag) {
      const dx = (e.clientX - drag.x) / A.cw;
      let a = drag.v0 - dx, b = drag.v1 - dx;
      if (a < 0) { b -= a; a = 0; }
      if (b > n) { a -= b - n; b = n; }
      v0 = Math.max(0, a); v1 = b;
      draw();
      return;
    }
    const r = A.cv.getBoundingClientRect();
    const i = Math.floor(v0 + (e.clientX - r.left - P.l) / A.cw);
    if (i < 0 || i >= n) { A.hideTip(); return; }
    A.showTip(`${fmtD(K.t[i], true)}<br>O ${price(K.o[i])} H ${price(K.h[i])}<br>L ${price(K.l[i])} C ${price(K.c[i])}`, e.clientX - r.left, 8);
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (!pts.size) drag = null; };
  A.cv.addEventListener('pointerup', up);
  A.cv.addEventListener('pointercancel', up);
  A.cv.addEventListener('pointerleave', () => A.hideTip());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'all') { v0 = 0; v1 = n; sel = -1; label.textContent = ''; draw(); onSelect(-1); } else if (k === 'in') zoom(0.6);
    else if (k === 'out') zoom(1.6);
    else if (T.length) show(sel < 0 ? (k === 'next' ? 0 : T.length - 1) : Math.max(0, Math.min(T.length - 1, sel + (k === 'next' ? 1 : -1))));
  });
  draw();
  onResize(host, draw);
  return { show };
}

/* ---------- R histogram ---------- */
function histogram(host, rs) {
  if (!rs.length) { host.innerHTML = '<p class="faint lab-empty-chart">No trades with a stop, so no R values.</p>'; return; }
  const A = canvasIn(host);
  const draw = () => {
    const { x, w, h } = A.fit();
    const lo = Math.max(-5, Math.floor(Math.min(...rs))), hi = Math.min(10, Math.ceil(Math.max(...rs)) || 1);
    const bins = [];
    for (let q = lo; q < hi; q += 0.5) bins.push([q, 0]);
    if (!bins.length) bins.push([lo, 0]);
    for (const r of rs) {
      const k = Math.min(bins.length - 1, Math.max(0, Math.floor((Math.min(Math.max(r, lo), hi - 1e-9) - lo) / 0.5)));
      bins[k][1]++;
    }
    const m = Math.max(...bins.map((b) => b[1]));
    const bw = (w - 40) / bins.length;
    bins.forEach(([q, c], k) => {
      x.fillStyle = q >= 0 ? C.g : C.r;
      const bh = ((h - 30) * c) / m;
      x.fillRect(20 + k * bw + 1, h - 20 - bh, Math.max(1, bw - 2), bh);
      if (Number.isInteger(q)) { x.fillStyle = C.t3; x.fillText(q + 'R', 20 + k * bw, h - 6); }
    });
  };
  draw();
  onResize(host, draw);
}

/* ---------- tables ---------- */
const table = (head, rows, cls = '') =>
  `<div class="lab-scroll"><table class="lab-table ${cls}"><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const span = (x, text) => `<span class="${tone(x)}">${text}</span>`;
const info = (key) => `<button class="lab-i" type="button" data-lab="explain" data-text="${esc(EXPLAIN[key])}" aria-label="What this means">i</button>`;

function tile(label, value, sub, cls, key) {
  return `<div class="lab-tile"><div class="tl">${label}${key ? info(key) : ''}</div><div class="tv ${cls || ''}">${value}</div><div class="ts">${sub}</div></div>`;
}

function groupRows(rows) {
  return rows.map(([k, st]) => [esc(k), st.n, `${(st.win_rate * 100).toFixed(1)}%`, span(st.net, money(st.net)), isNum(st.r_avg) ? rr(st.r_avg, 3) : '–']);
}

/** Draws a whole report into host. opts: {candles, loadCandles(), saved, onSave(btn), onExport(), onCode(), onChart(), onReuse(), onDelete(btn)} */
export function renderReport(host, R, opts = {}) {
  const sm = R.summary, gs = R.gross, ts = sm.trades || {}, M = R.meta, S = R.settings;
  const market = `${M.source === 'upload' ? 'Uploaded' : 'Binance'} ${M.market}`;
  const yrs = (M.to - M.from) / (365.25 * 864e5);
  const ravg = isNum(ts.r_avg) ? ts.r_avg : null;
  const tiles = [
    tile('Net profit', money(sm.net), `${pct(sm.return)} on ${money(sm.capital, 0)}`, tone(sm.net), 'net'),
    tile('Yearly growth', isNum(sm.cagr) ? pct(sm.cagr) : '–', `buy &amp; hold ${pct(sm.bh_return)} in total`, tone(sm.cagr), 'cagr'),
    tile('Worst drawdown', `${(-sm.max_dd * 100).toFixed(1)}%`, `buy &amp; hold ${(-(sm.bh_max_dd || 0) * 100).toFixed(1)}% · longest ${Math.round(sm.longest_dd_days)} days`, sm.max_dd > 0 ? 'neg' : '', 'dd'),
    tile('Trades', (ts.n || 0).toLocaleString('en-US'), `${ts.longs || 0} long · ${ts.shorts || 0} short`, '', 'trades'),
    tile('Win rate', `${((ts.win_rate || 0) * 100).toFixed(1)}%`, `${ts.wins || 0} wins / ${ts.losses || 0} losses`, '', 'win'),
    tile('Profit factor', num(ts.profit_factor || 0), 'won ÷ lost (above 1 = profit)', tone(v(ts.profit_factor || 0) - 1), 'pf'),
    tile('Average trade', ravg !== null ? rr(ravg, 3) : money(ts.avg), ravg !== null ? `t = ${num(ts.r_t)} · ${money(ts.avg)}` : 'no stop, so no R', tone(ravg !== null ? ravg : ts.avg), 'avg'),
    tile('Sharpe ratio', num(sm.sharpe), `Sortino ${num(sm.sortino)} · in the market ${Math.round(sm.exposure * 100)}% of the time`, tone(sm.sharpe), 'sharpe'),
  ];
  const costsRows = [
    ['Net profit', span(gs.net, money(gs.net)), span(sm.net, money(sm.net))],
    ['Return', span(gs.return, pct(gs.return)), span(sm.return, pct(sm.return))],
    ['Worst drawdown', `${(-gs.max_dd * 100).toFixed(1)}%`, `${(-sm.max_dd * 100).toFixed(1)}%`],
    ['Average trade', isNum(gs.trades.r_avg) ? rr(gs.trades.r_avg, 3) : '–', ravg !== null ? rr(ravg, 3) : '–'],
    ['Win rate', `${((gs.trades.win_rate || 0) * 100).toFixed(1)}%`, `${((ts.win_rate || 0) * 100).toFixed(1)}%`],
  ];
  let held = '';
  if (R.split) {
    const rows = [];
    for (const [k, lab] of [['before', 'Before'], ['after', 'From']]) {
      const x = R.split[k];
      if (!x) continue;
      const t2 = x.trades;
      rows.push([`${lab} ${dateLocal(R.split_at)}<br><span class="faint">${dateLocal(x.from)} – ${dateLocal(x.to)}</span>`, span(x.return, pct(x.return)), `${(-x.max_dd * 100).toFixed(1)}%`,
        t2.n || 0, `${((t2.win_rate || 0) * 100).toFixed(1)}%`, isNum(t2.r_avg) ? `${rr(t2.r_avg, 3)} (t ${num(t2.r_t)})` : '–']);
    }
    held = `<section class="lab-sec"><h3>Held-back check</h3><p class="dim small">Choose settings on the first part only. The second part shows whether the result held up on candles that weren’t used to choose them; that is the closest a backtest gets to the future.</p>${
      table(['Period', 'Return', 'Worst drawdown', 'Trades', 'Win rate', 'Average trade'], rows)}</section>`;
  }
  const years = R.years.map((y) => [y.year, span(y.return, pct(y.return)), y.trades, span(y.net, money(y.net))]);
  const mrows = Object.keys(R.monthly).sort().map((y) => [y, ...R.monthly[y].map((x) => {
    if (!isNum(x)) return '';
    const a = Math.min(Math.abs(x) / 0.2, 1);
    const bg = x > 0 ? `rgba(34,197,94,${(0.12 + 0.55 * a).toFixed(2)})` : x < 0 ? `rgba(240,75,75,${(0.12 + 0.55 * a).toFixed(2)})` : 'transparent';
    return `<span class="lab-hm" style="background:${bg}">${(x * 100).toFixed(1)}</span>`;
  })]);
  const settings = [
    ['Data', `${esc(M.dataset_name || M.symbol)} · ${market} · ${M.interval}`],
    ['Strategy', esc(M.strategy_label)],
    ['Settings', esc(M.settings_text)],
    ['Costs', `fee ${(S.fee * 100).toFixed(3)}% + slippage ${(S.slippage * 100).toFixed(3)}% per fill${M.market === 'futures' ? ` · funding ${S.funding ? 'paid/received at the real rates' : 'not included'}` : ''}`],
    ['Sizing', `${S.sizing === 'risk' ? `risk ${S.risk_pct}% of the account per trade (needs a stop)` : `position = ${S.notional_pct}% of the account`}, up to ${S.max_leverage}x leverage, ${S.compounding ? 'compounding' : 'no compounding'}, start ${money(S.capital, 0)}`],
    ['Warm-up', M.warmup ? `indicators also used the ${M.warmup.toLocaleString('en-US')} candles before the start date (no trades there)` : 'none: the test starts at the file’s first candle, so each indicator needs its own length of candles before the first trade'],
    ['Fills', S.fill === 'next_open' ? 'market orders at the next candle’s open' : 'market orders at the signal candle’s close'],
    ['Took', `${M.seconds}s in your browser`],
  ];
  const printed = (R.printed || []).length
    ? `<section class="lab-sec"><h3>Printed by the strategy</h3><pre class="lab-pre">${esc(R.printed.join('\n'))}</pre></section>` : '';

  host.innerHTML = `
  <div class="lab-report">
    <div class="lab-rhead">
      <div class="lab-rtitle"><h2>${esc(R.title)}</h2>
        <p class="dim">${market} · ${dateLocal(M.from)} to ${dateLocal(M.to)} · ${M.candles.toLocaleString('en-US')} candles (${yrs.toFixed(1)} years)</p></div>
      <div class="lab-ractions">
        ${opts.saved ? `<span class="lab-saved">${icon('check')}Saved in Results</span>` : opts.onSave ? `<button class="btn btn-sm btn-green" data-r="save">${icon('save')}Save in Results</button>` : ''}
        ${opts.onChart ? `<button class="btn btn-sm btn-green" data-r="chart" title="Open the Chart tab with this test's trades and the strategy's lines on the candles">${icon('chart')}Show on chart</button>` : ''}
        ${opts.onCode ? `<button class="btn btn-sm" data-r="code" title="The whole Python code that ran this backtest, as one file you can run anywhere">${icon('code')}Python code</button>` : ''}
        ${opts.onExport ? `<button class="btn btn-sm" data-r="export" title="A CSV file with every number, table and trade of this report">${icon('down')}Export CSV</button>` : ''}
        ${opts.onReuse ? `<button class="btn btn-sm" data-r="reuse" title="Put this test's settings in the form">${icon('edit')}Use these settings</button>` : ''}
        ${opts.onDelete ? `<button class="btn btn-sm" data-r="delete">${icon('trash')}Delete</button>` : ''}
      </div>
    </div>
    <div class="lab-warn"><b>Read this first</b><ul>${R.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
    <div class="lab-tiles">${tiles.join('')}</div>
    <section class="lab-sec"><h3>Account value</h3><p class="dim small">The strategy (green) against simply buying ${esc(M.symbol)} with the same money and holding it, without fees or funding (grey). Below: how far the account was under its last high.</p>
      <div class="lab-chart" data-c="eq"></div><div class="lab-chart small" data-c="dd"></div></section>
    <section class="lab-sec"><h3>Price chart with every trade</h3><p class="dim small">Drag to move, scroll or pinch to zoom; click a trade in the list below to jump to it. ▲ long entry, ▼ short entry, ● exit (green = profit, red = loss).</p>
      <div class="lab-bar" data-c="bar"><button class="btn btn-sm" data-k="all">Whole period</button><button class="btn btn-sm" data-k="prev">◀ Previous trade</button><button class="btn btn-sm" data-k="next">Next trade ▶</button>
        <button class="btn btn-sm btn-icon" data-k="in" aria-label="Zoom in">${icon('zoomin')}</button><button class="btn btn-sm btn-icon" data-k="out" aria-label="Zoom out">${icon('zoomout')}</button><span class="dim small" data-sel></span></div>
      <div class="lab-chart tall" data-c="px"><p class="faint lab-empty-chart">Loading the candles…</p></div></section>
    <div class="lab-two">
      <section class="lab-sec"><h3>Before and after costs</h3><p class="dim small">Fees ${money(-(ts.fees || 0))} · slippage ${money(-(ts.slippage || 0))} · funding ${money(ts.funding || 0)}</p>${table(['', 'Before costs', 'After costs'], costsRows)}</section>
      <section class="lab-sec"><h3>By year</h3>${table(['Year', 'Return', 'Trades closed', 'Profit'], years)}</section>
    </div>
    ${held}
    <div class="lab-two">
      <section class="lab-sec"><h3>Long and short</h3>${table(['Side', 'Trades', 'Win rate', 'Profit', 'Average'], groupRows(R.groups.side))}</section>
      <section class="lab-sec"><h3>How trades ended</h3>${table(['Exit', 'Trades', 'Win rate', 'Profit', 'Average'], groupRows(R.groups.reason))}</section>
    </div>
    <section class="lab-sec"><h3>Monthly returns (%)</h3>${table(['Year', ...MONTHS], mrows, 'months')}</section>
    <section class="lab-sec"><h3>Spread of trade results</h3><p class="dim small">Trades counted by result in R (1R = what the first stop would lose). A healthy trend strategy has many small losses near -1R and a few big wins far to the right.</p><div class="lab-chart small" data-c="hist"></div></section>
    <section class="lab-sec"><h3>All trades</h3><div data-c="trades"></div></section>
    <section class="lab-sec"><h3>Settings</h3>${table(['', ''], settings, 'kv')}</section>
    ${printed}
    <p class="faint small">How the engine fills orders: decisions are made at a candle’s close using only candles up to it; market orders fill at the next open. If one candle touches both the stop and the target, the stop is assumed to come first; a candle that opens beyond the stop fills at that open. Past results don’t predict future ones.</p>
  </div>`;

  const q = (k) => $(`[data-c="${k}"]`, host);
  requestAnimationFrame(() => equityChart(q('eq'), q('dd'), R));
  histogram(q('hist'), R.rs);

  // trade list (100 per page), linked to the price chart
  const T = R.trades, per = 100;
  let page = 0, chart = null;
  const tbox = q('trades');
  function renderTrades(mark = -1) {
    if (!T.length) { tbox.innerHTML = '<p class="dim">No trades.</p>'; return; }
    const a = page * per, b = Math.min(T.length, a + per);
    let h = `<div class="lab-pager"><button class="btn btn-sm" data-p="-1" ${page ? '' : 'disabled'}>◀</button><span class="dim small">Trades ${a + 1}–${b} of ${T.length.toLocaleString('en-US')}</span><button class="btn btn-sm" data-p="1" ${b < T.length ? '' : 'disabled'}>▶</button></div>`;
    h += '<div class="lab-scroll"><table class="lab-table trades"><thead><tr><th>#</th><th>Side</th><th>Entry (your time)</th><th>Entry price</th><th>Exit (your time)</th><th>Exit price</th><th>Exit</th><th>Candles</th><th>Fees + funding</th><th>Profit</th><th>R</th><th>Return</th></tr></thead><tbody>';
    for (let k = a; k < b; k++) {
      const t = T[k], c = tone(t.pnl);
      h += `<tr data-t="${k}" class="${k === mark ? 'on' : ''}" tabindex="0"><td>${k + 1}</td><td><span class="side ${t.side > 0 ? 'long' : 'short'}">${t.side > 0 ? 'Long' : 'Short'}</span></td><td>${fmtD(t.et, true)}</td><td>${price(t.ep)}</td><td>${fmtD(t.xt, true)}</td><td>${price(t.xp)}</td><td>${esc(t.why)}</td><td>${t.bars}</td><td>${money(-t.fees + t.fund)}</td><td class="${c}">${money(t.pnl)}</td><td class="${c}">${isNum(t.r) ? (t.r >= 0 ? '+' : '') + t.r.toFixed(2) : '–'}</td><td class="${c}">${(t.ret * 100).toFixed(2)}%</td></tr>`;
    }
    tbox.innerHTML = h + '</tbody></table></div>';
  }
  renderTrades();
  tbox.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]');
    if (p) { page = Math.max(0, Math.min(Math.ceil(T.length / per) - 1, page + Number(p.dataset.p))); renderTrades(); return; }
    const row = e.target.closest('tr[data-t]');
    if (row && chart) { chart.show(Number(row.dataset.t)); q('px').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  tbox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-t]') && chart) chart.show(Number(e.target.dataset.t)); });

  const mark = (k) => {
    if (k < 0) { $$('tr.on', tbox).forEach((r) => r.classList.remove('on')); return; }
    const p = Math.floor(k / per);
    if (p !== page) { page = p; renderTrades(k); } else { $$('tr.on', tbox).forEach((r) => r.classList.remove('on')); const r = $(`tr[data-t="${k}"]`, tbox); if (r) r.classList.add('on'); }
  };
  const drawPrice = (candles) => {
    // Only the candles the test covered (the dates in the settings can cut the dataset).
    const lo = lowerBound(candles.cols.t, M.from), hi = lowerBound(candles.cols.t, M.to + 1);
    const K = { n: hi - lo, t: candles.cols.t.subarray(lo, hi), o: candles.cols.o.subarray(lo, hi), h: candles.cols.h.subarray(lo, hi), l: candles.cols.l.subarray(lo, hi), c: candles.cols.c.subarray(lo, hi) };
    if (K.n < 2) { q('px').innerHTML = '<p class="faint lab-empty-chart">The dataset doesn’t cover these dates any more.</p>'; return; }
    chart = priceChart(q('px'), q('bar'), K, R, mark);
  };
  if (opts.candles) requestAnimationFrame(() => drawPrice(opts.candles));
  else if (opts.loadCandles) {
    opts.loadCandles().then(drawPrice).catch(() => {
      q('px').innerHTML = '<p class="faint lab-empty-chart">The price chart needs this test’s dataset, which is no longer in your Lab. Everything else above and below is complete.</p>';
    });
  }

  $('.lab-ractions', host).addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b || b.disabled) return;
    if (b.dataset.r === 'save') opts.onSave(b);
    if (b.dataset.r === 'export') opts.onExport();
    if (b.dataset.r === 'code') opts.onCode();
    if (b.dataset.r === 'chart') opts.onChart();
    if (b.dataset.r === 'reuse') opts.onReuse();
    if (b.dataset.r === 'delete') opts.onDelete(b);
  });
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/** The headline numbers kept with a saved result (shown in the Results lists). */
export function brief(R) {
  const sm = R.summary, ts = sm.trades || {};
  return {
    symbol: R.meta.symbol, interval: R.meta.interval, strategy: R.meta.strategy_label, source: R.meta.source, market: R.meta.market,
    from: R.meta.from, to: R.meta.to, return: sm.return, max_dd: sm.max_dd, trades: ts.n || 0, win_rate: ts.win_rate ?? null,
    r_avg: ts.r_avg ?? null, bh_return: sm.bh_return ?? null, settings: R.meta.settings_text.slice(0, 300), dataset: R.meta.dataset,
  };
}

/* ---------- the report as a CSV file ---------- */

const cell = (x) => {
  if (x === null || x === undefined || (typeof x === 'number' && !Number.isFinite(x))) return x === Infinity ? 'inf' : '';
  const t = String(x);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const r4 = (x, d = 2) => { x = v(x); return isNum(x) ? Number(x.toFixed(d)) : x === Infinity ? 'inf' : ''; };
const p2 = (x) => { x = v(x); return isNum(x) ? Number((x * 100).toFixed(2)) : ''; };
const px = (x) => (isNum(x) ? Number(x.toPrecision(10)) : '');
const iso = (ms, time = true) => (isNum(ms) ? fmtD(ms, time) : '');

/** The whole report as a CSV file (opens in Excel or Google Sheets): one section per part of the dashboard. */
export function resultCSV(R) {
  const sm = R.summary, gs = R.gross, ts = sm.trades || {}, g = gs.trades || {}, M = R.meta, S = R.settings;
  const rows = [];
  const add = (...cells) => rows.push(cells.map(cell).join(','));
  const gap = (title) => { rows.push(''); add(title); };
  const src = M.source === 'upload' ? 'Uploaded' : 'Binance';
  add('MEDUSA Lab backtest report');
  add('Test', R.title);
  add('Data', `${M.symbol} ${M.interval} candles, ${src} ${M.market}`, 'File', M.dataset_name || '');
  add(`Period (${zoneLabel()})`, `${iso(M.from)} to ${iso(M.to)}`, 'Candles', M.candles);
  add('Strategy', M.strategy_label);
  add('Strategy settings', M.settings_text);
  add('Costs', `fee ${(S.fee * 100).toFixed(3)}% + slippage ${(S.slippage * 100).toFixed(3)}% per fill; funding ${S.funding ? 'paid/received at the real rates' : 'not included'}`);
  add('Position size', S.sizing === 'risk' ? `risk ${S.risk_pct}% of the account per trade` : `${S.notional_pct}% of the account per trade`);
  add('Leverage cap (x)', S.max_leverage, 'Compounding', S.compounding ? 'yes' : 'no', 'Starting money (USDT)', S.capital);
  add('Market orders fill at', S.fill === 'next_open' ? "the next candle's open" : "the signal candle's close");
  add(`Made (${zoneLabel()})`, iso(M.made), 'Took (seconds)', M.seconds);

  gap('READ THIS FIRST');
  for (const w of R.warnings) add(w);

  gap('SUMMARY');
  add('Metric', 'After costs', 'Before costs', 'Buy and hold');
  add('Net profit (USDT)', r4(sm.net), r4(gs.net), r4(isNum(sm.bh_return) ? sm.bh_return * sm.capital : null));
  add('Final balance (USDT)', r4(sm.final), r4(gs.final), r4(isNum(sm.bh_return) ? (1 + sm.bh_return) * sm.capital : null));
  add('Return (%)', p2(sm.return), p2(gs.return), p2(sm.bh_return));
  add('Yearly growth, CAGR (%)', p2(sm.cagr), p2(gs.cagr), '');
  add('Worst drawdown (%)', p2(-sm.max_dd), p2(-gs.max_dd), p2(-(sm.bh_max_dd || 0)));
  add('Longest time below a previous high (days)', r4(sm.longest_dd_days, 0), r4(gs.longest_dd_days, 0), '');
  add('Sharpe ratio', r4(sm.sharpe), r4(gs.sharpe), '');
  add('Sortino ratio', r4(sm.sortino), r4(gs.sortino), '');
  add('Calmar ratio (CAGR / drawdown)', r4(sm.calmar), r4(gs.calmar), '');
  add('Time in the market (%)', p2(sm.exposure), p2(gs.exposure), 100);
  add('Trades', ts.n || 0, g.n || 0, 1);
  add('Long trades', ts.longs || 0, g.longs || 0, '');
  add('Short trades', ts.shorts || 0, g.shorts || 0, '');
  add('Win rate (%)', p2(ts.win_rate), p2(g.win_rate), '');
  add('Profit factor', r4(ts.profit_factor), r4(g.profit_factor), '');
  add('Average trade (R)', r4(ts.r_avg, 4), r4(g.r_avg, 4), '');
  add('Average trade t-statistic', r4(ts.r_t), r4(g.r_t), '');
  add('Total (R)', r4(ts.r_total), r4(g.r_total), '');
  add('Average trade (USDT)', r4(ts.avg), r4(g.avg), '');
  add('Average winning trade (USDT)', r4(ts.avg_win), r4(g.avg_win), '');
  add('Average losing trade (USDT)', r4(ts.avg_loss), r4(g.avg_loss), '');
  add('Average win / average loss', r4(ts.payoff), r4(g.payoff), '');
  add('Best trade (USDT)', r4(ts.best), r4(g.best), '');
  add('Worst trade (USDT)', r4(ts.worst), r4(g.worst), '');
  add('Most wins in a row', ts.max_wins ?? '', g.max_wins ?? '', '');
  add('Most losses in a row', ts.max_losses ?? '', g.max_losses ?? '', '');
  add('Average candles held', r4(ts.avg_bars, 1), r4(g.avg_bars, 1), '');
  add('Fees paid (USDT)', r4(-(ts.fees || 0)), 0, '');
  add('Slippage paid (USDT)', r4(-(ts.slippage || 0)), 0, '');
  add('Funding (USDT, + = received)', r4(ts.funding || 0), 0, '');
  add('Highest leverage used (x)', r4(sm.max_leverage_used), r4(gs.max_leverage_used), 1);
  add('Liquidations', sm.liquidations || 0, gs.liquidations || 0, '');
  add('Entries skipped', sm.skipped || 0, gs.skipped || 0, '');

  if (R.split) {
    gap(`HELD-BACK CHECK (split on ${iso(R.split_at, false)})`);
    add('Period', 'From', 'To', 'Return (%)', 'Worst drawdown (%)', 'Trades', 'Win rate (%)', 'Average trade (R)', 't-statistic');
    for (const [k, label] of [['before', 'Before'], ['after', 'From']]) {
      const x = R.split[k];
      if (x) add(`${label} ${iso(R.split_at, false)}`, iso(x.from), iso(x.to), p2(x.return), p2(-x.max_dd), x.trades.n || 0, p2(x.trades.win_rate), r4(x.trades.r_avg, 4), r4(x.trades.r_t));
    }
  }

  gap('BY YEAR');
  add('Year', 'Return (%)', 'Trades closed', 'Profit (USDT)');
  for (const y of R.years) add(y.year, p2(y.return), y.trades, r4(y.net));

  gap('MONTHLY RETURNS (%)');
  add('Year', ...MONTHS);
  for (const y of Object.keys(R.monthly).sort()) add(y, ...R.monthly[y].map(p2));

  for (const [title, key] of [['LONG AND SHORT', 'side'], ['HOW TRADES ENDED', 'reason']]) {
    gap(title);
    add(key === 'side' ? 'Side' : 'Exit', 'Trades', 'Win rate (%)', 'Profit (USDT)', 'Average trade (R)', 'Profit factor');
    for (const [k, st] of R.groups[key]) add(k, st.n, p2(st.win_rate), r4(st.net), r4(st.r_avg, 4), r4(st.profit_factor));
  }

  gap('SPREAD OF TRADE RESULTS (R)');
  add('From R', 'To R', 'Trades');
  const bins = new Map();
  for (const r of R.rs) { const b = Math.max(-5, Math.min(9.5, Math.floor(r * 2) / 2)); bins.set(b, (bins.get(b) || 0) + 1); }
  for (const b of [...bins.keys()].sort((a, c) => a - c)) add(b <= -5 ? 'below -4.5' : b, b >= 9.5 ? 'above' : b + 0.5, bins.get(b));

  gap('ALL TRADES');
  add('#', 'Side', `Entry time (${zoneLabel()})`, 'Entry price', `Exit time (${zoneLabel()})`, 'Exit price', 'Exit reason', 'Candles held', 'Quantity', 'Leverage (x)', 'Stop', 'Target', 'Fees (USDT)', 'Funding (USDT)', 'Profit (USDT)', 'R', 'Return (%)', 'Tag');
  R.trades.forEach((t, k) => add(k + 1, t.side > 0 ? 'Long' : 'Short', iso(t.et), px(t.ep), iso(t.xt), px(t.xp), t.why, t.bars, Number(t.qty.toPrecision(8)), t.lev, px(t.stop), px(t.tp), r4(-t.fees, 4), r4(t.fund, 4), r4(t.pnl, 4), r4(t.r, 4), p2(t.ret), t.tag));

  gap('ACCOUNT VALUE OVER TIME');
  add(`Time (${zoneLabel()})`, 'Strategy (USDT)', 'Buy and hold (USDT)', 'Below its previous high (%)');
  const E = R.equity;
  for (let i = 0; i < E.t.length; i++) add(iso(E.t[i]), r4(E.s[i]), r4(E.bh[i]), p2(E.dd[i]));

  return new Blob(['﻿' + rows.join('\r\n') + '\r\n'], { type: 'text/csv' });
}

/** A file name for a result's CSV: "BTCUSDT-4h-turtle-2026-10-04.csv". */
export const resultCSVName = (R) => `${R.meta.symbol}-${R.meta.interval}-${String(R.meta.strategy).split(':').pop()}-${new Date(R.meta.made || Date.now()).toISOString().slice(0, 10)}.csv`.replace(/[^\w.-]/g, '_');
