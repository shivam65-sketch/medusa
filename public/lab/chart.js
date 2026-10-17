// MEDUSA Lab: the Chart tab. A TradingView-style candle chart of any file in the Downloads or Uploads
// folder: timeframes, indicators (on the candles and in their own panes), drawing tools, a candle-by-candle
// replay with practice trades, and backtests drawn on the candles (trades, the strategy's own lines, the
// account value), which can be run from here too. Loaded the first time the tab is opened (main.js).
// The chart itself is TradingView's free Lightweight Charts library (Apache 2.0, version 5), kept in
// vendor/ because the page may only load its own scripts.
//
// Times: the library draws times as UTC, so every time is shifted by this computer's time zone
// (SHIFT) before it goes to the chart. The chart then reads in local time, like the rest of MEDUSA.
// Candles are grouped into bigger timeframes on UTC boundaries, the way Binance does.
//
// Indicators are written as running calculations (one candle at a time), so the same code gives the
// value of every finished candle and of the candle still forming in a replay.

import { createChart, CandlestickSeries, BarSeries, LineSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, PriceScaleMode, LineStyle } from './vendor/lightweight-charts.mjs';
import { $, $$, esc, ymd, plural, INTERVAL_MS, DAY, toast, download, icon } from './util.js';
import * as data from './data.js';

let host = null;
let ctx = null;
const SHIFT = -new Date().getTimezoneOffset() * 60;           // seconds added to every time
const UP = '#22c55e', DOWN = '#f04b4b';
const UP_VOL = 'rgba(34,197,94,0.35)', DOWN_VOL = 'rgba(240,75,75,0.35)';
const TF_NAMES = Object.keys(INTERVAL_MS);
const SPEEDS = [0.5, 1, 2, 3, 5, 10, 20, 50];
const PANE_PX = 130;                                           // height added to the chart for each lower pane
const PLOT_COLORS = ['#fbbf24', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#60a5fa', '#f87171', '#2dd4bf', '#e879f9', '#facc15', '#94a3b8'];
const TOOLS = [
  ['trend', 'Trend line', '<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>'],
  ['hline', 'Horizontal line', '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>'],
  ['rect', 'Rectangle', '<rect x="4" y="6" width="16" height="12" rx="1"/>'],
  ['fib', 'Fibonacci retracement', '<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/>'],
  ['measure', 'Measure (price and time between two points)', '<path d="M4 20 20 4"/><path d="M7 17l2 2M10 14l2 2M13 11l2 2M16 8l2 2"/>'],
];
const IC = {
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  next: '<path d="M6 5v14l9-7z"/><path d="M18 5v14"/>',
  prev: '<path d="M18 5v14l-9-7z"/><path d="M6 5v14"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/><path d="M10.5 9v6l4.5-3z"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M8 12h8"/>',
  camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  log: '<path d="M4 20h16M4 4v16"/><path d="M6 17c4 0 6-3 7-6s3-6 7-6"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v5.5l-5 8.6A1.6 1.6 0 0 0 6.9 20h10.2a1.6 1.6 0 0 0 1.4-2.4l-5-8.6V3.5"/><path d="M7.6 14.5h8.8"/>',
};
const ic = (svg) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
const fin = Number.isFinite;

/* ======================= running calculations for the indicators ======================= */

/** A deep copy of an indicator's running state (its typed arrays and helper objects are copied too). */
function copyOf(o) {
  const c = Object.create(Object.getPrototypeOf(o));
  for (const k of Object.keys(o)) {
    const v = o[k];
    c[k] = v && typeof v === 'object' ? (ArrayBuffer.isView(v) ? v.slice() : copyOf(v)) : v;
  }
  return c;
}
/** The last n values pushed. */
class Ring {
  constructor(n) { this.n = Math.max(1, n | 0); this.a = new Float64Array(this.n); this.i = 0; this.len = 0; }
  push(x) { this.a[this.i] = x; this.i = (this.i + 1) % this.n; if (this.len < this.n) this.len++; }
  get full() { return this.len === this.n; }
  get oldest() { return this.a[this.i]; }                     // once full: the value pushed n pushes ago
  max() { let m = -Infinity; for (let q = 0; q < this.len; q++) if (this.a[q] > m) m = this.a[q]; return m; }
  min() { let m = Infinity; for (let q = 0; q < this.len; q++) if (this.a[q] < m) m = this.a[q]; return m; }
  sum() { let s = 0; for (let q = 0; q < this.len; q++) s += this.a[q]; return s; }
}
/** Simple moving average. Missing values before the first one are skipped; a missing value later makes
    the average missing until it has left the window (as MEDUSA's Python sma() does). */
class SMA {
  constructor(n) { this.r = new Ring(n); this.s = 0; this.bad = 0; }
  step(x) {
    const r = this.r, ok = fin(x);
    if (!ok && !r.len) return NaN;
    if (r.full) { const old = r.oldest; if (fin(old)) this.s -= old; else this.bad--; }
    if (ok) this.s += x; else this.bad++;
    r.push(ok ? x : NaN);
    return r.full && !this.bad ? this.s / r.n : NaN;
  }
}
/** Exponential moving average, started from the simple average of the first n values; RMA is Wilder's. */
class EMA {
  constructor(n, alpha) { this.n = Math.max(1, n | 0); this.al = alpha ?? 2 / (this.n + 1); this.k = 0; this.s = 0; this.v = NaN; }
  step(x) {
    if (!fin(x)) return NaN;
    this.k++;
    if (this.k < this.n) { this.s += x; return NaN; }
    this.v = this.k === this.n ? (this.s + x) / this.n : this.al * x + (1 - this.al) * this.v;
    return this.v;
  }
}
const RMA = (n) => new EMA(n, 1 / Math.max(1, n | 0));
/** True range (the first candle: its high minus its low). */
class TR {
  constructor() { this.pc = NaN; }
  step(h, l, c) { const t = fin(this.pc) ? Math.max(h - l, Math.abs(h - this.pc), Math.abs(l - this.pc)) : h - l; this.pc = c; return t; }
}
class RSI {
  constructor(n) { this.g = RMA(n); this.l = RMA(n); this.pc = NaN; }
  step(c) {
    if (!fin(this.pc)) { this.pc = c; return NaN; }
    const ch = c - this.pc;
    this.pc = c;
    const ag = this.g.step(ch > 0 ? ch : 0), al = this.l.step(ch < 0 ? -ch : 0);
    if (!fin(ag) || !fin(al)) return NaN;
    return al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  }
}

/**
 * The indicators. where: "price" (on the candles), "pane" (a pane of its own) or "vol" (volume bars).
 * params: [key, label, default, min, max, step]. lines: [name, colour, style ("thin", "dots", "hist")].
 * make(p) returns a running calculation: step(o, h, l, c, v, t) -> one value per line.
 * Formulas follow TradingView's built-in indicators.
 */
const IND = {
  vol: { label: 'Volume', where: 'vol' },
  ema1: { label: 'EMA', where: 'price', params: [['len', 'Length', 20, 1, 2000, 1]], lines: [['EMA', '#f5c542']], make: (p) => ({ e: new EMA(p.len), step(o, h, l, c) { return [this.e.step(c)]; } }) },
  ema2: { label: 'EMA', where: 'price', params: [['len', 'Length', 50, 1, 2000, 1]], lines: [['EMA', '#4ea1ff']], make: (p) => ({ e: new EMA(p.len), step(o, h, l, c) { return [this.e.step(c)]; } }) },
  sma: { label: 'SMA', where: 'price', params: [['len', 'Length', 200, 1, 2000, 1]], lines: [['SMA', '#e879f9']], make: (p) => ({ s: new SMA(p.len), step(o, h, l, c) { return [this.s.step(c)]; } }) },
  bb: {
    label: 'Bollinger Bands', where: 'price', params: [['len', 'Length', 20, 2, 1000, 1], ['mult', 'Standard deviations', 2, 0.1, 10, 0.1]],
    lines: [['Upper', 'rgba(56,189,248,0.85)', 'thin'], ['Basis', '#fb923c', 'thin'], ['Lower', 'rgba(56,189,248,0.85)', 'thin']], fill: [0, 2, 'rgba(56,189,248,0.07)'],
    make: (p) => ({
      r: new Ring(p.len),
      step(o, h, l, c) {
        const r = this.r;
        r.push(c);
        if (!r.full) return [NaN, NaN, NaN];
        const m = r.sum() / r.n;
        let d = 0;
        for (let q = 0; q < r.n; q++) { const x = r.a[q] - m; d += x * x; }
        const sd = Math.sqrt(d / r.n);
        return [m + p.mult * sd, m, m - p.mult * sd];
      },
    }),
  },
  kc: {
    label: 'Keltner Channels', where: 'price', params: [['len', 'Length', 20, 1, 1000, 1], ['mult', 'Multiplier', 2, 0.1, 10, 0.1], ['atr', 'ATR length', 10, 1, 1000, 1]],
    lines: [['Upper', '#34d399', 'thin'], ['Basis', '#34d399', 'thin'], ['Lower', '#34d399', 'thin']], fill: [0, 2, 'rgba(52,211,153,0.06)'],
    make: (p) => ({
      e: new EMA(p.len), tr: new TR(), a: RMA(p.atr),
      step(o, h, l, c) { const m = this.e.step(c), at = this.a.step(this.tr.step(h, l, c)); return [m + p.mult * at, m, m - p.mult * at]; },
    }),
  },
  dc: {
    label: 'Donchian Channels', where: 'price', params: [['len', 'Length', 20, 1, 1000, 1]],
    lines: [['Upper', '#60a5fa', 'thin'], ['Middle', '#fb923c', 'thin'], ['Lower', '#60a5fa', 'thin']], fill: [0, 2, 'rgba(96,165,250,0.06)'],
    make: (p) => ({
      hi: new Ring(p.len), lo: new Ring(p.len),
      step(o, h, l) { this.hi.push(h); this.lo.push(l); if (!this.hi.full) return [NaN, NaN, NaN]; const u = this.hi.max(), d = this.lo.min(); return [u, (u + d) / 2, d]; },
    }),
  },
  st: {
    label: 'Supertrend', where: 'price', params: [['atr', 'ATR length', 10, 1, 1000, 1], ['mult', 'Factor', 3, 0.1, 20, 0.1]],
    lines: [['Up trend', UP], ['Down trend', DOWN]],
    make: (p) => ({
      tr: new TR(), a: RMA(p.atr), pu: NaN, pl: NaN, pc: NaN, pst: NaN, had: false,
      step(o, h, l, c) {
        const at = this.a.step(this.tr.step(h, l, c));
        if (!fin(at)) { this.pc = c; return [NaN, NaN]; }
        const src = (h + l) / 2, ppu = fin(this.pu) ? this.pu : 0, ppl = fin(this.pl) ? this.pl : 0;
        let ub = src + p.mult * at, lb = src - p.mult * at;
        lb = lb > ppl || this.pc < ppl ? lb : ppl;
        ub = ub < ppu || this.pc > ppu ? ub : ppu;
        const dir = !this.had ? 1 : this.pst === this.pu ? (c > ub ? -1 : 1) : (c < lb ? 1 : -1);
        const line = dir === -1 ? lb : ub;
        Object.assign(this, { pu: ub, pl: lb, pc: c, pst: line, had: true });
        return dir === -1 ? [line, NaN] : [NaN, line];
      },
    }),
  },
  psar: {
    label: 'Parabolic SAR', where: 'price', params: [['start', 'Start', 0.02, 0.001, 1, 0.001], ['inc', 'Increment', 0.02, 0.001, 1, 0.001], ['max', 'Maximum', 0.2, 0.01, 1, 0.01]],
    lines: [['SAR', '#e5e7eb', 'dots']],
    make: (p) => ({
      i: 0, res: NaN, mm: NaN, acc: NaN, below: false, h1: NaN, l1: NaN, c1: NaN, h2: NaN, l2: NaN,
      step(o, h, l, c) {
        const i = this.i++;
        if (i === 0) { Object.assign(this, { h1: h, l1: l, c1: c }); return [NaN]; }
        let first = false;
        if (i === 1) {
          if (c > this.c1) Object.assign(this, { below: true, mm: h, res: this.l1 });
          else Object.assign(this, { below: false, mm: l, res: this.h1 });
          first = true;
          this.acc = p.start;
        }
        this.res += this.acc * (this.mm - this.res);
        if (this.below) { if (this.res > l) { first = true; Object.assign(this, { below: false, res: Math.max(h, this.mm), mm: l, acc: p.start }); } }
        else if (this.res < h) { first = true; Object.assign(this, { below: true, res: Math.min(l, this.mm), mm: h, acc: p.start }); }
        if (!first) {
          if (this.below) { if (h > this.mm) { this.mm = h; this.acc = Math.min(this.acc + p.inc, p.max); } }
          else if (l < this.mm) { this.mm = l; this.acc = Math.min(this.acc + p.inc, p.max); }
        }
        if (this.below) { this.res = Math.min(this.res, this.l1); if (i > 1) this.res = Math.min(this.res, this.l2); }
        else { this.res = Math.max(this.res, this.h1); if (i > 1) this.res = Math.max(this.res, this.h2); }
        Object.assign(this, { h2: this.h1, l2: this.l1, h1: h, l1: l, c1: c });
        return [this.res];
      },
    }),
  },
  ichi: {
    label: 'Ichimoku Cloud', where: 'price', params: [['tenkan', 'Conversion line', 9, 1, 500, 1], ['kijun', 'Base line', 26, 1, 500, 1], ['senkou', 'Leading span B', 52, 1, 1000, 1], ['disp', 'Displacement', 26, 1, 500, 1]],
    lines: [['Conversion', '#38bdf8'], ['Base', '#f87171'], ['Span A', 'rgba(74,222,128,0.8)', 'thin'], ['Span B', 'rgba(248,113,113,0.8)', 'thin']],
    fill: [2, 3, (a, b) => (a >= b ? 'rgba(74,222,128,0.13)' : 'rgba(248,113,113,0.13)')],
    make: (p) => ({
      h1: new Ring(p.tenkan), l1: new Ring(p.tenkan), h2: new Ring(p.kijun), l2: new Ring(p.kijun), h3: new Ring(p.senkou), l3: new Ring(p.senkou),
      qa: new Ring(Math.max(1, p.disp - 1)), qb: new Ring(Math.max(1, p.disp - 1)),
      step(o, h, l) {
        for (const r of [this.h1, this.h2, this.h3]) r.push(h);
        for (const r of [this.l1, this.l2, this.l3]) r.push(l);
        const mid = (a, b) => (a.full ? (a.max() + b.min()) / 2 : NaN);
        const tk = mid(this.h1, this.l1), kj = mid(this.h2, this.l2), a = (tk + kj) / 2, b = mid(this.h3, this.l3);
        if (p.disp <= 1) return [tk, kj, a, b];
        const A = this.qa.full ? this.qa.oldest : NaN, B = this.qb.full ? this.qb.oldest : NaN;   // the spans are drawn displacement-1 candles ahead
        this.qa.push(a);
        this.qb.push(b);
        return [tk, kj, A, B];
      },
    }),
  },
  vwap: {
    label: 'VWAP', note: 'resets each day at 00:00 UTC', intraday: true, where: 'price', lines: [['VWAP', '#a78bfa']],
    make: () => ({
      day: NaN, pv: 0, vv: 0,
      step(o, h, l, c, v, t) {
        const d = Math.floor(t / DAY);
        if (d !== this.day) Object.assign(this, { day: d, pv: 0, vv: 0 });
        const tp = (h + l + c) / 3;
        this.pv += tp * v;
        this.vv += v;
        return [this.vv > 0 ? this.pv / this.vv : tp];
      },
    }),
  },
  rsi: { label: 'RSI', where: 'pane', params: [['len', 'Length', 14, 1, 1000, 1]], lines: [['RSI', '#c084fc']], levels: [70, 30], range: [0, 100], make: (p) => ({ r: new RSI(p.len), step(o, h, l, c) { return [this.r.step(c)]; } }) },
  srsi: {
    label: 'Stoch RSI', where: 'pane', params: [['k', 'K', 3, 1, 100, 1], ['d', 'D', 3, 1, 100, 1], ['rsi', 'RSI length', 14, 1, 500, 1], ['stoch', 'Stochastic length', 14, 1, 500, 1]],
    lines: [['K', '#38bdf8'], ['D', '#fb923c']], levels: [80, 20], range: [0, 100],
    make: (p) => ({
      r: new RSI(p.rsi), w: new Ring(p.stoch), sk: new SMA(p.k), sd: new SMA(p.d),
      step(o, h, l, c) {
        const x = this.r.step(c);
        if (!fin(x)) return [NaN, NaN];
        this.w.push(x);
        if (!this.w.full) return [NaN, NaN];
        const lo = this.w.min(), hi = this.w.max();
        const k = this.sk.step(hi - lo > 1e-9 * Math.abs(hi) ? (100 * (x - lo)) / (hi - lo) : NaN);   // a flat RSI has no range
        return [k, this.sd.step(k)];
      },
    }),
  },
  stoch: {
    label: 'Stochastic', where: 'pane', params: [['len', '%K length', 14, 1, 500, 1], ['smooth', '%K smoothing', 1, 1, 100, 1], ['d', '%D smoothing', 3, 1, 100, 1]],
    lines: [['%K', '#38bdf8'], ['%D', '#fb923c']], levels: [80, 20], range: [0, 100],
    make: (p) => ({
      hi: new Ring(p.len), lo: new Ring(p.len), sk: new SMA(p.smooth), sd: new SMA(p.d),
      step(o, h, l, c) {
        this.hi.push(h);
        this.lo.push(l);
        if (!this.hi.full) return [NaN, NaN];
        const H = this.hi.max(), L = this.lo.min();
        const k = this.sk.step(H > L ? (100 * (c - L)) / (H - L) : NaN);
        return [k, this.sd.step(k)];
      },
    }),
  },
  macd: {
    label: 'MACD', where: 'pane', params: [['fast', 'Fast length', 12, 1, 500, 1], ['slow', 'Slow length', 26, 1, 500, 1], ['signal', 'Signal smoothing', 9, 1, 500, 1]],
    lines: [['Histogram', null, 'hist'], ['MACD', '#38bdf8'], ['Signal', '#fb923c']], levels: [0],
    make: (p) => ({
      f: new EMA(p.fast), s: new EMA(p.slow), g: new EMA(p.signal),
      step(o, h, l, c) {
        const a = this.f.step(c), b = this.s.step(c);
        const m = fin(a) && fin(b) ? a - b : NaN, sg = this.g.step(m);
        return [fin(m) && fin(sg) ? m - sg : NaN, m, sg];
      },
    }),
  },
  atr: { label: 'ATR', where: 'pane', price: true, params: [['len', 'Length', 14, 1, 1000, 1]], lines: [['ATR', '#f87171']], make: (p) => ({ tr: new TR(), a: RMA(p.len), step(o, h, l, c) { return [this.a.step(this.tr.step(h, l, c))]; } }) },
  adx: {
    label: 'ADX / DMI', where: 'pane', params: [['len', 'DI length', 14, 1, 500, 1], ['adx', 'ADX smoothing', 14, 1, 500, 1]],
    lines: [['ADX', '#f5c542'], ['+DI', '#22c55e'], ['−DI', '#f04b4b']],
    make: (p) => ({
      ph: NaN, pl: NaN, pc: NaN, t: RMA(p.len), sp: RMA(p.len), sm: RMA(p.len), ax: RMA(p.adx),
      step(o, h, l, c) {
        if (!fin(this.pc)) { Object.assign(this, { ph: h, pl: l, pc: c }); return [NaN, NaN, NaN]; }
        const up = h - this.ph, dn = this.pl - l;
        const tr = Math.max(h - l, Math.abs(h - this.pc), Math.abs(l - this.pc));
        Object.assign(this, { ph: h, pl: l, pc: c });
        const t = this.t.step(tr), a = this.sp.step(up > dn && up > 0 ? up : 0), b = this.sm.step(dn > up && dn > 0 ? dn : 0);
        if (!fin(t) || !fin(a) || !fin(b) || t === 0) return [NaN, NaN, NaN];
        const pdi = (100 * a) / t, mdi = (100 * b) / t, s = pdi + mdi;
        return [this.ax.step((100 * Math.abs(pdi - mdi)) / (s === 0 ? 1 : s)), pdi, mdi];
      },
    }),
  },
  cci: {
    label: 'CCI', where: 'pane', params: [['len', 'Length', 20, 1, 1000, 1]], lines: [['CCI', '#38bdf8']], levels: [100, -100],
    make: (p) => ({
      r: new Ring(p.len),
      step(o, h, l, c) {
        const tp = (h + l + c) / 3, r = this.r;
        r.push(tp);
        if (!r.full) return [NaN];
        const m = r.sum() / r.n;
        let d = 0;
        for (let q = 0; q < r.n; q++) d += Math.abs(r.a[q] - m);
        d /= r.n;
        return [d > 0 ? (tp - m) / (0.015 * d) : 0];
      },
    }),
  },
  wpr: {
    label: 'Williams %R', where: 'pane', params: [['len', 'Length', 14, 1, 1000, 1]], lines: [['%R', '#c084fc']], levels: [-20, -80], range: [-100, 0],
    make: (p) => ({
      hi: new Ring(p.len), lo: new Ring(p.len),
      step(o, h, l, c) { this.hi.push(h); this.lo.push(l); if (!this.hi.full) return [NaN]; const H = this.hi.max(), L = this.lo.min(); return [H > L ? (-100 * (H - c)) / (H - L) : NaN]; },
    }),
  },
  obv: { label: 'OBV', where: 'pane', volume: true, lines: [['OBV', '#38bdf8']], make: () => ({ pc: NaN, x: 0, step(o, h, l, c, v) { if (fin(this.pc)) this.x += c > this.pc ? v : c < this.pc ? -v : 0; this.pc = c; return [this.x]; } }) },
  mfi: {
    label: 'MFI', where: 'pane', params: [['len', 'Length', 14, 1, 1000, 1]], lines: [['MFI', '#f472b6']], levels: [80, 20], range: [0, 100],
    make: (p) => ({
      pt: NaN, up: new Ring(p.len), dn: new Ring(p.len),
      step(o, h, l, c, v) {
        const tp = (h + l + c) / 3, ch = fin(this.pt) ? tp - this.pt : NaN;
        this.pt = tp;
        this.up.push(ch > 0 ? v * tp : 0);
        this.dn.push(ch < 0 ? v * tp : 0);
        if (!this.up.full) return [NaN];
        const U = this.up.sum(), D = this.dn.sum();
        return [D === 0 ? 100 : 100 - 100 / (1 + U / D)];
      },
    }),
  },
};

function defaultInd() {
  const o = {};
  for (const [k, d] of Object.entries(IND)) {
    o[k] = { on: k === 'vol' };
    for (const [pk, , def] of d.params || []) o[k][pk] = def;
  }
  return o;
}
function mergeInd(saved) {
  const o = defaultInd();
  for (const k of Object.keys(o)) if (saved && saved[k] && typeof saved[k] === 'object') Object.assign(o[k], saved[k]);
  return o;
}
const indLabel = (k) => { const d = IND[k]; return `${d.label}${(d.params || []).length ? ` ${(d.params || []).map(([pk]) => st.ind[k][pk]).join(' ')}` : ''}`; };

const CK = 512;                                                  // a copy of the running state is kept every CK candles
/** Runs one indicator over the chart's candles: the value of every candle, and tail() for a forming candle. */
function makeRunner(def, p, B) {
  const inst = def.make(p);
  const nl = def.lines.length;
  const L = Array.from({ length: nl }, () => new Float64Array(B.n));
  const snaps = [];
  for (let i = 0; i < B.n; i++) {
    if (i % CK === 0) snaps.push(copyOf(inst));
    const out = inst.step(B.O[i], B.H[i], B.L[i], B.C[i], B.V[i], B.T[i]);
    for (let q = 0; q < nl; q++) L[q][i] = out[q];
  }
  let cj = -1, cs = null, memo = null;
  return {
    lines: L,
    /** The values of candle j while it is still forming (bar: its prices so far; K: file candles shown). */
    tail(j, bar, K) {
      if (memo && memo.j === j && memo.K === K) return memo.v;
      if (cj !== j) {
        let from;
        if (cs && cj < j && j - cj <= CK) from = cj;
        else { cs = copyOf(snaps[Math.floor(j / CK)]); from = Math.floor(j / CK) * CK; }
        for (let i = from; i < j; i++) cs.step(B.O[i], B.H[i], B.L[i], B.C[i], B.V[i], B.T[i]);
        cj = j;
      }
      const v = copyOf(cs).step(bar.o, bar.h, bar.l, bar.c, bar.v, B.T[j]);
      memo = { j, K, v };
      return v;
    },
  };
}

/* ======================= state ======================= */

const st = {
  id: null, row: null, ds: null, base: 0, tf: 0, type: 'candles', ind: defaultInd(), log: false,
  loading: false, error: null,
  B: null,             // the chart's candles: {n, T, O, H, L, C, V, first (index of each bar's first file candle)}
  runners: new Map(),  // indicator results, kept while the candles stay the same
  feeds: [], groups: [], fills: [],
  tool: null, draft: null, drawings: [],
  replay: null,        // {k: file candles revealed, playing, timer, speed, by: 'bar'|'file', pos, trades}
  picking: false,
  shownTo: 0, K: 0,    // the last chart candle shown, and the file candles shown
  strat: null,         // the backtest drawn on the chart (see setStrat)
  pending: null,       // a result to draw once its data file is open
  sform: null,         // the Strategy menu's choices
  menu: null,          // the open toolbar menu ("ind" or "strat")
  running: false,
};
let chart = null, main = null, vol = null, layer = null, markersApi = null, hlines = [], posLine = null;

const load = (k, d) => ctx.store.get('chart.' + k, d);
const save = (k, v) => ctx.store.set('chart.' + k, v);

/* ======================= the page ======================= */

export function paintChart(el, context) {
  ctx = context;
  if (host !== el || !el.dataset.ready) {
    host = el;
    el.dataset.ready = '1';
    const saved = load('view', {});
    st.type = saved.type || 'candles';
    st.log = Boolean(saved.log);
    st.ind = mergeInd(saved.ind);
    st.id = st.id || saved.id || null;                          // show() may have picked a file already
    st.wantTf = st.wantTf || saved.tf || 0;
    st.sform = Object.assign({ strategy: 'turtle', params: {}, save: false }, load('sform', {}));
    st.sshow = Object.assign({ trades: true, lines: true, equity: false }, load('sshow', {}));
    el.innerHTML = `<div class="card lab-ch">
      <div class="lab-ch-bar" id="lab-ch-bar"></div>
      <div class="lab-ch-replay" id="lab-ch-replay" hidden></div>
      <div class="lab-ch-stage" id="lab-ch-stage">
        <div class="lab-ch-main" id="lab-ch-main"><div class="lab-ch-legend" id="lab-ch-legend"></div><div id="lab-ch-plegs"></div><div class="lab-ch-hint" id="lab-ch-hint" hidden></div></div>
        <div class="lab-ch-empty" id="lab-ch-empty"></div>
      </div>
      <div class="lab-ch-strat" id="lab-ch-strat" hidden></div>
      <p class="faint small lab-ch-foot">Scroll to zoom, drag to move, drag a price scale to stretch it (double-click it to reset), drag the line between panes to resize them. Times are in your time zone. Keys: <kbd>Esc</kbd> stops a drawing tool or closes a menu, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes a drawing; in a replay <kbd>Space</kbd> plays or pauses and <kbd>→</kbd> / <kbd>←</kbd> step. Chart by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts.</p>
    </div>`;
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('toggle', onToggle, true);
    watchClicks($('#lab-ch-main', el));
    document.addEventListener('pointerdown', closeMenusOutside, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', () => { const c = $('.lab-ch', host); if (c) c.classList.toggle('full', document.fullscreenElement === c); placeLegendsSoon(); });
    new ResizeObserver(() => placeLegendsSoon()).observe($('#lab-ch-main', el));
  }
  paintBar();
  paintEmpty();
  if (!st.ds && !st.loading) {
    const row = ctx.datasets().find((d) => d.id === st.id);
    if (row) openFile(row.id);
  }
}

/** The Lab's file list changed (main.js): refresh the file picker and the saved results. */
export function paintFiles() {
  if (!host) return;
  paintBar();
  paintEmpty();
  if (st.ds && !ctx.datasets().some((d) => d.id === st.id)) closeFile();
  else if (!st.ds && !st.loading && st.id && ctx.datasets().some((d) => d.id === st.id)) openFile(st.id);
}

/** Opens a data file from another tab ("Chart" button in Files). */
export function show(id) { if (host) openFile(id); else st.id = id; }

/** Draws a backtest result on the chart (the report's "Show on chart"), opening its data file first. */
export function showResult(R, id) {
  st.pending = { R, id };
  const ds = R.meta.dataset;
  st.wantTf = R.meta.interval_ms || INTERVAL_MS[R.meta.interval] || 0;
  if (!host) { st.id = ds; return; }
  if (st.id !== ds || !st.ds) { openFile(ds); return; }
  const pend = st.pending;
  st.pending = null;
  if (st.wantTf && st.wantTf !== st.tf && st.wantTf % st.base === 0) { st.tf = st.wantTf; saveView(); }
  st.wantTf = 0;
  setStrat(pend.R, pend.id);
}

const dsLabel = (d) => `${d.symbol} ${d.interval || ''} · ${d.market} · ${ymd(d.start_ts)} → ${ymd(d.end_ts)}`;
const tfName = (ms) => TF_NAMES.find((k) => INTERVAL_MS[k] === ms) || `${Math.round(ms / 60000)}m`;

function paintBar() {
  const bar = $('#lab-ch-bar', host);
  if (!bar) return;
  const rows = ctx.datasets();
  const group = (folder, name) => {
    const r = rows.filter((d) => d.folder === folder);
    return r.length ? `<optgroup label="${name} folder">${r.map((d) => `<option value="${d.id}" ${d.id === st.id ? 'selected' : ''}>${esc(dsLabel(d))}</option>`).join('')}</optgroup>` : '';
  };
  const tfs = st.base ? TF_NAMES.filter((k) => INTERVAL_MS[k] >= st.base && INTERVAL_MS[k] % st.base === 0) : [];
  const typeBtn = (t, label) => `<button class="lab-ch-seg ${st.type === t ? 'on' : ''}" data-ch="type" data-type="${t}" aria-pressed="${st.type === t}">${label}</button>`;
  const r = st.replay;
  const n = countOn();
  bar.innerHTML = `
    <select class="input lab-ch-file" data-ch="file" aria-label="Data file">
      <option value="">${rows.length ? 'Pick a data file…' : 'No data files yet'}</option>${group('downloads', 'Downloads')}${group('uploads', 'Uploads')}
    </select>
    <select class="input lab-ch-tf" data-ch="tf" aria-label="Timeframe" ${tfs.length ? '' : 'disabled'} title="Timeframe: the file's own candles, or bigger ones built from them">
      ${tfs.length ? tfs.map((k) => `<option value="${INTERVAL_MS[k]}" ${INTERVAL_MS[k] === st.tf ? 'selected' : ''}>${k}</option>`).join('') : '<option>–</option>'}
    </select>
    <span class="lab-ch-segs" role="group" aria-label="Chart type">${typeBtn('candles', 'Candles')}${typeBtn('bars', 'Bars')}${typeBtn('ha', 'Heikin Ashi')}${typeBtn('line', 'Line')}</span>
    <details class="lab-ch-menu" id="lab-ch-ind" data-menu="ind">
      <summary class="btn btn-sm">${icon('chart')}Indicators${n ? ` <b class="lab-ch-count">${n}</b>` : ''}</summary>
      <div class="lab-ch-pop lab-ch-ipop">
        <div class="lab-ch-ihead">On the candles</div>${Object.keys(IND).filter((k) => IND[k].where !== 'pane').map(indRow).join('')}
        <div class="lab-ch-ihead">In a pane of their own</div>${Object.keys(IND).filter((k) => IND[k].where === 'pane').map(indRow).join('')}
        <p class="faint small">The numbers are each indicator's settings (in candles where it is a length). Click outside this menu to close it.</p>
      </div>
    </details>
    <details class="lab-ch-menu" id="lab-ch-smenu" data-menu="strat">
      <summary class="btn btn-sm ${st.strat ? 'lab-ch-on' : ''}">${ic(IC.flask)}Strategy</summary>
      <div class="lab-ch-pop lab-ch-spop">${stratMenu()}</div>
    </details>
    <span class="lab-ch-tools" role="group" aria-label="Drawing tools">
      ${TOOLS.map(([t, label, svg]) => `<button class="btn btn-sm lab-ch-tool ${st.tool === t ? 'on' : ''}" data-ch="tool" data-tool="${t}" title="${label}" aria-label="${label}" aria-pressed="${st.tool === t}">${ic(svg)}</button>`).join('')}
      <button class="btn btn-sm lab-ch-tool" data-ch="undo" title="Undo the last drawing (Ctrl+Z)" aria-label="Undo the last drawing" ${st.drawings.length ? '' : 'disabled'}>${ic(IC.undo)}</button>
      <button class="btn btn-sm lab-ch-tool" data-ch="clear" title="Delete all drawings on this coin" aria-label="Delete all drawings" ${st.drawings.length ? '' : 'disabled'}>${icon('trash')}</button>
    </span>
    <button class="btn btn-sm lab-ch-tool ${st.log ? 'on' : ''}" data-ch="log" title="Logarithmic price scale" aria-pressed="${st.log}">${ic(IC.log)}Log</button>
    <span class="lab-ch-fill"></span>
    <input class="input lab-ch-date" type="date" data-ch="goto" aria-label="Go to a date" title="Go to a date" ${st.B ? '' : 'disabled'}>
    <button class="btn btn-sm" data-ch="fit" title="Show every candle" ${st.B ? '' : 'disabled'}>${ic(IC.fit)}<span class="sr-only">Show all</span></button>
    <button class="btn btn-sm" data-ch="png" title="Save the chart as a PNG picture" ${st.B ? '' : 'disabled'}>${ic(IC.camera)}<span class="sr-only">Save PNG</span></button>
    <button class="btn btn-sm" data-ch="full" title="Full screen" ${st.B ? '' : 'disabled'}>${icon('expand')}<span class="sr-only">Full screen</span></button>
    <button class="btn btn-sm ${r || st.picking ? 'btn-green' : ''}" data-ch="replay" title="Replay the chart candle by candle" ${st.B ? '' : 'disabled'}>${ic(IC.replay)}Replay</button>`;
  if (st.menu) { const d = $(`details[data-menu="${st.menu}"]`, bar); if (d) { d.open = true; fitPop(d); } }
}
/** Keeps an open menu inside the window (it opens under its button, so near the right edge it moves left). */
function fitPop(d) {
  const pop = $('.lab-ch-pop', d);
  if (!pop || innerWidth <= 640) return;
  pop.style.left = '0px';
  const r = pop.getBoundingClientRect();
  const over = r.right - (document.documentElement.clientWidth - 8);
  if (over > 0) pop.style.left = `${-Math.min(over, d.getBoundingClientRect().left - 8)}px`;
}

const countOn = () => Object.values(st.ind).filter((x) => x.on).length;
function indRow(k) {
  const d = IND[k], s = st.ind[k];
  const off = d.intraday && st.tf >= DAY;
  const dots = (d.lines || []).filter(([, c]) => c).slice(0, 3).map(([, c]) => `<i class="lab-ch-dot" style="background:${c}"></i>`).join('');
  return `<div class="lab-ch-irow">
    <label class="check"><input type="checkbox" data-ind="${k}" ${s.on ? 'checked' : ''} ${off ? 'disabled' : ''}><span>${esc(d.label)} ${dots}${d.note ? ` <span class="faint small">(${esc(d.note)})</span>` : ''}${off ? ' <span class="faint small">(timeframes under 1 day)</span>' : ''}</span></label>
    ${(d.params || []).length ? `<span class="lab-ch-iparams">${d.params.map(([pk, label, , min, max, step]) => `<input class="input lab-ch-num" type="number" min="${min}" max="${max}" step="${step}" value="${s[pk]}" data-ind-p="${k}" data-p="${pk}" title="${esc(label)}" aria-label="${esc(d.label)}: ${esc(label)}">`).join('')}</span>` : ''}
  </div>`;
}

function paintEmpty() {
  const el = $('#lab-ch-empty', host);
  if (!el) return;
  const rows = ctx.datasets();
  let html = '';
  if (st.loading) html = '<div class="lab-note"><span class="spin"></span> Opening the file…</div>';
  else if (st.error) html = `<div class="err">${esc(st.error)}</div>`;
  else if (!st.ds) html = rows.length
    ? `<div class="lab-note">Pick a data file above to draw its chart. Files come from the <button class="link" type="button" data-lab="tab" data-tab="files">Downloads and Uploads folders</button>.</div>`
    : `<div class="lab-note">No data files yet. <button class="link" type="button" data-lab="tab" data-tab="data">Download candles from Binance</button> into MEDUSA, then open them here.</div>`;
  el.innerHTML = html;
  el.hidden = !html;
  $('#lab-ch-main', host).hidden = !st.B;
}

/* ======================= opening a file ======================= */

async function openFile(id) {
  const row = ctx.datasets().find((d) => d.id === id);
  if (!row) {
    if (st.pending && st.pending.R.meta.dataset === id) { st.pending = null; toast('The data file of this result isn’t in MEDUSA any more.', 'error'); }
    return;
  }
  stopReplay(true);
  if (st.strat && st.strat.R.meta.dataset !== id) st.strat = null;
  Object.assign(st, { id, row, loading: true, error: null });
  st.runners.clear();
  saveView();
  paintBar();
  paintEmpty();
  try {
    const ds = await data.loadDataset(id);
    if (st.id !== id) return;
    if (ds.n < 2) throw new Error('This file has fewer than 2 candles.');
    st.ds = ds;
    st.B = null;
    st.base = INTERVAL_MS[row.interval] || INTERVAL_MS[ds.meta && ds.meta.interval] || gapOf(ds.cols.t);
    st.prec = precisionOf(ds.cols.c);
    const ok = (ms) => ms && ms % st.base === 0 && ms >= st.base;
    st.tf = ok(st.wantTf) ? st.wantTf : ok(st.tf) ? st.tf : defaultTf(ds.n, st.base);
    st.wantTf = 0;
    saveView();
    st.drawings = load(`draw.${drawKey()}`, []);
    ctx.log('lab', `Chart: ${row.symbol} ${tfName(st.tf)} (${plural(ds.n, 'candle')} in the file)`, null, 'debug');
  } catch (e) {
    if (st.id === id) { st.error = e.message; st.ds = null; st.B = null; }
  }
  st.loading = false;
  const pend = st.pending && st.pending.R.meta.dataset === id ? st.pending : null;
  st.pending = null;
  if (pend && st.ds) setStrat(pend.R, pend.id, false);
  build();
  if (!pend && !st.strat && st.ds) restoreStrat(id);
}

function closeFile() {
  stopReplay(true);
  Object.assign(st, { id: null, row: null, ds: null, B: null, strat: null });
  destroyChart();
  paintBar();
  paintEmpty();
  paintStrat();
}

const drawKey = () => `${st.row.symbol}-${st.row.market}`;
const saveView = () => save('view', { id: st.id, tf: st.tf, type: st.type, log: st.log, ind: st.ind });

/** The most common gap between candles (for uploaded files without a known timeframe). */
function gapOf(t) {
  const counts = new Map();
  for (let i = 1; i < Math.min(t.length, 2000); i++) { const g = t[i] - t[i - 1]; counts.set(g, (counts.get(g) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0] || 60_000;
}
/** Decimals the prices are written with (so 0.00001234 isn't shown as 0.00). */
function precisionOf(c) {
  let d = 2;
  for (let i = Math.max(0, c.length - 300); i < c.length; i++) {
    const s = String(c[i]);
    const k = s.includes('e-') ? Number(s.split('e-')[1]) + 2 : (s.split('.')[1] || '').length;
    if (k > d) d = k;
  }
  return Math.min(d, 10);
}
/** The smallest timeframe that keeps the chart under ~150,000 candles (it stays quick). */
function defaultTf(n, base) {
  const span = n * base;
  for (const k of TF_NAMES) { const ms = INTERVAL_MS[k]; if (ms >= base && ms % base === 0 && span / ms <= 150_000) return ms; }
  return INTERVAL_MS['1w'];
}

/* ======================= candles for the chosen timeframe ======================= */

/** Groups the file's candles into the timeframe's candles (UTC boundaries; weeks start Monday). */
function aggregate(ds, tf) {
  const { t, o, h, l, c } = ds.cols;
  const v = ds.cols.v || new Float64Array(ds.n);
  const anchor = tf === INTERVAL_MS['1w'] ? 4 * DAY : 0;   // 1 Jan 1970 was a Thursday
  const n0 = ds.n;
  const T = [], O = [], H = [], L = [], C = [], V = [], first = [];
  let cur = -Infinity;
  for (let i = 0; i < n0; i++) {
    const b = Math.floor((t[i] - anchor) / tf) * tf + anchor;
    if (b !== cur) {
      cur = b;
      T.push(b); O.push(o[i]); H.push(h[i]); L.push(l[i]); C.push(c[i]); V.push(v[i]); first.push(i);
    } else {
      const j = T.length - 1;
      if (h[i] > H[j]) H[j] = h[i];
      if (l[i] < L[j]) L[j] = l[i];
      C[j] = c[i];
      V[j] += v[i];
    }
  }
  first.push(n0);
  return { n: T.length, T: Float64Array.from(T), O: Float64Array.from(O), H: Float64Array.from(H), L: Float64Array.from(L), C: Float64Array.from(C), V: Float64Array.from(V), first: Int32Array.from(first) };
}

/** The chart candle j built only from file candles up to (not including) k: the forming candle in a replay. */
function partial(j, k) {
  const { o, h, l, c } = st.ds.cols;
  const v = st.ds.cols.v;
  const a = st.B.first[j], b = Math.min(k, st.B.first[j + 1]);
  let H = -Infinity, L = Infinity, V = 0;
  for (let i = a; i < b; i++) { if (h[i] > H) H = h[i]; if (l[i] < L) L = l[i]; if (v) V += v[i]; }
  return { o: o[a], h: H, l: L, c: c[b - 1], v: V };
}
const fullBar = (j) => ({ o: st.B.O[j], h: st.B.H[j], l: st.B.L[j], c: st.B.C[j], v: st.B.V[j] });
const sec = (ms) => ms / 1000 + SHIFT;
const unsec = (s) => (s - SHIFT) * 1000;

/** Heikin Ashi candles (for the "Heikin Ashi" chart type), with the forming candle too. */
function haOf(B) {
  const N = B.n, O = new Float64Array(N), H = new Float64Array(N), L = new Float64Array(N), C = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    C[i] = (B.O[i] + B.H[i] + B.L[i] + B.C[i]) / 4;
    O[i] = i ? (O[i - 1] + C[i - 1]) / 2 : (B.O[i] + B.C[i]) / 2;
    H[i] = Math.max(B.H[i], O[i], C[i]);
    L[i] = Math.min(B.L[i], O[i], C[i]);
  }
  return {
    O, H, L, C,
    tail(i, bar) {
      const c = (bar.o + bar.h + bar.l + bar.c) / 4, o = i ? (O[i - 1] + C[i - 1]) / 2 : (bar.o + bar.c) / 2;
      return { o, h: Math.max(bar.h, o, c), l: Math.min(bar.l, o, c), c };
    },
  };
}

/* ======================= the chart ======================= */

function destroyChart() {
  if (chart) chart.remove();
  chart = main = vol = layer = markersApi = posLine = null;
  hlines = [];
  st.feeds = [];
  st.groups = [];
  st.fills = [];
  const pl = host && $('#lab-ch-plegs', host);
  if (pl) pl.innerHTML = '';
}

const fmt = (p) => (fin(p) ? (Math.abs(p) >= 1e6 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(Math.min(st.prec ?? 2, Math.abs(p) >= 1000 ? 2 : 10))) : '–');
const shortNum = (v) => (!fin(v) ? '–' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : v.toFixed(2));
const pricePf = () => ({ type: 'price', precision: st.prec ?? 2, minMove: Number((10 ** -(st.prec ?? 2)).toFixed(st.prec ?? 2)) });
const baseOptions = () => ({
  autoSize: true,
  layout: {
    background: { type: 'solid', color: '#1c1c1c' }, textColor: '#b4b4b8', fontSize: 12, fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: false,
    panes: { separatorColor: '#333', separatorHoverColor: 'rgba(255,255,255,0.12)', enableResize: true },
  },
  grid: { vertLines: { color: 'rgba(255,255,255,0.045)' }, horzLines: { color: 'rgba(255,255,255,0.045)' } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(255,255,255,0.35)', labelBackgroundColor: '#3a3f4b' }, horzLine: { color: 'rgba(255,255,255,0.35)', labelBackgroundColor: '#3a3f4b' } },
  rightPriceScale: { borderColor: '#303030', minimumWidth: 86 },
  timeScale: { borderColor: '#303030', timeVisible: st.tf < DAY, secondsVisible: false, rightOffset: 12, barSpacing: 7, minBarSpacing: 0.02 },
  handleScale: { axisPressedMouseMove: { time: true, price: true } },
});
const lineOpts = (color, style, pf) => ({
  color, lineWidth: style === 'thin' ? 1 : 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: pf,
  ...(style === 'dots' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}),
});

/** A cached run of indicator k with its settings on the current candles. */
function runnerFor(k) {
  const key = `${k}|${JSON.stringify(st.ind[k])}|${st.B.tfKey}`;
  if (!st.runners.has(key)) st.runners.set(key, makeRunner(IND[k], st.ind[k], st.B));
  return st.runners.get(key);
}

/** (Re)builds the candles, indicators, strategy and chart for the current file, timeframe and settings. */
function build() {
  paintBar();
  if (!st.ds) { destroyChart(); paintEmpty(); paintStrat(); return; }
  const tfKey = `${st.id}:${st.tf}`;
  const same = st.B && st.B.tfKey === tfKey;
  const keepRange = chart && same ? chart.timeScale().getVisibleLogicalRange() : null;
  if (!same) {
    st.B = aggregate(st.ds, st.tf);
    st.B.tfKey = tfKey;
    st.runners.clear();
    if (st.B.n > 400_000) toast(`${st.B.n.toLocaleString('en-US')} candles: the chart may be slow. A bigger timeframe keeps it quick.`);
  }
  st.ha = st.type === 'ha' ? haOf(st.B) : null;
  paintEmpty();
  destroyChart();
  const el = $('#lab-ch-main', host);
  chart = createChart(el, baseOptions());
  const pf = pricePf();
  main = st.type === 'line' ? chart.addSeries(LineSeries, { color: '#e5e7eb', lineWidth: 2, priceFormat: pf })
    : st.type === 'bars' ? chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false, priceFormat: pf })
      : chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat: pf });
  chart.priceScale('right').applyOptions({ mode: st.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, scaleMargins: { top: 0.08, bottom: st.ind.vol.on ? 0.22 : 0.08 } });
  if (st.ind.vol.on) {
    vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }
  let pane = 1;
  for (const k of Object.keys(IND)) {
    const d = IND[k];
    if (d.where === 'vol' || !st.ind[k].on || (d.intraday && st.tf >= DAY)) continue;
    const runner = runnerFor(k);
    const where = d.where === 'pane' ? pane++ : 0;
    const spf = d.price ? pf : d.volume ? { type: 'volume' } : { type: 'price', precision: 2, minMove: 0.01 };
    const g = { key: k, label: indLabel(k), pane: where, feeds: [] };
    d.lines.forEach(([name, color, style], q) => {
      const series = style === 'hist'
        ? chart.addSeries(HistogramSeries, { priceFormat: spf, priceLineVisible: false, lastValueVisible: false }, where)
        : chart.addSeries(LineSeries, lineOpts(color, style, spf), where);
      g.feeds.push({ series, name, color: color || '#94a3b8', hist: style === 'hist', fmt: d.price ? fmt : d.volume ? shortNum : (v) => (fin(v) ? v.toFixed(2) : '–'),
        get: (j, K, bar, done) => (done ? runner.lines[q][j] : runner.tail(j, bar, K)[q]) });
    });
    if (where) {
      const first = g.feeds.find((f) => !f.hist) || g.feeds[0];
      for (const lv of d.levels || []) first.series.createPriceLine({ price: lv, color: 'rgba(255,255,255,0.28)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      if (d.range) for (const f of g.feeds) f.series.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: d.range[0], maxValue: d.range[1] } }) });
    }
    if (d.fill) st.fills.push({ a: g.feeds[d.fill[0]], b: g.feeds[d.fill[1]], color: d.fill[2] });
    st.groups.push(g);
    st.feeds.push(...g.feeds);
  }
  if (st.strat) addStrategySeries(() => pane++);
  const panes = chart.panes();
  el.style.setProperty('--panes', String(panes.length - 1));
  if (panes.length > 1) {
    const H = el.clientHeight || 420 + PANE_PX * (panes.length - 1);
    panes[0].setStretchFactor(Math.max(1.5, (H - PANE_PX * (panes.length - 1)) / PANE_PX));
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
  }
  layer = new Layer();
  main.attachPrimitive(layer);
  markersApi = createSeriesMarkers(main, []);
  chart.subscribeCrosshairMove(onMove);
  setAll(st.replay ? st.replay.k : st.ds.n);
  paintHlines();
  paintMarkers();
  if (st.replay) focusReplay();
  else if (keepRange) chart.timeScale().setVisibleLogicalRange(keepRange);
  else if (st.strat && st.strat.sel >= 0) focusTrade(st.strat.sel);
  else showRecent();
  paintPaneLegends();
  legend(null);
  paintReplay();
  paintStrat();
  placeLegendsSoon();
}

/** Shows the last ~160 candles, the way TradingView opens a chart. */
function showRecent(end = st.B.n - 1) {
  chart.timeScale().setVisibleLogicalRange({ from: end - 160, to: end + 12 });
}

/* Points for the chart, up to file candle K (everything when K = file length). */
function lastBar(k) { return bucketOf(k - 1); }
function bucketOf(i) {
  const f = st.B.first;
  let a = 0, b = st.B.n - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (f[m] <= i) a = m; else b = m - 1; }
  return a;
}
function barFor(j, k) {
  const done = k >= st.B.first[j + 1];
  return { bar: done ? fullBar(j) : partial(j, k), done };
}
function mainPoint(j, bar, done) {
  const time = sec(st.B.T[j]);
  if (st.type === 'line') return { time, value: bar.c };
  const b = st.ha ? (done ? { o: st.ha.O[j], h: st.ha.H[j], l: st.ha.L[j], c: st.ha.C[j] } : st.ha.tail(j, bar)) : bar;
  return { time, open: b.o, high: b.h, low: b.l, close: b.c };
}
const volPoint = (j, bar) => ({ time: sec(st.B.T[j]), value: bar.v, color: bar.c >= bar.o ? UP_VOL : DOWN_VOL });
const histColor = (v, pv) => (v >= 0 ? (fin(pv) && v < pv ? '#b2dfdb' : '#26a69a') : (fin(pv) && v > pv ? '#ffcdd2' : '#ff5252'));
/*
 * Gaps in a line (Supertrend's two halves, the start of every indicator): the library joins a line across
 * missing values, so a missing value is drawn as a hidden point at the last value, and the point before
 * a gap is hidden too (each piece of line takes the colour of the point it starts from).
 */
const HIDE = 'transparent';
function feedPoints(f, vals, J) {
  const out = new Array(J + 1);
  let last = NaN;
  for (let j = 0; j <= J; j++) {
    const time = sec(st.B.T[j]), v = vals[j];
    if (f.hist) out[j] = fin(v) ? { time, value: v, color: histColor(v, j > 0 ? vals[j - 1] : NaN) } : { time };
    else if (fin(v)) { last = v; out[j] = j < J && !fin(vals[j + 1]) ? { time, value: v, color: HIDE } : { time, value: v }; }
    else out[j] = fin(last) ? { time, value: last, color: HIDE } : { time };
  }
  f.last = last;
  f.lastOk = fin(vals[J]);
  f.lastJ = J;
  return out;
}
/** The point of chart candle j added or changed in a replay step (the candle before is hidden when a gap starts). */
function feedUpdate(f, j, K, bar, done) {
  const v = f.get(j, K, bar, done), time = sec(st.B.T[j]);
  if (f.hist) { f.series.update(fin(v) ? { time, value: v, color: histColor(v, j > 0 ? f.get(j - 1, K, null, true) : NaN) } : { time }); return; }
  if (fin(v)) {
    f.series.update({ time, value: v });
    Object.assign(f, { last: v, lastOk: true, lastJ: j });
    return;
  }
  if (f.lastOk && f.lastJ === j - 1) f.series.update({ time: sec(st.B.T[j - 1]), value: f.last, color: HIDE });
  f.series.update(fin(f.last) ? { time, value: f.last, color: HIDE } : { time });
  Object.assign(f, { lastOk: false, lastJ: j });
}
/** A line's value at chart candle j as shown now (the forming candle in a replay included). */
function valueAt(f, j) {
  const K = st.K;
  if (j < st.shownTo || K >= st.B.first[j + 1]) return f.get(j, K, null, true);
  return f.get(j, K, partial(j, K), false);
}

/** Sets every series to the candles revealed so far (file candles 0..K-1). */
function setAll(K) {
  const J = lastBar(K);
  const M = new Array(J + 1), Vv = vol ? new Array(J + 1) : null, vals = st.feeds.map(() => new Float64Array(J + 1));
  for (let j = 0; j <= J; j++) {
    const fb = j < J ? null : barFor(j, K);
    const bar = fb ? fb.bar : fullBar(j), done = fb ? fb.done : true;
    M[j] = mainPoint(j, bar, done);
    if (Vv) Vv[j] = volPoint(j, bar);
    for (let q = 0; q < st.feeds.length; q++) vals[q][j] = st.feeds[q].get(j, K, bar, done);
  }
  main.setData(M);
  if (vol) vol.setData(Vv);
  st.feeds.forEach((f, q) => f.series.setData(feedPoints(f, vals[q], J)));
  st.shownTo = J;
  st.K = K;
}

/** Moves a replay from file candle k0 to k1 (> k0) with small updates instead of redrawing it all. */
function advance(k0, k1) {
  const j0 = lastBar(k0), j1 = lastBar(k1);
  for (let j = j0; j <= j1; j++) {
    const { bar, done } = barFor(j, k1);
    main.update(mainPoint(j, bar, done));
    if (vol) vol.update(volPoint(j, bar));
    for (const f of st.feeds) feedUpdate(f, j, k1, bar, done);
  }
  st.shownTo = j1;
  st.K = k1;
}

/* ======================= the backtest on the chart ======================= */

/** Draws backtest result R (saved as `id`, or null) on the chart. */
function setStrat(R, id, rebuild = true) {
  const trades = (R.trades || []).map((x, n) => ({ ...x, n: n + 1 })).sort((a, b) => a.et - b.et);
  const s = { R, id: id || null, trades, sel: -1, plots: null, plotsErr: null, plotsLoading: true };
  st.strat = s;
  save(`strat.${R.meta.dataset}`, s.id);
  const key = R.config && R.config.strategy;
  if (key && (ctx.strategies() || []).some((x) => x.key === key)) {
    st.sform.strategy = key;
    st.sform.params[key] = { ...(R.meta.params || {}) };
    save('sform', st.sform);
  }
  ctx.plots(R).then((out) => {
    if (st.strat !== s) return;
    s.plotsLoading = false;
    if (out.error) { s.plotsErr = out.error; paintStrat(); return; }
    s.plots = prepPlots(out);
    if (s.plots.length) build(); else paintStrat();
  }).catch((e) => { if (st.strat === s) { s.plotsLoading = false; s.plotsErr = e.message; paintStrat(); } });
  if (rebuild) build();
}

function removeStrat() {
  if (!st.strat) return;
  save(`strat.${st.strat.R.meta.dataset}`, null);
  st.strat = null;
  build();
}

/** Re-opens the result last drawn on this file (if it is still in the Results folder). */
function restoreStrat(dataset) {
  const id = load(`strat.${dataset}`, null);
  if (!id || !(ctx.runs() || []).some((r) => r.id === id)) return;
  ctx.fetchResult(id).then((R) => { if (st.id === dataset && !st.strat && R.meta.dataset === dataset) setStrat(R, id); }).catch(() => {});
}

/** The strategy's lines from Python, lined up with the file's candles. */
function prepPlots(out) {
  const t = st.ds.cols.t;
  let a = 0, b = st.ds.n - 1;
  while (a < b) { const m = (a + b) >> 1; if (t[m] < out.start) a = m + 1; else b = m; }
  const p0 = a;
  return out.plots.map((p, i) => ({ name: p.name, kind: p.kind, values: p.values, p0, on: p.kind === 'price', color: PLOT_COLORS[i % PLOT_COLORS.length] }));
}

const nowT = () => (st.replay ? st.ds.cols.t[st.replay.k - 1] : Infinity);

/** The strategy's lines, its account value and buy & hold, as feeds like the indicators'. */
function addStrategySeries(nextPane) {
  const s = st.strat, B = st.B, t = st.ds.cols.t, pf = pricePf();
  const lastFile = (j) => B.first[j + 1] - 1;
  if (st.sshow.lines && s.plots) {
    const priceFeeds = [];
    for (const p of s.plots) {
      if (!p.on) continue;
      const bars = new Float64Array(B.n);
      for (let j = 0; j < B.n; j++) { const i = lastFile(j) - p.p0; bars[j] = i >= 0 && i < p.values.length ? p.values[i] : NaN; }
      const get = (j, K, bar, done) => { if (done) return bars[j]; const i = K - 1 - p.p0; return i >= 0 && i < p.values.length ? p.values[i] : NaN; };
      const where = p.kind === 'price' ? 0 : nextPane();
      const series = chart.addSeries(LineSeries, { ...lineOpts(p.color, '', p.kind === 'price' ? pf : { type: 'price', precision: 4, minMove: 0.0001 }), lineWidth: 2 }, where);
      const f = { series, name: p.name, color: p.color, get, fmt: p.kind === 'price' ? fmt : (v) => (fin(v) ? String(+v.toPrecision(5)) : '–') };
      if (where) st.groups.push({ key: `splot:${p.name}`, label: `${s.R.meta.strategy_label}: ${p.name}`, pane: where, feeds: [f] });
      else priceFeeds.push(f);
      st.feeds.push(f);
    }
    if (priceFeeds.length) st.groups.push({ key: 'splots', label: 'Strategy', pane: 0, feeds: priceFeeds });
  }
  if (st.sshow.equity && s.R.equity && s.R.equity.t && s.R.equity.t.length) {
    const E = s.R.equity, to = s.R.meta.to;
    const eqAt = (ms, arr) => {
      if (ms < E.t[0] || ms > to) return NaN;
      let a = 0, b = E.t.length - 1;
      while (a < b) { const m = (a + b + 1) >> 1; if (E.t[m] <= ms) a = m; else b = m - 1; }
      return arr[a];
    };
    const mk = (arr) => {
      const bars = new Float64Array(B.n);
      for (let j = 0; j < B.n; j++) bars[j] = eqAt(t[lastFile(j)], arr);
      return (j, K, bar, done) => (done ? bars[j] : eqAt(t[K - 1], arr));
    };
    const where = nextPane();
    const epf = { type: 'price', precision: 2, minMove: 0.01 };
    const money = (v) => (fin(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '–');
    const eq = { series: chart.addSeries(LineSeries, { ...lineOpts('#22c55e', '', epf), lastValueVisible: true }, where), name: 'Strategy', color: '#22c55e', get: mk(E.s), fmt: money };
    const bh = { series: chart.addSeries(LineSeries, lineOpts('rgba(203,213,225,0.55)', 'thin', epf), where), name: 'Buy & hold', color: '#94a3b8', get: mk(E.bh), fmt: money };
    eq.series.createPriceLine({ price: s.R.settings.capital, color: 'rgba(255,255,255,0.25)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
    st.groups.push({ key: 'equity', label: 'Account value', pane: where, feeds: [eq, bh] });
    st.feeds.push(eq, bh);
  }
}

/** The trades shown now (in a replay: the ones that have started). */
const shownTrades = () => { const s = st.strat, now = nowT(); return s ? s.trades.filter((x) => x.et <= now) : []; };
const tradeResult = (x) => (x.r != null && fin(x.r) ? `${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R` : `${x.ret >= 0 ? '+' : ''}${(x.ret * 100).toFixed(2)}%`);
const openResult = (x) => { const p = st.ds.cols.c[st.K - 1]; return { p, ret: ((p - x.ep) / x.ep) * x.side }; };

function paintMarkers() {
  if (!markersApi || !st.B) return;
  const m = [];
  const now = nowT();
  const at = (ms) => sec(st.B.T[indexOfTime(ms)]);
  const s = st.strat;
  if (s && st.sshow.trades) {
    for (const x of s.trades) {
      if (x.et > now) break;
      const sel = s.sel === x.n - 1, long = x.side > 0;
      m.push({ time: at(x.et), position: long ? 'belowBar' : 'aboveBar', color: long ? UP : DOWN, shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'Long' : 'Short', size: sel ? 2 : 1, id: `e${x.n}` });
      if (x.xt <= now) m.push({ time: at(x.xt), position: long ? 'aboveBar' : 'belowBar', color: x.pnl >= 0 ? '#86efac' : '#fca5a5', shape: 'circle', text: tradeResult(x), size: sel ? 1.4 : 0.7, id: `x${x.n}` });
    }
  }
  const r = st.replay;
  if (r) {
    for (const x of r.trades) {
      if (x.t <= now) m.push({ time: at(x.t), position: x.side === 'long' ? 'belowBar' : 'aboveBar', color: '#facc15', shape: x.side === 'long' ? 'arrowUp' : 'arrowDown', text: x.side === 'long' ? 'Buy' : 'Sell' });
      if (x.xt <= now) m.push({ time: at(x.xt), position: x.side === 'long' ? 'aboveBar' : 'belowBar', color: '#facc15', shape: 'circle', text: `${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(2)}%` });
    }
    if (r.pos) m.push({ time: at(r.pos.t), position: r.pos.side === 'long' ? 'belowBar' : 'aboveBar', color: '#facc15', shape: r.pos.side === 'long' ? 'arrowUp' : 'arrowDown', text: r.pos.side === 'long' ? 'Buy' : 'Sell' });
  }
  m.sort((a, b) => a.time - b.time);
  markersApi.setMarkers(m);
  if (posLine) { main.removePriceLine(posLine); posLine = null; }
  if (r && r.pos) posLine = main.createPriceLine({ price: r.pos.entry, color: '#facc15', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: r.pos.side === 'long' ? 'Long' : 'Short' });
}

/** Centres trade i on the chart and marks it. */
function focusTrade(i) {
  const s = st.strat;
  if (!s || !s.trades[i]) return;
  const x = s.trades[i];
  if (x.et > nowT()) return;
  s.sel = i;
  const eb = indexOfTime(x.et), xb = x.xt <= nowT() ? indexOfTime(x.xt) : st.shownTo;
  const pad = Math.max(25, (xb - eb) * 0.7);
  chart.timeScale().setVisibleLogicalRange({ from: eb - pad, to: xb + pad });
  paintMarkers();
  if (layer) layer.redraw();
  paintStrat(true);
}
function stepTrade(dir) {
  const s = st.strat;
  if (!s) return;
  const list = shownTrades();
  if (!list.length) { toast(st.replay ? 'No trades yet at this point of the replay.' : 'This test made no trades.'); return; }
  let pos;
  const cur = list.findIndex((x) => x.n - 1 === s.sel);
  if (cur >= 0) pos = cur + dir;
  else {
    const r = chart.timeScale().getVisibleLogicalRange();
    const mid = r ? (r.from + r.to) / 2 : st.shownTo;
    if (dir > 0) { pos = list.findIndex((x) => indexOfTime(x.et) > mid); if (pos < 0) pos = list.length - 1; }
    else { pos = -1; list.forEach((x, q) => { if (indexOfTime(x.et) < mid) pos = q; }); if (pos < 0) pos = 0; }
  }
  pos = Math.max(0, Math.min(list.length - 1, pos));
  focusTrade(list[pos].n - 1);
}

/** The panel under the chart: the test's numbers and its list of trades (click one to see it). */
let stratSig = '';
function paintStrat(force = false) {
  const el = host && $('#lab-ch-strat', host);
  if (!el) return;
  const s = st.strat;
  if (!s || !st.ds || !st.B) { el.hidden = true; el.innerHTML = ''; stratSig = ''; return; }
  const list = shownTrades();
  const now = nowT();
  const open = list.length && list[list.length - 1].xt > now ? list[list.length - 1] : null;
  const sig = `${s.R.meta.made}|${s.id}|${list.length}|${open ? open.n : 0}|${s.sel}|${st.sshow.trades}|${st.sshow.lines}|${st.sshow.equity}|${s.plotsLoading}|${s.plotsErr}|${s.plots ? s.plots.map((p) => +p.on).join('') : ''}|${Boolean(st.replay)}`;
  if (!force && sig === stratSig && !el.hidden) { paintStratLive(); return; }
  stratSig = sig;
  el.hidden = false;
  const R = s.R, sm = R.summary, ts = sm.trades || {};
  const closed = list.filter((x) => x.xt <= now);
  const pct = (v, dp = 1) => (fin(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%` : '–');
  const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  let chips;
  if (st.replay) {
    const wins = closed.filter((x) => x.pnl > 0).length;
    const rs = closed.filter((x) => x.r != null && fin(x.r));
    const sumR = rs.reduce((a, x) => a + x.r, 0), sumRet = closed.reduce((a, x) => a + x.ret, 0);
    chips = [['Trades so far', closed.length.toLocaleString('en-US'), ''], ['Won', closed.length ? `${((wins / closed.length) * 100).toFixed(0)}%` : '–', ''],
      ['Added up', rs.length ? `${sumR >= 0 ? '+' : ''}${sumR.toFixed(2)}R` : pct(sumRet), tone(rs.length ? sumR : sumRet)],
      ['Whole test', pct(sm.return), tone(sm.return)]];
  } else {
    const pfv = ts.profit_factor;
    chips = [['Return', pct(sm.return), tone(sm.return)], ['Trades', (ts.n || 0).toLocaleString('en-US'), ''], ['Won', `${((ts.win_rate || 0) * 100).toFixed(1)}%`, ''],
      ['Profit factor', fin(pfv) ? pfv.toFixed(2) : pfv === 'inf' ? '∞' : '–', fin(pfv) ? tone(pfv - 1) : ''],
      ['Worst drawdown', fin(sm.max_dd) ? `${(-sm.max_dd * 100).toFixed(1)}%` : '–', sm.max_dd > 0 ? 'neg' : ''],
      ['Average', fin(ts.r_avg) ? `${ts.r_avg >= 0 ? '+' : ''}${ts.r_avg.toFixed(2)}R` : '–', tone(ts.r_avg)]];
  }
  const plotsNote = s.plotsLoading ? '<span class="faint small"><span class="spin"></span> Getting the strategy’s lines…</span>'
    : s.plotsErr ? `<span class="faint small" title="${esc(s.plotsErr)}">The strategy’s lines couldn’t be drawn: ${esc(s.plotsErr.slice(0, 160))}</span>`
      : s.plots && s.plots.length ? `<span class="lab-ch-plots"><span class="faint small">Strategy’s lines:</span>${s.plots.map((p, i) => `<label class="lab-ch-plot" title="${p.kind === 'price' ? 'Drawn on the candles' : 'Drawn in a pane of its own'}"><input type="checkbox" data-splot="${i}" ${p.on ? 'checked' : ''}><i class="lab-ch-dot" style="background:${p.color}"></i>${esc(p.name)}</label>`).join('')}</span>`
        : '<span class="faint small">This strategy keeps no lines to draw.</span>';
  const rows = list.slice(-3000).map((x) => {
    const isOpen = x.xt > now;
    const live = isOpen ? openResult(x) : null;
    const res = isOpen ? `${live.ret >= 0 ? '+' : ''}${(live.ret * 100).toFixed(2)}%` : tradeResult(x);
    const good = isOpen ? live.ret >= 0 : x.pnl >= 0;
    return `<tr data-ch="strade" data-n="${x.n - 1}" class="${s.sel === x.n - 1 ? 'on' : ''}" tabindex="0">
      <td>${x.n}</td><td class="${x.side > 0 ? 'pos' : 'neg'}">${x.side > 0 ? 'Long' : 'Short'}</td>
      <td>${esc(when(x.et, true))}<br><span class="faint">${fmt(x.ep)}</span></td>
      <td>${isOpen ? '<span class="faint">open</span>' : `${esc(when(x.xt, true))}<br><span class="faint">${fmt(x.xp)}</span>`}</td>
      <td class="${good ? 'pos' : 'neg'}"${isOpen ? ' data-live' : ''}>${res}</td><td class="l">${esc(isOpen ? '' : x.why || '')}</td></tr>`;
  }).join('');
  el.innerHTML = `
    <div class="lab-ch-shead">
      <div class="lab-ch-sname"><b>${esc(R.meta.strategy_label)}</b><span class="faint small">${esc(R.meta.settings_text || '')}</span>${s.id ? '' : '<span class="lab-ch-tag" title="Not in the Results folder: it is gone when you reload. Open the report to save it.">not saved</span>'}</div>
      <div class="lab-ch-schips">${chips.map(([k, v, t]) => `<span class="lab-ch-chip"><span class="faint">${k}</span><b class="${t}">${v}</b></span>`).join('')}</div>
      <div class="lab-ch-sbtns">
        <label class="check small"><input type="checkbox" data-sshow="trades" ${st.sshow.trades ? 'checked' : ''}><span>Trades</span></label>
        <label class="check small"><input type="checkbox" data-sshow="lines" ${st.sshow.lines ? 'checked' : ''}><span>Lines</span></label>
        <label class="check small"><input type="checkbox" data-sshow="equity" ${st.sshow.equity ? 'checked' : ''}><span>Account value</span></label>
        <button class="btn btn-sm" data-ch="sprev" title="Previous trade">${ic(IC.prev)}<span class="sr-only">Previous trade</span></button>
        <button class="btn btn-sm" data-ch="snext" title="Next trade">${ic(IC.next)}<span class="sr-only">Next trade</span></button>
        <button class="btn btn-sm" data-ch="sedit" title="Change the settings and run it again">${icon('edit')}Settings</button>
        <button class="btn btn-sm" data-ch="sreport" title="The full report on the Dashboard">${icon('book')}Report</button>
        <button class="btn btn-sm" data-ch="sremove" title="Take the strategy off the chart">${ic(IC.close)}<span class="sr-only">Remove</span></button>
      </div>
    </div>
    ${st.sshow.lines ? `<div class="lab-ch-sline">${plotsNote}</div>` : ''}
    ${list.length ? `<div class="lab-ch-tscroll" id="lab-ch-tscroll"><table class="lab-table lab-ch-trades"><thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Exit</th><th>Result</th><th class="l">Exit reason</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="dim small">${st.replay ? 'No trades yet at this point of the replay.' : 'This test made no trades.'}</p>`}`;
  const box = $('#lab-ch-tscroll', el);
  if (box) {
    const on = $('tr.on', box);
    if (on) box.scrollTop = on.offsetTop - box.clientHeight / 2;
    else if (st.replay) box.scrollTop = box.scrollHeight;
  }
}
/** In a replay: the open trade's result follows the price. */
function paintStratLive() {
  const cell = host && $('#lab-ch-strat [data-live]', host);
  if (!cell || !st.strat) return;
  const list = shownTrades();
  const x = list[list.length - 1];
  if (!x) return;
  const { ret } = openResult(x);
  cell.textContent = `${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(2)}%`;
  cell.className = ret >= 0 ? 'pos' : 'neg';
}

/* ---------- the Strategy menu: run a backtest on this chart, or open a saved one ---------- */

function stratMenu() {
  const list = ctx.strategies() || [];
  const runs = st.id ? (ctx.runs() || []).filter((r) => r.brief && r.brief.dataset === st.id).slice(0, 40) : [];
  const saved = runs.length
    ? `<div class="lab-ch-runs">${runs.map((r) => { const b = r.brief || {}; return `<button class="lab-ch-run ${st.strat && st.strat.id === r.id ? 'on' : ''}" data-ch="sload" data-id="${r.id}"><span class="lab-ch-rname">${esc(b.strategy || r.title)}</span><span class="${b.return > 0 ? 'pos' : b.return < 0 ? 'neg' : ''}">${fin(b.return) ? `${b.return >= 0 ? '+' : ''}${(b.return * 100).toFixed(1)}%` : ''}</span><span class="faint small lab-ch-rset">${b.trades ?? 0} trades · ${esc((b.settings || '').slice(0, 80))}</span></button>`; }).join('')}</div>`
    : `<p class="faint small">${st.id ? 'No saved results for this file yet.' : 'Pick a data file first.'}</p>`;
  if (!list.length) return `<div class="lab-ch-shead2">Run a strategy on this chart</div><p class="dim small"><span class="spin"></span> The Python engine is starting…</p><div class="lab-ch-shead2">Saved results for this file</div>${saved}`;
  const f = st.sform;
  const cur = list.find((x) => x.key === f.strategy) || list[0];
  f.strategy = cur.key;
  const vals = f.params[cur.key] || {};
  const groups = new Map();
  for (const s of list) {
    const g = s.origin === 'mine' ? 'Your strategies' : { classic: 'Classic', intraday: 'Intraday', swing: 'Swing' }[s.group] || 'Built-in';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const field = (p) => {
    const v = vals[p.key] ?? p.default;
    if (p.kind === 'bool') return `<label class="check small lab-ch-sp lab-ch-spwide"><input type="checkbox" data-sp="${esc(p.key)}" ${v ? 'checked' : ''}><span>${esc(p.label)}</span></label>`;
    const lab = `<span class="label">${esc(p.label)}</span>`;
    if (p.kind === 'choice') return `<label class="lab-ch-sp">${lab}<select class="input" data-sp="${esc(p.key)}">${(p.choices || []).map(([cv, cl]) => `<option value="${esc(cv)}" ${String(cv) === String(v) ? 'selected' : ''}>${esc(cl)}</option>`).join('')}</select></label>`;
    return `<label class="lab-ch-sp" title="${esc(p.help || '')}">${lab}<input class="input" type="number" data-sp="${esc(p.key)}" data-kind="${p.kind}" value="${esc(v)}" ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''} step="${p.step ?? (p.kind === 'int' ? 1 : 'any')}"></label>`;
  };
  const c = ctx.costs();
  return `<div class="lab-ch-shead2">Run a strategy on this chart</div>
    <select class="input" data-ch="sname" aria-label="Strategy">${[...groups].map(([g, items]) => `<optgroup label="${esc(g)}">${items.map((s) => `<option value="${esc(s.key)}" ${s.key === cur.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('')}</select>
    <div class="lab-ch-sparams">${cur.params.map(field).join('')}</div>
    <p class="faint small">Lengths are in candles of the file (${esc(st.row ? st.row.interval || tfName(st.base) : '')}). The test uses the whole file, and the Dashboard’s costs and money: fee ${c.fee_pct}% + slippage ${c.slippage_pct}%, ${c.sizing === 'risk' ? `risk ${c.risk_pct}% a trade` : `${c.notional_pct}% of the account a trade`}, start ${c.capital} (<button class="link small" type="button" data-lab="tab" data-tab="dashboard">change them there</button>).</p>
    <label class="check small"><input type="checkbox" data-ch="ssave" ${f.save ? 'checked' : ''}><span>Save the result in the Results folder</span></label>
    <div class="lab-ch-srun"><button class="btn btn-sm btn-green" data-ch="srun" ${st.running || !st.ds ? 'disabled' : ''}>${st.running ? '<span class="spin"></span>Running…' : `${icon('play')}Run backtest`}</button><button class="btn btn-sm" data-ch="sdefaults" title="Back to the strategy's own settings">Defaults</button><span class="faint small" id="lab-ch-sprog"></span></div>
    <div class="lab-ch-shead2">Saved results for this file</div>${saved}`;
}

function readSparam(el) {
  const f = st.sform;
  const k = el.dataset.sp;
  const p = (f.params[f.strategy] = f.params[f.strategy] || {});
  if (el.type === 'checkbox') p[k] = el.checked;
  else if (el.tagName === 'SELECT') p[k] = el.value;
  else { const x = parseFloat(el.value); if (fin(x)) p[k] = el.dataset.kind === 'int' ? Math.round(x) : x; else delete p[k]; }
  save('sform', f);
}

async function runStrategy() {
  if (st.running || !st.ds) return;
  const f = st.sform;
  for (const el of $$('[data-sp]', host)) readSparam(el);
  st.running = true;
  paintBar();
  const say = (x, text) => { const el = $('#lab-ch-sprog', host); if (el) el.textContent = `${Math.round(x * 100)}% · ${text}`; };
  try {
    const { R, id } = await ctx.runBacktest({ dataset: st.id, strategy: f.strategy, params: { ...(f.params[f.strategy] || {}) }, save: f.save }, say);
    st.running = false;
    st.menu = null;
    setStrat(R, id);
    const n = (R.summary.trades || {}).n || 0;
    toast(`${R.meta.strategy_label}: ${plural(n, 'trade')}, ${(R.summary.return * 100).toFixed(1)}%${id ? ' · saved in Results' : ''}`);
  } catch (e) {
    st.running = false;
    paintBar();
    const el = $('#lab-ch-sprog', host);
    if (el) { el.textContent = e.message; el.classList.add('err'); }
    else toast(e.message, 'error');
  }
}

/* ---------- the legends ---------- */

function legend(j) {
  const el = host && $('#lab-ch-legend', host);
  if (!el || !st.B) return;
  const K = st.K;
  const last = st.shownTo;
  if (j == null || j > last || j < 0) j = last;
  const { bar, done } = barFor(j, K);
  const shown = st.ha ? (done ? { o: st.ha.O[j], h: st.ha.H[j], l: st.ha.L[j], c: st.ha.C[j] } : st.ha.tail(j, bar)) : bar;
  const prev = j > 0 ? st.B.C[j - 1] : bar.o;
  const ch = bar.c - prev, chp = prev ? (ch / prev) * 100 : 0;
  const tone = bar.c >= bar.o ? 'pos' : 'neg';
  const r = st.row;
  const vals = (g) => g.feeds.map((f) => `<b style="color:${f.color}">${f.fmt(done ? f.get(j, K, null, true) : f.get(j, K, bar, false))}</b>`).join(' ');
  const inds = st.groups.filter((g) => g.pane === 0).map((g) => `<span><span class="faint">${esc(g.key === 'splots' ? g.feeds.map((f) => f.name).join(' · ') : g.label)}</span> ${vals(g)}</span>`).join('');
  let trade = '';
  if (st.strat && st.sshow.trades) {
    const now = nowT();
    const here = st.strat.trades.filter((x) => x.et <= now && (indexOfTime(x.et) === j || (x.xt <= now && indexOfTime(x.xt) === j)));
    trade = here.slice(0, 3).map((x) => {
      const ins = indexOfTime(x.et) === j, outs = x.xt <= now && indexOfTime(x.xt) === j;
      return `<span class="lab-ch-ltrade">#${x.n} ${x.side > 0 ? 'Long' : 'Short'}${ins ? ` in ${fmt(x.ep)}` : ''}${outs ? ` out ${fmt(x.xp)} <b class="${x.pnl >= 0 ? 'pos' : 'neg'}">${tradeResult(x)}</b> ${esc(x.why || '')}` : ''}</span>`;
    }).join('');
  }
  el.innerHTML = `<div class="lab-ch-sym"><b>${esc(r.symbol)}</b> <span class="faint">· ${tfName(st.tf)} · ${esc(r.market === 'spot' ? 'Binance spot' : r.market === 'futures' ? 'Binance futures' : r.market)}</span>${st.replay ? ' <span class="lab-ch-rtag">REPLAY</span>' : ''}</div>
    <div class="lab-ch-ohlc ${tone}"><span><span class="faint">O</span>${fmt(shown.o)}</span><span><span class="faint">H</span>${fmt(shown.h)}</span><span><span class="faint">L</span>${fmt(shown.l)}</span><span><span class="faint">C</span>${fmt(shown.c)}</span>
      <span>${ch >= 0 ? '+' : ''}${fmt(ch)} (${chp >= 0 ? '+' : ''}${chp.toFixed(2)}%)</span>${st.ind.vol.on ? `<span><span class="faint">Vol</span>${shortNum(bar.v)}</span>` : ''}${done ? '' : ' <span class="faint">forming</span>'}</div>
    <div class="lab-ch-time faint">${esc(when(st.B.T[j]))}</div>
    ${inds ? `<div class="lab-ch-inds">${inds}</div>` : ''}${trade ? `<div class="lab-ch-inds">${trade}</div>` : ''}`;
  const pl = $('#lab-ch-plegs', host);
  if (pl) {
    for (const box of pl.children) {
      const p = Number(box.dataset.pane);
      box.innerHTML = st.groups.filter((g) => g.pane === p).map((g) => `<span class="faint">${esc(g.label)}</span> ${vals(g)}`).join(' &nbsp; ');
    }
  }
}
function paintPaneLegends() {
  const pl = host && $('#lab-ch-plegs', host);
  if (!pl) return;
  const panes = [...new Set(st.groups.filter((g) => g.pane > 0).map((g) => g.pane))];
  pl.innerHTML = panes.map((p) => `<div class="lab-ch-legend lab-ch-plegend" data-pane="${p}"></div>`).join('');
}
/** Where pane i sits in the chart box: {top, height} in pixels (null before the chart has laid it out). */
function paneBox(i) {
  const p = chart && chart.panes()[i];
  const pe = p && p.getHTMLElement();
  if (!pe) return null;
  const r = pe.getBoundingClientRect(), top0 = $('#lab-ch-main', host).getBoundingClientRect().top;
  return { top: r.top - top0, height: r.height };
}
/** Puts each pane's legend at the top of its pane (panes can be resized, so this runs again when they are). */
function placeLegends(tries = 0) {
  const pl = host && $('#lab-ch-plegs', host);
  if (!pl || !chart) return;
  let missing = false;
  for (const box of pl.children) {
    const b = paneBox(Number(box.dataset.pane));
    if (b) box.style.top = `${Math.round(b.top + 4)}px`;
    else missing = true;
  }
  if (missing && tries < 20) placeTimer = setTimeout(() => placeLegends(tries + 1), 100);   // new panes appear after the chart's next paint
}
let placeTimer = 0;
const placeLegendsSoon = () => { clearTimeout(placeTimer); placeTimer = setTimeout(placeLegends, 30); };
function when(ms, short = false) {
  const d = new Date(ms);
  if (short) return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', ...(st.base < DAY ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) });
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...(st.tf < DAY ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) });
}

function indexOfTime(ms) {
  const T = st.B.T;
  let a = 0, b = st.B.n - 1;
  if (ms <= T[0]) return 0;
  while (a < b) { const m = (a + b + 1) >> 1; if (T[m] <= ms) a = m; else b = m - 1; }
  return a;
}

/* ======================= what is drawn on top of the candles ======================= */

/** Logical position (candle index, may be fractional or past the end) <-> time in ms. */
function logicalToMs(x) {
  const n = st.B.n, T = st.B.T;
  if (x <= 0) return T[0] + x * st.tf;
  if (x >= n - 1) return T[n - 1] + (x - (n - 1)) * st.tf;
  const i = Math.floor(x);
  return T[i] + (x - i) * (T[i + 1] - T[i]);
}
function msToLogical(ms) {
  const n = st.B.n, T = st.B.T;
  if (ms <= T[0]) return (ms - T[0]) / st.tf;
  if (ms >= T[n - 1]) return n - 1 + (ms - T[n - 1]) / st.tf;
  const i = indexOfTime(ms);
  return i + (ms - T[i]) / Math.max(1, T[i + 1] - T[i]);
}

/** Band fills (under the candles), and the trades and drawings (over them). */
class Layer {
  constructor() {
    this.views = [
      { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context: g }) => paintFills(g)) }) },
      { zOrder: () => 'top', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context: g, mediaSize }) => { paintTrades(g); paintDrawings(g, mediaSize); }) }) },
    ];
  }
  attached({ requestUpdate }) { this.update = requestUpdate; }
  detached() { this.update = null; }
  updateAllViews() {}
  paneViews() { return this.views; }
  redraw() { if (this.update) this.update(); }
}

function paintFills(g) {
  if (!st.fills.length || !chart) return;
  const ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
  if (!r) return;
  const a = Math.max(0, Math.floor(r.from) - 1), b = Math.min(st.shownTo, Math.ceil(r.to) + 1);
  for (const fl of st.fills) {
    let run = [], col = null;
    const flush = () => {
      if (run.length > 1) {
        g.fillStyle = col;
        g.beginPath();
        run.forEach(([x, ya], q) => (q ? g.lineTo(x, ya) : g.moveTo(x, ya)));
        for (let q = run.length - 1; q >= 0; q--) g.lineTo(run[q][0], run[q][2]);
        g.closePath();
        g.fill();
      }
      run = [];
    };
    for (let j = a; j <= b; j++) {
      const va = valueAt(fl.a, j), vb = valueAt(fl.b, j);
      const x = ts.logicalToCoordinate(j), ya = fin(va) ? main.priceToCoordinate(va) : null, yb = fin(vb) ? main.priceToCoordinate(vb) : null;
      if (x == null || ya == null || yb == null) { flush(); col = null; continue; }
      const c = typeof fl.color === 'function' ? fl.color(va, vb) : fl.color;
      if (col !== null && c !== col) { const lastPt = run[run.length - 1]; flush(); if (lastPt) run.push(lastPt); }
      col = c;
      run.push([x, ya, yb]);
    }
    flush();
  }
}

function paintTrades(g) {
  const s = st.strat;
  if (!s || !st.sshow.trades || !chart) return;
  const ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
  if (!r) return;
  const now = nowT();
  g.save();
  for (const x of s.trades) {
    if (x.et > now) break;
    const eb = indexOfTime(x.et);
    const isOpen = x.xt > now;
    const xb = isOpen ? st.shownTo : indexOfTime(x.xt);
    if (xb < r.from - 2 || eb > r.to + 2) continue;
    const x1 = ts.logicalToCoordinate(eb), x2 = ts.logicalToCoordinate(xb);
    const live = isOpen ? openResult(x) : null;
    const y1 = main.priceToCoordinate(x.ep), y2 = main.priceToCoordinate(isOpen ? live.p : x.xp);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
    const sel = s.sel === x.n - 1;
    if (sel || isOpen) {
      const w = Math.max(8, x2 - x1);
      for (const [lvl, col] of [[x.stop, 'rgba(240,75,75,0.14)'], [x.tp, 'rgba(34,197,94,0.14)']]) {
        const y = fin(lvl) ? main.priceToCoordinate(lvl) : null;
        if (y == null) continue;
        g.fillStyle = col;
        g.fillRect(x1, Math.min(y1, y), w, Math.abs(y - y1));
      }
    }
    g.strokeStyle = isOpen ? 'rgba(229,231,235,0.85)' : x.pnl >= 0 ? 'rgba(34,197,94,0.95)' : 'rgba(240,75,75,0.95)';
    g.lineWidth = sel ? 2.2 : 1.2;
    g.setLineDash([5, 4]);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.setLineDash([]);
    if (sel) {
      const text = `#${x.n} ${x.side > 0 ? 'Long' : 'Short'} ${isOpen ? `${live.ret >= 0 ? '+' : ''}${(live.ret * 100).toFixed(2)}% open` : tradeResult(x)}`;
      g.font = '12px ' + getComputedStyle(document.body).fontFamily;
      const w = g.measureText(text).width + 12;
      const bx = (x1 + x2) / 2 - w / 2, by = Math.min(y1, y2) - 26;
      g.fillStyle = 'rgba(17,17,17,0.85)';
      g.fillRect(bx, by, w, 20);
      g.fillStyle = '#fff';
      g.fillText(text, bx + 6, by + 14);
    }
  }
  g.restore();
}

function xy(pt) {
  const x = chart.timeScale().logicalToCoordinate(msToLogical(pt.t));
  const y = main.priceToCoordinate(pt.p);
  return x == null || y == null ? null : [x, y];
}
function paintDrawings(g, size) {
  const items = st.drawings.filter((d) => d.type !== 'hline').concat(st.draft && st.draft.b ? [st.draft] : []);
  g.save();
  g.font = '12px ' + getComputedStyle(document.body).fontFamily;
  for (const d of items) {
    const A = xy(d.a), Bp = xy(d.b);
    if (!A || !Bp) continue;
    const [x1, y1] = A, [x2, y2] = Bp;
    const color = d.color || '#4ea1ff';
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.6;
    if (d.type === 'trend') {
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      for (const [x, y] of [A, Bp]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    } else if (d.type === 'rect') {
      g.globalAlpha = 0.14; g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      g.globalAlpha = 1; g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (d.type === 'fib') {
      const lv = [[0, '#9ca3af'], [0.236, '#f04b4b'], [0.382, '#f59e0b'], [0.5, '#22c55e'], [0.618, '#14b8a6'], [0.786, '#38bdf8'], [1, '#9ca3af']];
      const left = Math.min(x1, x2), right = Math.max(x1, x2) + 60;
      for (const [f, c] of lv) {
        const p = d.b.p + (d.a.p - d.b.p) * f;
        const y = main.priceToCoordinate(p);
        if (y == null) continue;
        g.strokeStyle = c; g.fillStyle = c;
        g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
        g.fillText(`${f} (${fmt(p)})`, left + 4, y - 4);
      }
      g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
    } else if (d.type === 'measure') {
      const upward = d.b.p >= d.a.p;
      const c = upward ? 'rgba(34,197,94,' : 'rgba(240,75,75,';
      g.fillStyle = c + '0.16)';
      g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      g.strokeStyle = c + '0.9)';
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      const dp = d.b.p - d.a.p, pc = (dp / d.a.p) * 100;
      const bars = Math.round(msToLogical(d.b.t) - msToLogical(d.a.t));
      const text = [`${dp >= 0 ? '+' : ''}${fmt(dp)} (${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%)`, `${bars} candles · ${span(Math.abs(d.b.t - d.a.t))}`];
      const w = Math.max(...text.map((s) => g.measureText(s).width)) + 16;
      const bx = Math.min(Math.max((x1 + x2) / 2 - w / 2, 4), size.width - w - 4);
      const by = upward ? Math.min(y1, y2) - 46 : Math.max(y1, y2) + 6;
      g.fillStyle = upward ? '#166534' : '#7f1d1d';
      g.fillRect(bx, Math.max(4, by), w, 40);
      g.fillStyle = '#fff';
      text.forEach((s, q) => g.fillText(s, bx + 8, Math.max(4, by) + 16 + q * 16));
    }
  }
  g.restore();
}
function span(ms) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d}d`, h && `${h}h`, mm && !d && `${mm}m`].filter(Boolean).join(' ') || '0m';
}
function paintHlines() {
  for (const pl of hlines) main.removePriceLine(pl);
  hlines = st.drawings.filter((d) => d.type === 'hline').map((d) => main.createPriceLine({ price: d.a.p, color: '#4ea1ff', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' }));
}
function saveDrawings() {
  save(`draw.${drawKey()}`, st.drawings);
  paintHlines();
  if (layer) layer.redraw();
  paintBar();
}

/** The price under the pointer, pulled to a candle's open/high/low/close when it is within 10 pixels (a magnet). */
function pointAt(param) {
  if (!param.point || param.logical == null) return null;
  let p = main.coordinateToPrice(param.point.y);
  if (p == null) return null;
  const j = Math.round(param.logical);
  if (j >= 0 && j <= st.shownTo) {
    const d = main.dataByIndex(j);
    if (d && d.open != null) {
      let best = null;
      for (const v of [d.open, d.high, d.low, d.close]) {
        const y = main.priceToCoordinate(v);
        if (y != null && Math.abs(y - param.point.y) < 10 && (!best || Math.abs(y - param.point.y) < best[0])) best = [Math.abs(y - param.point.y), v];
      }
      if (best) p = best[1];
    }
  }
  const t = j >= 0 && j < st.B.n ? st.B.T[j] : logicalToMs(param.logical);
  return { t, p };
}

/* Clicks on the chart are read here, not with the library's click event: that one swallows a second
   click that comes quickly after the first (it waits to see if it is a double-click). */
function watchClicks(el) {
  let down = null;
  // Capture phase: the library stops these events inside the chart.
  el.addEventListener('pointerdown', (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null; }, true);
  el.addEventListener('pointerup', (e) => {
    if (!down || !chart) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    placeLegendsSoon();                                      // the line between two panes may have been dragged
    if (moved > 5) return;                                   // a drag moves the chart
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ts = chart.timeScale();
    if (x > r.width - chart.priceScale('right').width() || y > r.height - ts.height()) return;   // on a scale
    const p0 = paneBox(0);
    onChartClick({ point: { x, y }, logical: ts.coordinateToLogical(x), inMain: !p0 || y <= p0.top + p0.height });
  }, true);
}

function onChartClick(param) {
  if (st.picking) {
    if (param.logical == null) return;
    const j = Math.max(1, Math.min(st.B.n - 2, Math.round(param.logical)));
    startReplay(st.B.first[j + 1]);                 // the clicked candle is the last one shown
    return;
  }
  if (!param.inMain) return;
  if (!st.tool) {
    // A click on a trade's entry or exit candle selects that trade.
    const s = st.strat;
    if (!s || !st.sshow.trades || param.logical == null) return;
    const j = Math.round(param.logical), now = nowT();
    const hit = s.trades.find((x) => x.et <= now && (indexOfTime(x.et) === j || (x.xt <= now && indexOfTime(x.xt) === j)));
    if (hit) { s.sel = hit.n - 1; paintMarkers(); if (layer) layer.redraw(); paintStrat(true); }
    return;
  }
  const pt = pointAt(param);
  if (!pt) return;
  if (st.tool === 'hline') {
    st.drawings.push({ type: 'hline', a: pt });
    saveDrawings();
    return;
  }
  if (!st.draft) { st.draft = { type: st.tool, a: pt, b: null }; hint('Click the second point. Esc cancels.'); return; }
  st.draft.b = pt;
  if (st.tool === 'measure') st.drawings = st.drawings.filter((d) => d.type !== 'measure');
  st.drawings.push(st.draft);
  st.draft = null;
  hint(toolHint());
  saveDrawings();
}

function onMove(param) {
  if (st.draft && param.point && (param.paneIndex == null || param.paneIndex === 0)) {
    const pt = pointAt(param);
    if (pt) { st.draft.b = pt; layer.redraw(); }
  }
  const j = param.time != null ? indexOfTime(unsec(param.time)) : param.logical != null && param.point ? Math.round(param.logical) : null;
  legend(param.point ? j : null);
}

const toolHint = () => (st.tool ? `${TOOLS.find(([t]) => t === st.tool)[1]}: ${st.tool === 'hline' ? 'click a price.' : 'click the first point.'} Esc stops.` : '');
function hint(text) {
  const el = $('#lab-ch-hint', host);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}
function setTool(t) {
  st.tool = st.tool === t ? null : t;
  st.draft = null;
  if (st.tool) st.picking = false;
  hint(toolHint());
  if (layer) layer.redraw();
  paintBar();
}

/* ======================= replay ======================= */

function startReplay(k) {
  st.picking = false;
  const old = st.replay;
  st.replay = { k: Math.max(2, Math.min(k, st.ds.n)), playing: false, timer: null, speed: old ? old.speed : load('speed', 2), by: old ? old.by : load('by', 'bar'), pos: null, trades: old ? old.trades : [] };
  if (st.strat) st.strat.sel = -1;
  hint('');
  setAll(st.replay.k);
  paintMarkers();
  focusReplay();
  legend(null);
  paintBar();
  paintReplay();
  paintStrat(true);
}
function focusReplay() {
  const j = lastBar(st.replay.k);
  chart.timeScale().setVisibleLogicalRange({ from: j - 140, to: j + 40 });
}
function stopReplay(quiet) {
  const r = st.replay;
  st.picking = false;
  if (!r) { hint(st.tool ? toolHint() : ''); return; }
  clearInterval(r.timer);
  st.replay = null;
  if (quiet || !main) return;
  setAll(st.ds.n);
  paintMarkers();
  hint(st.tool ? toolHint() : '');
  legend(null);
  paintBar();
  paintReplay();
  paintStrat(true);
  chart.timeScale().scrollToRealTime();
}
/** One step: the next chart candle, or (with "file candles") the next candle of the file. */
function step(dir = 1) {
  const r = st.replay;
  if (!r) return;
  const k = r.k;
  if (dir > 0) {
    if (k >= st.ds.n) { pause(); toast('The replay reached the end of the file.'); return; }
    const j = lastBar(k);
    const nk = r.by === 'file' || st.tf === st.base ? k + 1 : (k < st.B.first[j + 1] ? st.B.first[j + 1] : st.B.first[Math.min(j + 2, st.B.n)]);
    r.k = Math.min(nk, st.ds.n);
    advance(k, r.k);
  } else {
    // Back a whole chart candle drops the last one shown (finished or forming); "file candles" drops one file candle.
    const nk = r.by === 'file' || st.tf === st.base ? k - 1 : st.B.first[lastBar(k)];
    if (nk < 2) return;
    r.k = nk;
    setAll(r.k);
  }
  paintMarkers();
  if (layer) layer.redraw();
  legend(null);
  paintReplayInfo();
  paintStrat();
}
function play() {
  const r = st.replay;
  if (!r || r.playing) return;
  if (r.k >= st.ds.n) { toast('The replay is at the end of the file. Pick an earlier start.'); return; }
  r.playing = true;
  r.timer = setInterval(() => {
    if (!host || host.closest('[hidden]') || document.hidden) { pause(); return; }
    step(1);
  }, 1000 / r.speed);
  paintReplay();
}
function pause() {
  const r = st.replay;
  if (!r) return;
  r.playing = false;
  clearInterval(r.timer);
  paintReplay();
}
const nowPrice = () => st.ds.cols.c[st.replay.k - 1];
const nowMs = () => st.ds.cols.t[st.replay.k - 1];
/** Practice trades in a replay: buy or sell at the last price shown, then close. Prices only, no fees. */
function trade(side) {
  const r = st.replay;
  if (!r) return;
  if (r.pos && r.pos.side !== side) closePos();
  else if (r.pos) return;
  r.pos = { side, entry: nowPrice(), t: nowMs() };
  paintMarkers();
  paintReplay();
}
function closePos() {
  const r = st.replay;
  if (!r || !r.pos) return;
  const p = nowPrice();
  r.trades.push({ ...r.pos, exit: p, xt: nowMs(), ret: ((p - r.pos.entry) / r.pos.entry) * (r.pos.side === 'long' ? 1 : -1) * 100 });
  r.pos = null;
  paintMarkers();
  paintReplay();
}

function paintReplay() {
  const el = $('#lab-ch-replay', host);
  if (!el) return;
  const r = st.replay;
  el.hidden = !r && !st.picking;
  if (st.picking && !r) {
    el.innerHTML = `<span class="dim small">Click a candle on the chart where the replay should start, or pick a date:</span>
      <input class="input lab-ch-date" type="date" data-ch="rdate" aria-label="Replay start date">
      <button class="btn btn-sm" data-ch="rexit">${ic(IC.close)}Cancel</button>`;
    return;
  }
  if (!r) { el.innerHTML = ''; return; }
  const sub = st.tf > st.base;
  el.innerHTML = `
    <span class="lab-ch-rgroup">
      <button class="btn btn-sm" data-ch="rback" title="Step back (←)" aria-label="Step back">${ic(IC.prev)}</button>
      <button class="btn btn-sm btn-green" data-ch="rplay" title="${r.playing ? 'Pause' : 'Play'} (Space)" aria-label="${r.playing ? 'Pause' : 'Play'}">${r.playing ? ic(IC.pause) : icon('play')}</button>
      <button class="btn btn-sm" data-ch="rstep" title="Step forward (→)" aria-label="Step forward">${ic(IC.next)}</button>
      <select class="input lab-ch-speed" data-ch="speed" aria-label="Speed" title="Candles per second">${SPEEDS.map((s) => `<option value="${s}" ${s === r.speed ? 'selected' : ''}>${s}×/s</option>`).join('')}</select>
      ${sub ? `<select class="input lab-ch-by" data-ch="by" aria-label="Step size" title="Step a whole chart candle, or build each candle from the file's own ${tfName(st.base)} candles"><option value="bar" ${r.by === 'bar' ? 'selected' : ''}>Step: ${tfName(st.tf)} candle</option><option value="file" ${r.by === 'file' ? 'selected' : ''}>Step: ${tfName(st.base)} (build candles)</option></select>` : ''}
      <button class="btn btn-sm" data-ch="rpick" title="Pick a new start">${ic(IC.replay)}New start</button>
    </span>
    <span class="lab-ch-rgroup lab-ch-trade">
      <button class="btn btn-sm lab-ch-buy" data-ch="buy" ${r.pos && r.pos.side === 'long' ? 'disabled' : ''}>Buy</button>
      <button class="btn btn-sm lab-ch-sell" data-ch="sell" ${r.pos && r.pos.side === 'short' ? 'disabled' : ''}>Sell</button>
      <button class="btn btn-sm" data-ch="flat" ${r.pos ? '' : 'disabled'}>Close</button>
      <span class="small" id="lab-ch-rinfo"></span>
    </span>
    <button class="btn btn-sm" data-ch="rexit" title="Leave the replay and show every candle">${ic(IC.close)}Exit replay</button>`;
  paintReplayInfo();
}
function paintReplayInfo() {
  const el = $('#lab-ch-rinfo', host);
  const r = st.replay;
  if (!el || !r) return;
  const p = nowPrice();
  const open = r.pos ? ((p - r.pos.entry) / r.pos.entry) * (r.pos.side === 'long' ? 1 : -1) * 100 : null;
  const total = r.trades.reduce((s, x) => s + x.ret, 0);
  const wins = r.trades.filter((x) => x.ret > 0).length;
  const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  el.innerHTML = `${r.pos ? `<b class="${open >= 0 ? 'pos' : 'neg'}">${r.pos.side === 'long' ? 'Long' : 'Short'} ${sign(open)}</b> · ` : ''}${r.trades.length ? `${plural(r.trades.length, 'trade')}, ${wins} won, <b class="${total >= 0 ? 'pos' : 'neg'}">${sign(total)}</b> <span class="faint">(no fees)</span> · ` : ''}<span class="faint">${esc(when(nowMs()))}</span>`;
}

/* ======================= events ======================= */

function onClick(ev) {
  const el = ev.target.closest('[data-ch]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.disabled) return;
  const a = el.dataset.ch;
  if (a === 'type') { st.type = el.dataset.type; saveView(); build(); return; }
  if (a === 'srun') { runStrategy(); return; }
  if (a === 'sdefaults') { delete st.sform.params[st.sform.strategy]; save('sform', st.sform); paintBar(); return; }
  if (a === 'sload') { el.disabled = true; ctx.fetchResult(el.dataset.id).then((R) => { st.menu = null; showResult(R, el.dataset.id); }).catch((e) => { el.disabled = false; toast(e.message, 'error'); }); return; }
  if (!st.B) return;
  switch (a) {
    case 'tool': setTool(el.dataset.tool); break;
    case 'undo': st.drawings.pop(); saveDrawings(); break;
    case 'clear': if (confirm(`Delete all ${plural(st.drawings.length, 'drawing')} on ${st.row.symbol}?`)) { st.drawings = []; saveDrawings(); } break;
    case 'log': st.log = !st.log; saveView(); chart.priceScale('right').applyOptions({ mode: st.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }); paintBar(); break;
    case 'fit': chart.timeScale().fitContent(); break;
    case 'png': savePng(); break;
    case 'full': { const c = $('.lab-ch', host); if (document.fullscreenElement) document.exitFullscreen(); else if (c.requestFullscreen) c.requestFullscreen().catch(() => toast('Full screen isn’t allowed here.')); break; }
    case 'replay': if (st.replay) stopReplay(); else { st.picking = !st.picking; st.tool = null; st.draft = null; hint(st.picking ? 'Click the candle where the replay should start.' : ''); paintBar(); paintReplay(); } break;
    case 'rpick': stopReplay(); st.picking = true; hint('Click the candle where the replay should start.'); paintBar(); paintReplay(); break;
    case 'rexit': stopReplay(); break;
    case 'rplay': if (st.replay.playing) pause(); else play(); break;
    case 'rstep': pause(); step(1); break;
    case 'rback': pause(); step(-1); break;
    case 'buy': trade('long'); break;
    case 'sell': trade('short'); break;
    case 'flat': closePos(); break;
    case 'strade': { const i = Number(el.dataset.n); if (st.strat && st.strat.sel === i) { st.strat.sel = -1; paintMarkers(); if (layer) layer.redraw(); paintStrat(true); } else focusTrade(i); break; }
    case 'sprev': stepTrade(-1); break;
    case 'snext': stepTrade(1); break;
    case 'sreport': if (st.strat) ctx.openReport(st.strat.R, st.strat.id); break;
    case 'sremove': removeStrat(); break;
    case 'sedit': st.menu = 'strat'; paintBar(); $('#lab-ch-smenu', host).scrollIntoView({ block: 'nearest' }); break;
    default: break;
  }
}

function onChange(ev) {
  const t = ev.target;
  if (t.dataset.ch === 'file') { if (t.value) openFile(t.value); else closeFile(); return; }
  if (t.dataset.ch === 'sname') { st.sform.strategy = t.value; save('sform', st.sform); paintBar(); return; }
  if (t.dataset.ch === 'ssave') { st.sform.save = t.checked; save('sform', st.sform); return; }
  if (t.dataset.sp) { readSparam(t); return; }
  if (t.dataset.sshow) { st.sshow[t.dataset.sshow] = t.checked; save('sshow', st.sshow); build(); return; }
  if (t.dataset.splot && st.strat && st.strat.plots) { st.strat.plots[Number(t.dataset.splot)].on = t.checked; build(); return; }
  if (t.dataset.ch === 'tf') { st.tf = Number(t.value); saveView(); build(); return; }
  if (t.dataset.ch === 'goto' && t.value && st.B) {
    const j = indexOfTime(new Date(`${t.value}T00:00:00`).getTime());
    chart.timeScale().setVisibleLogicalRange({ from: j - 80, to: j + 80 });
    return;
  }
  if (t.dataset.ch === 'rdate' && t.value) {
    const ms = new Date(`${t.value}T00:00:00`).getTime();
    const T = st.ds.cols.t;
    let k = 0;
    while (k < st.ds.n && T[k] < ms) k++;
    if (k >= st.ds.n - 1) { toast('That date is after the last candle in the file.'); return; }
    startReplay(st.B.first[Math.max(1, bucketOf(k))]);   // the candles before that date are shown
    return;
  }
  if (t.dataset.ch === 'speed') { st.replay.speed = Number(t.value); save('speed', st.replay.speed); if (st.replay.playing) { pause(); play(); } return; }
  if (t.dataset.ch === 'by') { st.replay.by = t.value; save('by', t.value); return; }
  if (t.dataset.ind) { st.ind[t.dataset.ind].on = t.checked; saveView(); build(); return; }
  if (t.dataset.indP) {
    const k = t.dataset.indP, pk = t.dataset.p;
    const spec = IND[k].params.find(([x]) => x === pk);
    const v = Number(t.value);
    if (!fin(v) || v < spec[3] || v > spec[4] || (spec[5] >= 1 && !Number.isInteger(v))) { t.value = st.ind[k][pk]; toast(`${spec[1]}: ${spec[3]} to ${spec[4]}.`); return; }
    st.ind[k][pk] = v;
    st.ind[k].on = true;
    saveView();
    build();
  }
}
function onInput(ev) {
  if (ev.target.dataset.sp && ev.target.type === 'number') readSparam(ev.target);
}
function onToggle(ev) {
  const d = ev.target;
  if (!d.matches || !d.matches('details.lab-ch-menu')) return;
  if (d.open) {
    st.menu = d.dataset.menu;
    fitPop(d);
    for (const o of $$('details.lab-ch-menu[open]', host)) if (o !== d) o.open = false;
  } else if (st.menu === d.dataset.menu) st.menu = null;
}
/** A click anywhere outside an open menu closes it (pointerdown, captured: the chart stops clicks). */
function closeMenusOutside(ev) {
  if (!host) return;
  for (const d of $$('details.lab-ch-menu[open]', host)) {
    if (!d.contains(ev.target)) { d.open = false; if (st.menu === d.dataset.menu) st.menu = null; }
  }
}

function onKey(ev) {
  if (!host || host.closest('[hidden]')) return;
  if (ev.key === 'Escape') {
    const open = $$('details.lab-ch-menu[open]', host);
    if (open.length) { for (const d of open) d.open = false; st.menu = null; return; }
  }
  if (!st.B) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (ev.key === 'Escape') {
    if (st.draft || st.tool) { st.draft = null; st.tool = null; hint(''); if (layer) layer.redraw(); paintBar(); }
    else if (st.picking) { st.picking = false; hint(''); paintBar(); paintReplay(); }
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && st.drawings.length) { ev.preventDefault(); st.drawings.pop(); saveDrawings(); return; }
  if (!st.replay) return;
  if (ev.key === ' ') { ev.preventDefault(); if (st.replay.playing) pause(); else play(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); pause(); step(1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); pause(); step(-1); }
}

/** The chart (every pane) as a PNG picture. */
function savePng() {
  const c = chart.takeScreenshot();
  c.toBlob((blob) => { if (blob) download(`${st.row.symbol}-${tfName(st.tf)}-${ymd(Date.now())}.png`, blob); }, 'image/png');
}
