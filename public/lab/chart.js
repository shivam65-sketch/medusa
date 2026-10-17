// MEDUSA Lab: the Chart tab. A TradingView-style candle chart of any file in the Downloads or Uploads
// folder: timeframes, indicators (on the candles and in their own panes), drawing tools, a candle-by-candle
// replay of a portion picked on the chart with practice trades, and backtests drawn on the candles (trades,
// the strategy's own lines, the account value), which can be run from here too. Up to four charts can be
// shown side by side: they share one timeframe and one replay, and their crosshair and scrolling can be
// linked. Loaded the first time the tab is opened (main.js).
// The chart itself is TradingView's free Lightweight Charts library (Apache 2.0, version 5), kept in
// vendor/ because the page may only load its own scripts.
//
// Times: the library draws times as UTC, so every time is shifted by this computer's time zone
// (SHIFT) before it goes to the chart. The chart then reads in local time, like the rest of MEDUSA.
// Candles are grouped into bigger timeframes on UTC boundaries, the way Binance does.
//
// Indicators are written as running calculations (one candle at a time), so the same code gives the
// value of every finished candle and of the candle still forming in a replay.
//
// A replay is a moment in time (the "cut"): every chart shows the candles that had closed by then, so
// charts of different coins (or of files with different candle sizes) stay in step.

import { createChart, CandlestickSeries, BarSeries, LineSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, PriceScaleMode, LineStyle } from './vendor/lightweight-charts.mjs';
import { $, $$, esc, ymd, plural, INTERVAL_MS, DAY, toast, download, icon, money } from './util.js';
import * as data from './data.js';

let host = null;
let ctx = null;
const SHIFT = -new Date().getTimezoneOffset() * 60;           // seconds added to every time
const UP = '#22c55e', DOWN = '#f04b4b';
const UP_VOL = 'rgba(34,197,94,0.35)', DOWN_VOL = 'rgba(240,75,75,0.35)';
const TF_NAMES = Object.keys(INTERVAL_MS);
const SPEEDS = [0.5, 1, 2, 3, 5, 10, 20, 50];
const PANE_PX = 130;                                           // height added to the chart for each lower pane
const MAXN = 4;                                                // charts in the biggest layout
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
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  me: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20.5a7 7 0 0 1 14 0"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const LAYOUT_IC = {
  1: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  2: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M12 5v14"/>',
  3: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M9.2 5v14M14.8 5v14"/>',
  4: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M12 5v14M4 12h16"/>',
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

/** One chart of the layout. The functions below work on `st`, the chart being drawn or clicked (on()
    switches it); the toolbar works on the active chart (the one with the green border). */
function newPane(i) {
  return {
    i, el: null, id: null, row: null, ds: null, base: 0, prec: 2, type: 'candles', ind: defaultInd(), log: false,
    loading: false, error: null,
    B: null,             // the chart's candles: {n, T, O, H, L, C, V, first (index of each bar's first file candle)}
    ha: null,
    runners: new Map(),  // indicator results, kept while the candles stay the same
    feeds: [], groups: [], fills: [],
    drawings: [],        // shared with any other chart of the same coin
    undoAll: null,       // what "Delete all" removed, for Ctrl+Z
    shownTo: 0, K: 0,    // the last chart candle shown, and the file candles shown
    strat: null,         // the backtest drawn on the chart (see setStrat)
    mine: null,          // your journal trades on this chart's coin (see mineOf)
    focusMine: null,     // a journal trade to centre once the file is open
    pending: null,       // a result to draw once its data file is open
    pos: null, ptrades: [],   // practice trades in a replay
    chart: null, main: null, vol: null, layer: null, markers: null, hlines: [], posLine: null,
    userAt: 0,           // when the pointer or the wheel last moved this chart (only that scrolling is passed on)
    placeTimer: 0,
  };
}
const panes = Array.from({ length: MAXN }, (_, i) => newPane(i));
let st = panes[0];
const G = {
  n: 1, active: 0, sync: true,   // charts in the layout, the active one, crosshair and scrolling linked
  tf: 0, wantTf: 0,              // the timeframe of every chart
  tool: null, draft: null,       // the drawing tool; draft: {p, type, a, b}
  replay: null,                  // {cut, start, end (ms or null), playing, timer, speed, by: 'bar'|'file'}
  picking: null,                 // choosing the replay portion: {a, b (cuts), h (under the pointer), fromStr, toStr}
  sform: null, sshow: null,      // the Strategy menu's choices, what of a backtest is drawn
  mine: false, wantMine: null,   // your journal trades shown; a journal trade waiting for the file list
  menu: null,                    // the open toolbar menu ("ind" or "strat")
  running: false,
  pre: null,                     // a file or result asked for before the tab was first drawn
};
let restored = false, listening = false, syncing = false;
const A = () => panes[G.active];
const live = () => panes.slice(0, G.n);
const loaded = () => live().filter((p) => p.B);
/** Runs fn with st set to chart p. */
function on(p, fn) { const o = st; st = p; try { return fn(); } finally { st = o; } }
const each = (fn, list = loaded()) => { for (const p of list) on(p, fn); };

const load = (k, d) => ctx.store.get('chart.' + k, d);
const save = (k, v) => ctx.store.set('chart.' + k, v);

/* ======================= the page ======================= */

function restore() {
  restored = true;
  const lay = load('layout', null);
  const saved = load('panes', null) || [load('view', {})];   // 'view': the one-chart version's settings
  G.n = lay ? Math.max(1, Math.min(MAXN, lay.n | 0)) : 1;
  G.sync = lay ? lay.sync !== false : true;
  G.active = lay ? Math.min(lay.active | 0, G.n - 1) : 0;
  G.wantTf = G.wantTf || load('tf', 0) || (saved[0] && saved[0].tf) || 0;
  panes.forEach((p, i) => {
    const s = saved[i] || {};
    p.type = s.type || 'candles';
    p.log = Boolean(s.log);
    p.ind = mergeInd(s.ind);
    p.id = s.id || null;
  });
  if (G.pre) { A().id = G.pre.id; A().pending = G.pre.pending || null; G.pre = null; }
  G.sform = Object.assign({ strategy: 'turtle', params: {}, save: false }, load('sform', {}));
  G.sshow = Object.assign({ trades: true, lines: true, equity: false }, load('sshow', {}));
  G.mine = Boolean(load('mine', false));
}

export function paintChart(el, context) {
  ctx = context;
  if (host !== el || !el.dataset.ready) {
    host = el;
    el.dataset.ready = '1';
    if (!restored) restore();
    el.innerHTML = `<div class="card lab-ch">
      <div class="lab-ch-bar" id="lab-ch-bar"></div>
      <div class="lab-ch-replay" id="lab-ch-replay" hidden></div>
      <div class="lab-ch-stage" id="lab-ch-stage">${panes.map((p) => `<div class="lab-ch-main empty" data-pi="${p.i}"><div class="lab-ch-legend"></div><div class="lab-ch-plegs"></div><div class="lab-ch-hint" hidden></div><div class="lab-ch-pempty" hidden></div></div>`).join('')}</div>
      <div class="lab-ch-strat" id="lab-ch-strat" hidden></div>
      <div class="lab-ch-strat lab-ch-mine" id="lab-ch-mine" hidden></div>
      <p class="faint small lab-ch-foot">Scroll to zoom, drag to move, drag a price scale to stretch it (double-click it to reset), drag the line between panes to resize them. The buttons on the left show 1 to 4 charts: they share the timeframe and the replay, and <b>Sync</b> links their crosshair and scrolling; the toolbar works on the chart with the green border (click a chart to pick it). Times are in your time zone. Keys: <kbd>Esc</kbd> stops a drawing tool or closes a menu, <kbd>Delete</kbd> removes every drawing and indicator on the chart, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes; in a replay <kbd>Space</kbd> plays or pauses and <kbd>→</kbd> / <kbd>←</kbd> step. Chart by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts.</p>
    </div>`;
    for (const p of panes) {
      if (p.chart) on(p, destroyChart);                        // a chart left in an older copy of the page
      p.B = null;
      p.el = $(`.lab-ch-main[data-pi="${p.i}"]`, el);
      watchClicks(p);
      new ResizeObserver(() => placeLegendsSoon(p)).observe(p.el);
    }
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('toggle', onToggle, true);
    if (!listening) {
      listening = true;
      document.addEventListener('pointerdown', closeMenusOutside, true);
      document.addEventListener('keydown', onKey);
      for (const evName of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(evName, () => { if (!fsElement()) setFull(false); });
    }
    paintLayout();
    each(() => { if (st.ds) build(); }, live());
  }
  paintLayout();
  paintBar();
  const ids = new Set(ctx.datasets().map((d) => d.id));
  each(() => { if (!st.ds && !st.loading && st.id && ids.has(st.id)) openFile(st.id); else paintEmpty(); }, live());
  if (G.wantMine) on(A(), tryMine);
}

/** The Lab's file list changed (main.js): refresh the file pickers and the saved results. */
export function paintFiles() {
  if (!host) return;
  const ids = new Set(ctx.datasets().map((d) => d.id));
  each(() => {
    if (st.ds && !ids.has(st.id)) closeFile();
    else if (!st.ds && !st.loading && !st.error && st.id && ids.has(st.id)) openFile(st.id);
    else paintEmpty();
  }, live());
  paintBar();
  if (G.wantMine) on(A(), tryMine);
}

/** Opens a data file from another tab ("Chart" button in Files), in the active chart. */
export function show(id) { if (host) on(A(), () => openFile(id)); else G.pre = { id }; }

/** Draws a backtest result on the active chart (the report's "Show on chart"), opening its data file first. */
export function showResult(R, id) {
  G.wantTf = R.meta.interval_ms || INTERVAL_MS[R.meta.interval] || 0;
  if (!host) { G.pre = { id: R.meta.dataset, pending: { R, id } }; return; }
  on(A(), () => showResultHere(R, id));
}
function showResultHere(R, id) {
  const ds = R.meta.dataset;
  G.wantTf = R.meta.interval_ms || INTERVAL_MS[R.meta.interval] || 0;
  if (st.id !== ds || !st.ds) { st.pending = { R, id }; openFile(ds); return; }
  const tf = pickTf(G.wantTf);
  G.wantTf = 0;
  if (tf && tf !== G.tf) setTf(tf, st);
  setStrat(R, id);
}

const dsLabel = (d) => `${d.symbol} ${d.interval || ''} · ${d.market} · ${ymd(d.start_ts)} → ${ymd(d.end_ts)}`;
const tfName = (ms) => TF_NAMES.find((k) => INTERVAL_MS[k] === ms) || `${Math.round(ms / 60000)}m`;

function paintLayout() {
  const stage = host && $('#lab-ch-stage', host);
  if (!stage) return;
  stage.dataset.n = String(G.n);
  for (const p of panes) {
    p.el.hidden = p.i >= G.n;
    p.el.classList.toggle('on', G.n > 1 && p.i === G.active);
  }
}
const saveLayout = () => save('layout', { n: G.n, sync: G.sync, active: G.active });
const savePanes = () => save('panes', panes.map((p) => ({ id: p.id, type: p.type, log: p.log, ind: p.ind })));

/** 1 to 4 charts. Charts taken out of the layout keep their file and settings for when they come back. */
function setLayout(n) {
  n = Math.max(1, Math.min(MAXN, n | 0));
  if (n === G.n) return;
  for (const p of panes.slice(n)) on(p, () => { destroyChart(); Object.assign(p, { ds: null, B: null, loading: false, error: null, strat: null, pending: null, pos: null, ptrades: [] }); p.runners.clear(); });
  G.n = n;
  if (G.active >= n) G.active = 0;
  if (G.draft && G.draft.p.i >= n) G.draft = null;
  paintLayout();
  saveLayout();
  for (const p of loaded()) p.chart.applyOptions({ rightPriceScale: { minimumWidth: G.n > 2 ? 64 : 86 } });
  const ids = new Set(ctx.datasets().map((d) => d.id));
  each(() => {
    if (!st.ds && !st.loading && st.id && ids.has(st.id)) openFile(st.id);
    else { paintEmpty(); if (st.chart) { legend(null); placeLegendsSoon(); } }
  }, live());
  paintBar();
  paintReplay();
  paintStrat(true);
}
function setActive(p) {
  if (p.i === G.active || p.i >= G.n) return;
  G.active = p.i;
  if (G.draft && G.draft.p !== p) { G.draft = null; for (const q of loaded()) if (q.layer) q.layer.redraw(); }
  paintLayout();
  saveLayout();
  paintBar();
  paintReplay();
  paintStrat(true);
}

function fileOptions() {
  const rows = ctx.datasets();
  const group = (folder, name) => {
    const r = rows.filter((d) => d.folder === folder);
    return r.length ? `<optgroup label="${name} folder">${r.map((d) => `<option value="${d.id}" ${d.id === st.id ? 'selected' : ''}>${esc(dsLabel(d))}</option>`).join('')}</optgroup>` : '';
  };
  return `<option value="">${rows.length ? 'Pick a data file…' : 'No data files yet'}</option>${group('downloads', 'Downloads')}${group('uploads', 'Uploads')}`;
}

/** The toolbar, for the active chart. */
function paintBar() { if (host) on(A(), paintBarNow); }
function paintBarNow() {
  const bar = $('#lab-ch-bar', host);
  if (!bar) return;
  const withData = live().filter((p) => p.ds);
  const tfs = withData.length ? TF_NAMES.filter((k) => withData.every((p) => okFor(p, INTERVAL_MS[k]))) : [];
  const typeBtn = (t, label) => `<button class="lab-ch-seg ${st.type === t ? 'on' : ''}" data-ch="type" data-type="${t}" aria-pressed="${st.type === t}">${label}</button>`;
  const any = loaded().length > 0;
  const n = countOn();
  bar.innerHTML = `
    <span class="lab-ch-segs" role="group" aria-label="Charts on the screen">${[1, 2, 3, 4].map((k) => `<button class="lab-ch-seg lab-ch-lay ${G.n === k ? 'on' : ''}" data-ch="layout" data-n="${k}" title="${k === 1 ? 'One chart' : `${k} charts side by side (one timeframe, one replay)`}" aria-label="${plural(k, 'chart')}" aria-pressed="${G.n === k}">${ic(LAYOUT_IC[k])}</button>`).join('')}</span>
    <select class="input lab-ch-file" data-ch="file" aria-label="${G.n > 1 ? `Data file of chart ${st.i + 1}` : 'Data file'}">${fileOptions()}</select>
    <select class="input lab-ch-tf" data-ch="tf" aria-label="Timeframe" ${tfs.length ? '' : 'disabled'} title="Timeframe${G.n > 1 ? ' of every chart' : ''}: the file's own candles, or bigger ones built from them">
      ${tfs.length ? tfs.map((k) => `<option value="${INTERVAL_MS[k]}" ${INTERVAL_MS[k] === G.tf ? 'selected' : ''}>${k}</option>`).join('') : '<option>–</option>'}
    </select>
    <span class="lab-ch-segs" role="group" aria-label="Chart type">${typeBtn('candles', 'Candles')}${typeBtn('bars', 'Bars')}${typeBtn('ha', 'Heikin Ashi')}${typeBtn('line', 'Line')}</span>
    <details class="lab-ch-menu" id="lab-ch-ind" data-menu="ind">
      <summary class="btn btn-sm">${icon('chart')}Indicators${n ? ` <b class="lab-ch-count">${n}</b>` : ''}</summary>
      <div class="lab-ch-pop lab-ch-ipop">
        <div class="lab-ch-ihead">On the candles</div>${Object.keys(IND).filter((k) => IND[k].where !== 'pane').map(indRow).join('')}
        <div class="lab-ch-ihead">In a pane of their own</div>${Object.keys(IND).filter((k) => IND[k].where === 'pane').map(indRow).join('')}
        <div class="lab-ch-ifoot"><button class="btn btn-sm" data-ch="indoff" ${n ? '' : 'disabled'}>${icon('trash')}Remove all indicators</button></div>
        <p class="faint small">The numbers are each indicator's settings (in candles where it is a length). The × next to an indicator on the chart removes it. Click outside this menu to close it.</p>
      </div>
    </details>
    <details class="lab-ch-menu" id="lab-ch-smenu" data-menu="strat">
      <summary class="btn btn-sm ${st.strat ? 'lab-ch-on' : ''}">${ic(IC.flask)}Strategy</summary>
      <div class="lab-ch-pop lab-ch-spop">${stratMenu()}</div>
    </details>
    <button class="btn btn-sm ${G.mine ? 'lab-ch-on' : ''}" data-ch="mine" title="Show your journal trades on this coin" aria-pressed="${G.mine}">${ic(IC.me)}My trades</button>
    <span class="lab-ch-tools" role="group" aria-label="Drawing tools">
      ${TOOLS.map(([t, label, svg]) => `<button class="btn btn-sm lab-ch-tool ${G.tool === t ? 'on' : ''}" data-ch="tool" data-tool="${t}" title="${label}" aria-label="${label}" aria-pressed="${G.tool === t}">${ic(svg)}</button>`).join('')}
      <button class="btn btn-sm lab-ch-tool" data-ch="undo" title="Undo (Ctrl+Z)" aria-label="Undo" ${st.B && (st.drawings.length || st.undoAll) ? '' : 'disabled'}>${ic(IC.undo)}</button>
      <button class="btn btn-sm lab-ch-tool" data-ch="clear" title="Delete every drawing and indicator on this chart (Delete key)" aria-label="Delete all drawings and indicators" ${st.B && (st.drawings.length || n) ? '' : 'disabled'}>${icon('trash')}</button>
    </span>
    <button class="btn btn-sm lab-ch-tool ${st.log ? 'on' : ''}" data-ch="log" title="Logarithmic price scale" aria-pressed="${st.log}" ${st.B ? '' : 'disabled'}>${ic(IC.log)}Log</button>
    ${G.n > 1 ? `<button class="btn btn-sm lab-ch-tool ${G.sync ? 'on' : ''}" data-ch="sync" title="Link the charts: the crosshair and scrolling follow the same time on every chart" aria-pressed="${G.sync}">${ic(IC.link)}Sync</button>` : ''}
    <span class="lab-ch-fill"></span>
    <input class="input lab-ch-date" type="date" data-ch="goto" aria-label="Go to a date" title="Go to a date" ${st.B ? '' : 'disabled'}>
    <button class="btn btn-sm" data-ch="fit" title="Show every candle" ${st.B ? '' : 'disabled'}>${ic(IC.fit)}<span class="sr-only">Show all</span></button>
    <button class="btn btn-sm" data-ch="png" title="Save the chart${G.n > 1 ? 's' : ''} as a PNG picture" ${any ? '' : 'disabled'}>${ic(IC.camera)}<span class="sr-only">Save PNG</span></button>
    <button class="btn btn-sm ${isFull() ? 'lab-ch-on' : ''}" data-ch="full" title="${isFull() ? 'Leave full screen (Esc)' : 'Full screen'}" aria-pressed="${isFull()}" ${any ? '' : 'disabled'}>${isFull() ? ic(IC.shrink) : icon('expand')}<span class="sr-only">${isFull() ? 'Leave full screen' : 'Full screen'}</span></button>
    <button class="btn btn-sm ${G.replay || G.picking ? 'btn-green' : ''}" data-ch="replay" title="Replay a portion of the chart${G.n > 1 ? 's' : ''} candle by candle" ${any ? '' : 'disabled'}>${ic(IC.replay)}Replay</button>`;
  if (G.menu) { const d = $(`details[data-menu="${G.menu}"]`, bar); if (d) { d.open = true; fitPop(d); } }
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
  const off = d.intraday && G.tf >= DAY;
  const dots = (d.lines || []).filter(([, c]) => c).slice(0, 3).map(([, c]) => `<i class="lab-ch-dot" style="background:${c}"></i>`).join('');
  return `<div class="lab-ch-irow">
    <label class="check"><input type="checkbox" data-ind="${k}" ${s.on ? 'checked' : ''} ${off ? 'disabled' : ''}><span>${esc(d.label)} ${dots}${d.note ? ` <span class="faint small">(${esc(d.note)})</span>` : ''}${off ? ' <span class="faint small">(timeframes under 1 day)</span>' : ''}</span></label>
    ${(d.params || []).length ? `<span class="lab-ch-iparams">${d.params.map(([pk, label, , min, max, step]) => `<input class="input lab-ch-num" type="number" min="${min}" max="${max}" step="${step}" value="${s[pk]}" data-ind-p="${k}" data-p="${pk}" title="${esc(label)}" aria-label="${esc(d.label)}: ${esc(label)}">`).join('')}</span>` : ''}
  </div>`;
}

/** The note shown in a chart without candles (no file, opening, an error). */
function paintEmpty() {
  const el = st.el && $('.lab-ch-pempty', st.el);
  if (!el) return;
  const rows = ctx.datasets();
  const pick = G.n > 1 ? `<select class="input lab-ch-file" data-ch="file" aria-label="Data file of chart ${st.i + 1}">${fileOptions()}</select>` : '';
  let html = '';
  if (st.loading) html = '<div class="lab-note"><span class="spin"></span> Opening the file…</div>';
  else if (st.error) html = `<div class="err">${esc(st.error)}</div>${pick}`;
  else if (!st.ds) html = rows.length
    ? `<div class="lab-note">Pick a data file ${G.n > 1 ? `for chart ${st.i + 1}` : 'above'} to draw its chart. Files come from the <button class="link" type="button" data-lab="tab" data-tab="files">Downloads and Uploads folders</button>.</div>${pick}`
    : `<div class="lab-note">No data files yet. <button class="link" type="button" data-lab="tab" data-tab="data">Download candles from Binance</button> into MEDUSA, then open them here.</div>`;
  el.innerHTML = html;
  el.hidden = !html;
  st.el.classList.toggle('empty', !st.B);
}

/* ======================= opening a file ======================= */

async function openFile(id) {
  const p = st;
  const row = ctx.datasets().find((d) => d.id === id);
  if (!row) {
    if (p.pending && p.pending.R.meta.dataset === id) { p.pending = null; toast('The data file of this result isn’t in MEDUSA any more.', 'error'); }
    return;
  }
  if (p.strat && p.strat.R.meta.dataset !== id) p.strat = null;
  Object.assign(p, { id, row, loading: true, error: null, pos: null, ptrades: [], undoAll: null });
  p.runners.clear();
  savePanes();
  paintBar();
  paintEmpty();
  let ds = null, err = null;
  try { ds = await data.loadDataset(id); } catch (e) { err = e.message; }
  st = p;
  if (p.id !== id) return;
  p.loading = false;
  if (!err && ds.n < 2) err = 'This file has fewer than 2 candles.';
  if (!err) {
    Object.assign(p, { ds, B: null, base: INTERVAL_MS[row.interval] || INTERVAL_MS[ds.meta && ds.meta.interval] || gapOf(ds.cols.t), prec: precisionOf(ds.cols.c) });
    if (!pickTf(G.wantTf)) err = `This file's ${tfName(p.base)} candles can't share a timeframe with the other charts. Show it on its own (the one-chart layout) or next to files with the same candles.`;
  }
  if (err) {
    Object.assign(p, { error: err, ds: null, B: null, strat: null, pending: null });
    destroyChart();
    paintEmpty();
    paintBar();
    paintStrat();
    return;
  }
  const tf = pickTf(G.wantTf);
  G.wantTf = 0;
  const changed = G.tf && tf !== G.tf;
  const twin = live().find((q) => q !== p && q.ds && q.row && drawKeyOf(q) === drawKeyOf(p));
  p.drawings = twin ? twin.drawings : load(`draw.${drawKey()}`, []);
  ctx.log('lab', `Chart: ${row.symbol} ${tfName(tf)} (${plural(ds.n, 'candle')} in the file)`, null, 'debug');
  const pend = p.pending && p.pending.R.meta.dataset === id ? p.pending : null;
  p.pending = null;
  if (pend) setStrat(pend.R, pend.id, false);
  if (changed) setTf(tf, p);
  else { G.tf = tf; save('tf', tf); }
  build();
  if (p.focusMine) { const fid = p.focusMine; p.focusMine = null; focusMineId(fid); }
  if (changed) toast(`Every chart now shows ${tfName(tf)} candles: the charts share one timeframe.`);
  if (!pend && !p.strat) restoreStrat(id);
}

function closeFile() {
  Object.assign(st, { id: null, row: null, ds: null, B: null, strat: null, pos: null, ptrades: [], error: null });
  destroyChart();
  savePanes();
  paintBar();
  paintEmpty();
  paintStrat();
}

const drawKeyOf = (p) => `${p.row.symbol}-${p.row.market}`;
const drawKey = () => drawKeyOf(st);

/* ---------- one timeframe for every chart ---------- */

const okFor = (p, ms) => ms > 0 && ms >= p.base && ms % p.base === 0;
/** The timeframe every chart with a file can show: `prefer` if it can, else the current one, else the
    nearest bigger one (or a quick one for a first file). 0 when there is none. */
function pickTf(prefer) {
  const ps = live().filter((p) => p.ds);
  const ok = (ms) => ms > 0 && ps.every((p) => okFor(p, ms));
  if (ok(prefer)) return prefer;
  if (ok(G.tf)) return G.tf;
  const all = TF_NAMES.map((k) => INTERVAL_MS[k]).filter(ok);
  if (!all.length) return ps.length === 1 && ok(ps[0].base) ? ps[0].base : 0;
  const want = G.tf || defaultTf(st.ds.n, st.base);
  return all.find((ms) => ms >= want) || all[all.length - 1];
}
/** Changes the timeframe and redraws every chart except `skip` (the caller draws that one). */
function setTf(tf, skip = null) {
  G.tf = tf;
  save('tf', tf);
  for (const p of loaded()) if (p !== skip) on(p, build);
  paintBar();
}

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

const anchorOf = (tf) => (tf === INTERVAL_MS['1w'] ? 4 * DAY : 0);   // 1 Jan 1970 was a Thursday; weeks start Monday
const bucketStart = (ms) => Math.floor((ms - anchorOf(G.tf)) / G.tf) * G.tf + anchorOf(G.tf);

/** Groups the file's candles into the timeframe's candles (UTC boundaries; weeks start Monday). */
function aggregate(ds, tf) {
  const { t, o, h, l, c } = ds.cols;
  const v = ds.cols.v || new Float64Array(ds.n);
  const anchor = anchorOf(tf);
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
  if (st.chart) st.chart.remove();
  Object.assign(st, { chart: null, main: null, vol: null, layer: null, markers: null, markSig: '', posLine: null, hlines: [], feeds: [], groups: [], fills: [] });
  if (st.el) { $('.lab-ch-plegs', st.el).innerHTML = ''; $('.lab-ch-legend', st.el).innerHTML = ''; }
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
  rightPriceScale: { borderColor: '#303030', minimumWidth: G.n > 2 ? 64 : 86 },
  timeScale: { borderColor: '#303030', timeVisible: G.tf < DAY, secondsVisible: false, rightOffset: 12, barSpacing: 7, minBarSpacing: 0.02 },
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

/** (Re)builds the candles, indicators, strategy and chart of this chart's file, timeframe and settings. */
function build() {
  paintBar();
  if (!st.ds) { destroyChart(); paintEmpty(); paintStrat(); return; }
  const tfKey = `${st.id}:${G.tf}`;
  const same = st.B && st.B.tfKey === tfKey;
  const keepRange = st.chart && same ? st.chart.timeScale().getVisibleLogicalRange() : null;
  if (!same) {
    st.B = aggregate(st.ds, G.tf);
    st.B.tfKey = tfKey;
    st.runners.clear();
    if (st.B.n > 400_000) toast(`${st.B.n.toLocaleString('en-US')} candles: the chart may be slow. A bigger timeframe keeps it quick.`);
  }
  st.ha = st.type === 'ha' ? haOf(st.B) : null;
  destroyChart();
  paintEmpty();
  const el = st.el;
  const chart = (st.chart = createChart(el, baseOptions()));
  const pf = pricePf();
  const main = (st.main = st.type === 'line' ? chart.addSeries(LineSeries, { color: '#e5e7eb', lineWidth: 2, priceFormat: pf })
    : st.type === 'bars' ? chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false, priceFormat: pf })
      : chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat: pf }));
  chart.priceScale('right').applyOptions({ mode: st.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, scaleMargins: { top: 0.08, bottom: st.ind.vol.on ? 0.22 : 0.08 } });
  if (st.ind.vol.on) {
    st.vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  }
  let pane = 1;
  for (const k of Object.keys(IND)) {
    const d = IND[k];
    if (d.where === 'vol' || !st.ind[k].on || (d.intraday && G.tf >= DAY)) continue;
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
  const panesOf = chart.panes();
  el.style.setProperty('--panes', String(panesOf.length - 1));
  if (panesOf.length > 1) {
    const H = el.clientHeight || 420 + PANE_PX * (panesOf.length - 1);
    panesOf[0].setStretchFactor(Math.max(1.5, (H - PANE_PX * (panesOf.length - 1)) / PANE_PX));
    for (let i = 1; i < panesOf.length; i++) panesOf[i].setStretchFactor(1);
  }
  st.layer = new Layer(st);
  main.attachPrimitive(st.layer);
  st.markers = createSeriesMarkers(main, []);
  const p = st;
  chart.subscribeCrosshairMove((param) => on(p, () => onMove(param)));
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => on(p, () => onRange(r)));
  setAll(G.replay ? kAt(st, G.replay.cut) : st.ds.n);
  paintHlines();
  paintMarkers();
  if (G.replay) focusReplay();
  else if (keepRange) setRange(keepRange, false);
  else if (st.strat && st.strat.sel >= 0) focusTrade(st.strat.sel);
  else if (!followOthers()) showRecent();
  paintPaneLegends();
  legend(null);
  paintReplay();
  paintStrat();
  placeLegendsSoon();
}

/** Sets the visible candles. share: linked charts show the same times (else they are left as they are). */
function setRange(range, share = true) {
  st.chart.timeScale().setVisibleLogicalRange(range);
  if (share && G.sync && G.n > 1) shareRange(range);
}
/** Shows the last ~160 candles, the way TradingView opens a chart. */
function showRecent(end = st.B.n - 1) {
  setRange({ from: end - 160, to: end + 12 }, false);
}
/** With Sync on, a chart that opens shows the same times as the others (when it has candles then). */
function followOthers() {
  if (!G.sync || G.n < 2) return false;
  const q = loaded().find((x) => x !== st && x.chart);
  const r = q && q.chart.timeScale().getVisibleLogicalRange();
  if (!r) return false;
  const a = on(q, () => logicalToMs(r.from)), b = on(q, () => logicalToMs(r.to));
  if (b < st.B.T[0] || a > st.B.T[st.B.n - 1]) return false;
  setRange({ from: msToLogical(a), to: msToLogical(b) }, false);
  return true;
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

/** Sets every series to the candles revealed so far (file candles 0..K-1; none in a replay before the file starts). */
function setAll(K) {
  if (K < 1) {
    st.main.setData([]);
    if (st.vol) st.vol.setData([]);
    for (const f of st.feeds) { f.series.setData([]); Object.assign(f, { last: NaN, lastOk: false, lastJ: -1 }); }
    st.shownTo = -1;
    st.K = 0;
    return;
  }
  const J = lastBar(K);
  const M = new Array(J + 1), Vv = st.vol ? new Array(J + 1) : null, vals = st.feeds.map(() => new Float64Array(J + 1));
  for (let j = 0; j <= J; j++) {
    const fb = j < J ? null : barFor(j, K);
    const bar = fb ? fb.bar : fullBar(j), done = fb ? fb.done : true;
    M[j] = mainPoint(j, bar, done);
    if (Vv) Vv[j] = volPoint(j, bar);
    for (let q = 0; q < st.feeds.length; q++) vals[q][j] = st.feeds[q].get(j, K, bar, done);
  }
  st.main.setData(M);
  if (st.vol) st.vol.setData(Vv);
  st.feeds.forEach((f, q) => f.series.setData(feedPoints(f, vals[q], J)));
  st.shownTo = J;
  st.K = K;
}

/** Moves a replay from file candle k0 to k1 (> k0) with small updates instead of redrawing it all. */
function advance(k0, k1) {
  const j0 = lastBar(k0), j1 = lastBar(k1);
  for (let j = j0; j <= j1; j++) {
    const { bar, done } = barFor(j, k1);
    st.main.update(mainPoint(j, bar, done));
    if (st.vol) st.vol.update(volPoint(j, bar));
    for (const f of st.feeds) feedUpdate(f, j, k1, bar, done);
  }
  st.shownTo = j1;
  st.K = k1;
}
/** Shows file candles 0..k-1 (a replay step), the quick way when it only moves forward. */
function moveTo(k) {
  if (k === st.K) return;
  if (k > st.K && st.K >= 1) advance(st.K, k);
  else setAll(k);
}

/* ======================= the backtest on the chart ======================= */

/** Draws backtest result R (saved as `id`, or null) on this chart. */
function setStrat(R, id, rebuild = true) {
  const trades = (R.trades || []).map((x, n) => ({ ...x, n: n + 1 })).sort((a, b) => a.et - b.et);
  const p = st;
  const s = { R, id: id || null, trades, sel: -1, plots: null, plotsErr: null, plotsLoading: true };
  p.strat = s;
  save(`strat.${R.meta.dataset}`, s.id);
  const key = R.config && R.config.strategy;
  if (key && (ctx.strategies() || []).some((x) => x.key === key)) {
    G.sform.strategy = key;
    G.sform.params[key] = { ...(R.meta.params || {}) };
    save('sform', G.sform);
  }
  ctx.plots(R).then((out) => on(p, () => {
    if (p.strat !== s) return;
    s.plotsLoading = false;
    if (out.error) { s.plotsErr = out.error; paintStrat(); return; }
    s.plots = prepPlots(out);
    if (s.plots.length) build(); else paintStrat();
  })).catch((e) => { if (p.strat === s) { s.plotsLoading = false; s.plotsErr = e.message; paintStrat(); } });
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
  const p = st;
  ctx.fetchResult(id).then((R) => on(p, () => { if (p.id === dataset && p.ds && !p.strat && R.meta.dataset === dataset) setStrat(R, id); })).catch(() => {});
}

/** The strategy's lines from Python, lined up with the file's candles. */
function prepPlots(out) {
  const t = st.ds.cols.t;
  let a = 0, b = st.ds.n - 1;
  while (a < b) { const m = (a + b) >> 1; if (t[m] < out.start) a = m + 1; else b = m; }
  const p0 = a;
  return out.plots.map((p, i) => ({ name: p.name, kind: p.kind, values: p.values, p0, on: p.kind === 'price', color: PLOT_COLORS[i % PLOT_COLORS.length] }));
}

/** The open time of the last file candle shown (in a replay; everything is shown otherwise). */
const nowT = () => (G.replay ? (st.K ? st.ds.cols.t[st.K - 1] : -Infinity) : Infinity);

/** The strategy's lines, its account value and buy & hold, as feeds like the indicators'. */
function addStrategySeries(nextPane) {
  const s = st.strat, B = st.B, t = st.ds.cols.t, pf = pricePf(), chart = st.chart;
  const lastFile = (j) => B.first[j + 1] - 1;
  if (G.sshow.lines && s.plots) {
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
  if (G.sshow.equity && s.R.equity && s.R.equity.t && s.R.equity.t.length) {
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

/** How many trades of a list (sorted by entry) had started by `now`, and how many had ended (binary
    searches, so a replay step costs the same with 10 trades or 10,000). */
function upto(list, now) {
  let a = 0, b = list.length;
  while (a < b) { const m = (a + b) >> 1; if (list[m].et <= now) a = m + 1; else b = m; }
  return a;
}
function ended(set, now) {
  const xs = set.xts || (set.xts = Float64Array.from(set.trades, (x) => x.xt).sort());
  let a = 0, b = xs.length;
  while (a < b) { const m = (a + b) >> 1; if (xs[m] <= now) a = m + 1; else b = m; }
  return a;
}
/** The trades shown now (in a replay: the ones that have started). */
const shownTrades = () => { const s = st.strat; return s ? s.trades.slice(0, upto(s.trades, nowT())) : []; };
const tradeResult = (x) => (x.r != null && fin(x.r) ? `${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R` : `${x.ret >= 0 ? '+' : ''}${(x.ret * 100).toFixed(2)}%`);
const openResult = (x) => { const p = st.ds.cols.c[st.K - 1]; return { p, ret: ((p - x.ep) / x.ep) * x.side }; };

function paintMarkers(force = false) {
  if (!st.markers || !st.B) return;
  const now = nowT();
  const s0 = st.strat && G.sshow.trades ? st.strat : null, me0 = mineOf();
  const cnt = (set, k) => (set ? `${k}.${upto(set.trades, now)}.${ended(set, now)}.${set.sel}` : '-');
  const sig = `${cnt(s0, s0 && s0.R.meta.made)}|${cnt(me0, me0 && me0.key)}|${G.replay ? `${st.ptrades.filter((x) => x.t <= now).length}.${st.ptrades.filter((x) => x.xt <= now).length}.${st.pos ? st.pos.t : 0}` : ''}`;
  if (!force && sig === st.markSig) return;              // nothing entered or left: the markers stay as they are
  st.markSig = sig;
  const m = [];
  const at = (ms) => sec(st.B.T[indexOfTime(ms)]);
  const s = st.strat;
  if (s && G.sshow.trades) {
    for (const x of s.trades) {
      if (x.et > now) break;
      const sel = s.sel === x.n - 1, long = x.side > 0;
      m.push({ time: at(x.et), position: long ? 'belowBar' : 'aboveBar', color: long ? UP : DOWN, shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'Long' : 'Short', size: sel ? 2 : 1, id: `e${x.n}` });
      if (x.xt <= now) m.push({ time: at(x.xt), position: long ? 'aboveBar' : 'belowBar', color: x.pnl >= 0 ? '#86efac' : '#fca5a5', shape: 'circle', text: tradeResult(x), size: sel ? 1.4 : 0.7, id: `x${x.n}` });
    }
  }
  const me = mineOf();
  if (me) {
    for (const x of me.trades) {
      if (x.et > now) break;
      const sel = me.sel === x.n - 1, long = x.side > 0;
      m.push({ time: at(x.et), position: long ? 'belowBar' : 'aboveBar', color: MINE, shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'My long' : 'My short', size: sel ? 2 : 1 });
      if (x.xt <= now) m.push({ time: at(x.xt), position: long ? 'aboveBar' : 'belowBar', color: x.pnl >= 0 ? '#86efac' : '#fca5a5', shape: 'square', text: netText(x), size: sel ? 1.2 : 0.6 });
    }
  }
  if (G.replay) {
    for (const x of st.ptrades) {
      if (x.t <= now) m.push({ time: at(x.t), position: x.side === 'long' ? 'belowBar' : 'aboveBar', color: '#facc15', shape: x.side === 'long' ? 'arrowUp' : 'arrowDown', text: x.side === 'long' ? 'Buy' : 'Sell' });
      if (x.xt <= now) m.push({ time: at(x.xt), position: x.side === 'long' ? 'aboveBar' : 'belowBar', color: '#facc15', shape: 'circle', text: `${x.ret >= 0 ? '+' : ''}${x.ret.toFixed(2)}%` });
    }
    if (st.pos) m.push({ time: at(st.pos.t), position: st.pos.side === 'long' ? 'belowBar' : 'aboveBar', color: '#facc15', shape: st.pos.side === 'long' ? 'arrowUp' : 'arrowDown', text: st.pos.side === 'long' ? 'Buy' : 'Sell' });
  }
  m.sort((a, b) => a.time - b.time);
  st.markers.setMarkers(m);
  if (st.posLine) { st.main.removePriceLine(st.posLine); st.posLine = null; }
  if (G.replay && st.pos) st.posLine = st.main.createPriceLine({ price: st.pos.entry, color: '#facc15', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: st.pos.side === 'long' ? 'Long' : 'Short' });
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
  setRange({ from: eb - pad, to: xb + pad });
  paintMarkers();
  if (st.layer) st.layer.redraw();
  paintStrat(true);
}
function stepTrade(dir) {
  const s = st.strat;
  if (!s) return;
  const list = shownTrades();
  if (!list.length) { toast(G.replay ? 'No trades yet at this point of the replay.' : 'This test made no trades.'); return; }
  let pos;
  const cur = list.findIndex((x) => x.n - 1 === s.sel);
  if (cur >= 0) pos = cur + dir;
  else {
    const r = st.chart.timeScale().getVisibleLogicalRange();
    const mid = r ? (r.from + r.to) / 2 : st.shownTo;
    if (dir > 0) { pos = list.findIndex((x) => indexOfTime(x.et) > mid); if (pos < 0) pos = list.length - 1; }
    else { pos = -1; list.forEach((x, q) => { if (indexOfTime(x.et) < mid) pos = q; }); if (pos < 0) pos = 0; }
  }
  pos = Math.max(0, Math.min(list.length - 1, pos));
  focusTrade(list[pos].n - 1);
}

/** The panel under the charts: the active chart's test, its numbers and its list of trades (click one to see it). */
let stratSig = '';
function paintStrat(force = false) { if (host) on(A(), () => { paintStratNow(force); paintMineNow(force); }); }
function paintStratNow(force) {
  const el = $('#lab-ch-strat', host);
  if (!el) return;
  const s = st.strat;
  if (!s || !st.ds || !st.B) { el.hidden = true; el.innerHTML = ''; stratSig = ''; return; }
  const now = nowT();
  const nShown = upto(s.trades, now), lastT = s.trades[nShown - 1];
  const open = lastT && lastT.xt > now ? lastT : null;
  const sig = `${st.i}|${s.R.meta.made}|${s.id}|${nShown}|${open ? open.n : 0}|${s.sel}|${G.sshow.trades}|${G.sshow.lines}|${G.sshow.equity}|${s.plotsLoading}|${s.plotsErr}|${s.plots ? s.plots.map((p) => +p.on).join('') : ''}|${Boolean(G.replay)}`;
  if (!force && sig === stratSig && !el.hidden) { paintStratLive(); return; }
  stratSig = sig;
  el.hidden = false;
  const list = shownTrades();
  const R = s.R, sm = R.summary, ts = sm.trades || {};
  const closed = list.filter((x) => x.xt <= now);
  const pct = (v, dp = 1) => (fin(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%` : '–');
  const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  let chips;
  if (G.replay) {
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
      <div class="lab-ch-sname"><b>${G.n > 1 ? `${esc(st.row.symbol)} · ` : ''}${esc(R.meta.strategy_label)}</b><span class="faint small">${esc(R.meta.settings_text || '')}</span>${s.id ? '' : '<span class="lab-ch-tag" title="Not in the Results folder: it is gone when you reload. Open the report to save it.">not saved</span>'}</div>
      <div class="lab-ch-schips">${chips.map(([k, v, t]) => `<span class="lab-ch-chip"><span class="faint">${k}</span><b class="${t}">${v}</b></span>`).join('')}</div>
      <div class="lab-ch-sbtns">
        <label class="check small"><input type="checkbox" data-sshow="trades" ${G.sshow.trades ? 'checked' : ''}><span>Trades</span></label>
        <label class="check small"><input type="checkbox" data-sshow="lines" ${G.sshow.lines ? 'checked' : ''}><span>Lines</span></label>
        <label class="check small"><input type="checkbox" data-sshow="equity" ${G.sshow.equity ? 'checked' : ''}><span>Account value</span></label>
        <button class="btn btn-sm" data-ch="sprev" title="Previous trade">${ic(IC.prev)}<span class="sr-only">Previous trade</span></button>
        <button class="btn btn-sm" data-ch="snext" title="Next trade">${ic(IC.next)}<span class="sr-only">Next trade</span></button>
        <button class="btn btn-sm" data-ch="sedit" title="Change the settings and run it again">${icon('edit')}Settings</button>
        <button class="btn btn-sm" data-ch="sreport" title="The full report on the Dashboard">${icon('book')}Report</button>
        <button class="btn btn-sm" data-ch="sremove" title="Take the strategy off the chart">${ic(IC.close)}<span class="sr-only">Remove</span></button>
      </div>
    </div>
    ${G.sshow.lines ? `<div class="lab-ch-sline">${plotsNote}</div>` : ''}
    ${list.length ? `<div class="lab-ch-tscroll" id="lab-ch-tscroll"><table class="lab-table lab-ch-trades"><thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Exit</th><th>Result</th><th class="l">Exit reason</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="dim small">${G.replay ? 'No trades yet at this point of the replay.' : 'This test made no trades.'}</p>`}`;
  const box = $('#lab-ch-tscroll', el);
  if (box) {
    const sel = $('tr.on', box);
    if (sel) box.scrollTop = sel.offsetTop - box.clientHeight / 2;
    else if (G.replay) box.scrollTop = box.scrollHeight;
  }
}
/** In a replay: the open trade's result follows the price. */
function paintStratLive() {
  const cell = $('#lab-ch-strat [data-live]', host);
  if (!cell || !st.strat) return;
  const x = st.strat.trades[upto(st.strat.trades, nowT()) - 1];
  if (!x) return;
  const { ret } = openResult(x);
  cell.textContent = `${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(2)}%`;
  cell.className = ret >= 0 ? 'pos' : 'neg';
}

/* ======================= your trades from the journal ======================= */

const MINE = '#38bdf8';
/** CoinDCX futures pair -> Binance symbol: B-BTC_USDT -> BTCUSDT (CoinDCX's "B-" markets are Binance's). */
const binanceSym = (t) => (t.pair ? String(t.pair).replace(/^[A-Z]+-/, '').replace(/_/g, '') : `${t.base || ''}${t.mcur || ''}`).toUpperCase();
const netText = (x) => (x.mcur && x.mcur !== 'USDT' ? `${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)} ${x.mcur}` : `${x.pnl >= 0 ? '+' : ''}${money(x.pnl)}`);
/** The file candle open at time ms (its index), for the price check. */
function fileAt(ms) {
  const t = st.ds.cols.t;
  let a = 0, b = st.ds.n - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (t[m] <= ms) a = m; else b = m - 1; }
  return a;
}
/**
 * Your journal trades on this chart's coin, in the shape of a backtest's trades (so they are drawn the
 * same way). Worked out once per file and journal, then kept. Prices are checked against the candles:
 * a coin quoted per 1,000 units on one exchange and per unit on the other is scaled; one that doesn't
 * match at all isn't drawn.
 */
function mineOf() {
  if (!G.mine || !st.ds || !st.row || !ctx.myTrades) return null;
  const all = ctx.myTrades() || [];
  const key = `${st.id}|${all.length}|${all.length ? all[all.length - 1].id : ''}`;
  if (st.mine && st.mine.key === key) return st.mine;
  const sym = String(st.row.symbol).toUpperCase();
  const t0 = st.ds.cols.t[0], t1 = st.ds.cols.t[st.ds.n - 1] + st.base;
  const coin = all.filter((t) => binanceSym(t) === sym && fin(t.entryAt) && fin(t.closeAt) && fin(t.entry) && fin(t.exit) && t.entry > 0);
  const inside = coin.filter((t) => t.entryAt >= t0 && t.closeAt <= t1).sort((a, b) => a.entryAt - b.entryAt);
  const ratios = inside.slice(0, 60).map((t) => t.entry / st.ds.cols.c[fileAt(t.entryAt)]).filter((x) => fin(x) && x > 0).sort((a, b) => a - b);
  let scale = 1, mismatch = false;
  if (ratios.length) {
    const r = ratios[ratios.length >> 1], k = 10 ** Math.round(Math.log10(r));
    if (Math.abs(r / k - 1) > 0.15) mismatch = true;
    else scale = 1 / k;
  }
  const trades = mismatch ? [] : inside.map((t, i) => {
    const side = t.side === 'short' ? -1 : 1, ep = t.entry * scale, xp = t.exit * scale;
    return { n: i + 1, id: t.id, et: t.entryAt, xt: t.closeAt, ep, xp, side, pnl: t.net ?? 0, ret: ((xp - ep) / ep) * side, why: t.exitKind || '', mcur: t.mcur, pair: t.pair };
  });
  st.mine = { key, trades, sel: -1, total: coin.length, outside: coin.length - inside.length, scale, mismatch, levels: 'none' };
  if (trades.length) loadLevels(st.mine, all.length);
  return st.mine;
}
/* The stop loss and take profit you set on CoinDCX: one request per coin (not per trade), kept for the
   visit, and asked again only when the journal changes. */
const levelCache = new Map();
function loadLevels(me, version) {
  if (!ctx.myLevels) return;
  const keys = [...new Set(me.trades.filter((x) => x.pair).map((x) => `${x.pair}|${x.mcur || 'USDT'}`))];
  if (!keys.length) return;
  me.levels = 'loading';
  Promise.all(keys.map((k) => {
    const ck = `${k}|${version}`;
    if (!levelCache.has(ck)) {
      const [pair, mcur] = k.split('|');
      levelCache.set(ck, ctx.myLevels(pair, mcur).catch((e) => { levelCache.delete(ck); throw e; }));
    }
    return levelCache.get(ck);
  })).then((maps) => {
    const lv = Object.assign({}, ...maps);
    for (const x of me.trades) {
      const v = lv[x.id];
      if (!v) continue;
      if (fin(v[0])) x.stop = v[0] * me.scale;
      if (fin(v[1])) x.tp = v[1] * me.scale;
      x.hit = v[2] === 1 ? 'sl' : v[2] === 2 ? 'tp' : '';
      const risk = fin(x.stop) ? Math.abs(x.ep - x.stop) : 0;
      if (risk > 0) x.r = ((x.xp - x.ep) * x.side) / risk;
    }
    me.levels = 'ready';
    for (const p of loaded()) if (p.mine === me && p.layer) p.layer.redraw();
    paintStrat(true);
  }).catch(() => { me.levels = 'error'; paintStrat(true); });
}
function setMine(on) {
  G.mine = on;
  save('mine', on);
  each(() => { st.mine = null; paintMarkers(); if (st.layer) st.layer.redraw(); });
  paintBar();
  paintStrat(true);
  const me = on && st.B ? mineOf() : null;
  if (me && !me.total) toast(`Your journal has no ${st.row.symbol} trades.`);
}
/** Centres your trade i on the chart and marks it. */
function focusMine(i) {
  const me = mineOf();
  const x = me && me.trades[i];
  if (!x || x.et > nowT()) return;
  me.sel = i;
  const eb = indexOfTime(x.et), xb = x.xt <= nowT() ? indexOfTime(x.xt) : st.shownTo;
  const pad = Math.max(25, (xb - eb) * 0.7);
  setRange({ from: eb - pad, to: xb + pad });
  paintMarkers();
  if (st.layer) st.layer.redraw();
  paintStrat(true);
}
function focusMineId(id) {
  const me = mineOf();
  const i = me ? me.trades.findIndex((x) => x.id === id) : -1;
  if (i < 0) { toast(me && me.mismatch ? `This file's prices don't match your ${st.row.symbol} trades.` : 'That trade isn’t in this file’s dates.'); return; }
  if (G.replay && me.trades[i].et > nowT()) stopReplay();
  focusMine(i);
}
function stepMine(dir) {
  const me = mineOf();
  if (!me) return;
  const now = nowT(), list = me.trades.filter((x) => x.et <= now);
  if (!list.length) return;
  const cur = list.findIndex((x) => x.n - 1 === me.sel);
  const pos = Math.max(0, Math.min(list.length - 1, cur < 0 ? (dir > 0 ? 0 : list.length - 1) : cur + dir));
  focusMine(list[pos].n - 1);
}
/** The journal's "Show on chart": opens a downloaded file of the trade's coin that covers it, on the active chart. */
export function showMine(id) { G.wantMine = id; if (host) on(A(), tryMine); }
function tryMine() {
  const id = G.wantMine;
  const t = id && (ctx.myTrades ? ctx.myTrades() : []).find((x) => x.id === id);
  if (!t) { G.wantMine = null; return; }
  if (ctx.filesLoaded && !ctx.filesLoaded()) return;          // the file list is on its way (paintFiles comes back here)
  G.wantMine = null;
  if (!G.mine) setMine(true);
  const sym = binanceSym(t);
  const fits = (d) => d && String(d.symbol).toUpperCase() === sym && d.start_ts <= t.entryAt && d.end_ts + DAY >= t.closeAt;
  const shown = live().find((p) => p.ds && fits(p.row));
  if (shown) { if (shown !== A()) setActive(shown); on(shown, () => focusMineId(id)); return; }
  const rows = ctx.datasets().filter(fits).sort((a, b) => (a.market === 'futures' ? 0 : 1) - (b.market === 'futures' ? 0 : 1) || (INTERVAL_MS[a.interval] || 0) - (INTERVAL_MS[b.interval] || 0));
  if (!rows.length) { toast(`No downloaded ${sym} file covers this trade (${ymd(t.entryAt)}). Download ${sym} in Get data, then press Show on chart again.`, 'error'); return; }
  st.focusMine = id;
  openFile(rows[0].id);
}

/** The panel under the charts: your trades on the active chart's coin (click one to see it). */
let mineSig = '';
function paintMineNow(force) {
  const el = $('#lab-ch-mine', host);
  if (!el) return;
  const me = st.B ? mineOf() : null;
  if (!me) { el.hidden = true; el.innerHTML = ''; mineSig = ''; return; }
  const now = nowT(), nShown = upto(me.trades, now);
  const sig = `${st.i}|${me.key}|${nShown}|${ended(me, now)}|${me.sel}|${Boolean(G.replay)}|${me.levels}`;
  if (!force && sig === mineSig && !el.hidden) return;
  mineSig = sig;
  const list = me.trades.slice(0, nShown), closed = list.filter((x) => x.xt <= now);
  el.hidden = false;
  const sym = esc(st.row.symbol);
  const hideBtn = `<button class="btn btn-sm" data-ch="mine" title="Hide your trades">${ic(IC.close)}<span class="sr-only">Hide my trades</span></button>`;
  if (!me.total || me.mismatch || !me.trades.length) {
    const why = !me.total ? 'Your journal has no trades on this coin.'
      : me.mismatch ? `This file's prices don't match your ${me.total} ${sym} trades on CoinDCX, so they aren't drawn.`
        : `Your ${plural(me.total, 'trade')} on this coin are outside this file's dates (${ymd(st.ds.cols.t[0])} → ${ymd(st.ds.cols.t[st.ds.n - 1])}).`;
    el.innerHTML = `<div class="lab-ch-shead"><div class="lab-ch-sname"><b>My trades on ${sym}</b><span class="faint small">${why}</span></div><div class="lab-ch-sbtns">${hideBtn}</div></div>`;
    return;
  }
  const net = closed.reduce((a, x) => a + x.pnl, 0), wins = closed.filter((x) => x.pnl > 0).length;
  const sum = { pnl: net, mcur: me.trades[0].mcur };
  const notes = [me.outside ? `${plural(me.outside, 'trade')} outside this file's dates` : '', me.scale !== 1 ? `prices scaled ×${+me.scale.toPrecision(3)} to match the file` : '',
    me.levels === 'loading' ? 'getting your stop losses and take profits…' : me.levels === 'error' ? 'your stop losses and take profits couldn’t be loaded' : ''].filter(Boolean).join(' · ');
  const rows = list.slice(-3000).map((x) => {
    const isOpen = x.xt > now;
    return `<tr data-ch="mtrade" data-n="${x.n - 1}" class="${me.sel === x.n - 1 ? 'on' : ''}" tabindex="0">
      <td>${x.n}</td><td class="${x.side > 0 ? 'pos' : 'neg'}">${x.side > 0 ? 'Long' : 'Short'}</td>
      <td>${esc(when(x.et, true))}<br><span class="faint">${fmt(x.ep)}</span></td>
      <td>${isOpen ? '<span class="faint">open</span>' : `${esc(when(x.xt, true))}<br><span class="faint">${fmt(x.xp)}</span>`}</td>
      <td class="neg">${fin(x.stop) ? fmt(x.stop) : '<span class="faint">–</span>'}</td><td class="pos">${fin(x.tp) ? fmt(x.tp) : '<span class="faint">–</span>'}</td>
      <td class="${isOpen ? '' : x.pnl >= 0 ? 'pos' : 'neg'}">${isOpen ? '–' : netText(x)}${!isOpen && fin(x.r) ? `<br><span class="faint">${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R</span>` : ''}</td><td class="l">${esc(isOpen ? '' : x.why)}</td></tr>`;
  }).join('');
  const chip = (k, v, t = '') => `<span class="lab-ch-chip"><span class="faint">${k}</span><b class="${t}">${v}</b></span>`;
  el.innerHTML = `
    <div class="lab-ch-shead">
      <div class="lab-ch-sname"><b><i class="lab-ch-dot lab-ch-medot"></i>My trades on ${sym}</b><span class="faint small">From your journal (CoinDCX)${notes ? ` · ${esc(notes)}` : ''}</span></div>
      <div class="lab-ch-schips">${chip(G.replay ? 'Closed so far' : 'Trades', closed.length.toLocaleString('en-US'))}${chip('Won', closed.length ? `${((wins / closed.length) * 100).toFixed(0)}%` : '–')}${chip('Net P&amp;L', closed.length ? netText(sum) : '–', net > 0 ? 'pos' : net < 0 ? 'neg' : '')}</div>
      <div class="lab-ch-sbtns">
        <button class="btn btn-sm" data-ch="mprev" title="Previous trade">${ic(IC.prev)}<span class="sr-only">Previous trade</span></button>
        <button class="btn btn-sm" data-ch="mnext" title="Next trade">${ic(IC.next)}<span class="sr-only">Next trade</span></button>
        ${hideBtn}
      </div>
    </div>
    ${list.length ? `<div class="lab-ch-tscroll"><table class="lab-table lab-ch-trades"><thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Exit</th><th>Stop loss</th><th>Take profit</th><th>Net</th><th class="l">Exit</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim small">None of your trades yet at this point of the replay.</p>'}`;
  const box = $('.lab-ch-tscroll', el);
  if (box) { const sel = $('tr.on', box); if (sel) box.scrollTop = sel.offsetTop - box.clientHeight / 2; else if (G.replay) box.scrollTop = box.scrollHeight; }
}

/* ---------- the Strategy menu: run a backtest on this chart, or open a saved one ---------- */

function stratMenu() {
  const list = ctx.strategies() || [];
  const runs = st.id ? (ctx.runs() || []).filter((r) => r.brief && r.brief.dataset === st.id).slice(0, 40) : [];
  const saved = runs.length
    ? `<div class="lab-ch-runs">${runs.map((r) => { const b = r.brief || {}; return `<button class="lab-ch-run ${st.strat && st.strat.id === r.id ? 'on' : ''}" data-ch="sload" data-id="${r.id}"><span class="lab-ch-rname">${esc(b.strategy || r.title)}</span><span class="${b.return > 0 ? 'pos' : b.return < 0 ? 'neg' : ''}">${fin(b.return) ? `${b.return >= 0 ? '+' : ''}${(b.return * 100).toFixed(1)}%` : ''}</span><span class="faint small lab-ch-rset">${b.trades ?? 0} trades · ${esc((b.settings || '').slice(0, 80))}</span></button>`; }).join('')}</div>`
    : `<p class="faint small">${st.id ? 'No saved results for this file yet.' : 'Pick a data file first.'}</p>`;
  if (!list.length) return `<div class="lab-ch-shead2">Run a strategy on this chart</div><p class="dim small"><span class="spin"></span> The Python engine is starting…</p><div class="lab-ch-shead2">Saved results for this file</div>${saved}`;
  const f = G.sform;
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
  return `<div class="lab-ch-shead2">Run a strategy on ${G.n > 1 && st.row ? esc(st.row.symbol) : 'this chart'}</div>
    <select class="input" data-ch="sname" aria-label="Strategy">${[...groups].map(([g, items]) => `<optgroup label="${esc(g)}">${items.map((s) => `<option value="${esc(s.key)}" ${s.key === cur.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('')}</select>
    <div class="lab-ch-sparams">${cur.params.map(field).join('')}</div>
    <p class="faint small">Lengths are in candles of the file (${esc(st.row ? st.row.interval || tfName(st.base) : '')}). The test uses the whole file, and the Dashboard’s costs and money: fee ${c.fee_pct}% + slippage ${c.slippage_pct}%, ${c.sizing === 'risk' ? `risk ${c.risk_pct}% a trade` : `${c.notional_pct}% of the account a trade`}, start ${c.capital} (<button class="link small" type="button" data-lab="tab" data-tab="dashboard">change them there</button>).</p>
    <label class="check small"><input type="checkbox" data-ch="ssave" ${f.save ? 'checked' : ''}><span>Save the result in the Results folder</span></label>
    <div class="lab-ch-srun"><button class="btn btn-sm btn-green" data-ch="srun" ${G.running || !st.ds ? 'disabled' : ''}>${G.running ? '<span class="spin"></span>Running…' : `${icon('play')}Run backtest`}</button><button class="btn btn-sm" data-ch="sdefaults" title="Back to the strategy's own settings">Defaults</button><span class="faint small" id="lab-ch-sprog"></span></div>
    <div class="lab-ch-shead2">Saved results for this file</div>${saved}`;
}

function readSparam(el) {
  const f = G.sform;
  const k = el.dataset.sp;
  const p = (f.params[f.strategy] = f.params[f.strategy] || {});
  if (el.type === 'checkbox') p[k] = el.checked;
  else if (el.tagName === 'SELECT') p[k] = el.value;
  else { const x = parseFloat(el.value); if (fin(x)) p[k] = el.dataset.kind === 'int' ? Math.round(x) : x; else delete p[k]; }
  save('sform', f);
}

async function runStrategy() {
  if (G.running || !st.ds) return;
  const p = st, f = G.sform;
  for (const el of $$('[data-sp]', host)) readSparam(el);
  G.running = true;
  paintBar();
  const say = (x, text) => { const el = $('#lab-ch-sprog', host); if (el) el.textContent = `${Math.round(x * 100)}% · ${text}`; };
  try {
    const { R, id } = await ctx.runBacktest({ dataset: p.id, strategy: f.strategy, params: { ...(f.params[f.strategy] || {}) }, save: f.save }, say);
    G.running = false;
    G.menu = null;
    st = p;
    if (p.ds && p.id === R.meta.dataset) setStrat(R, id); else paintBar();
    const n = (R.summary.trades || {}).n || 0;
    toast(`${R.meta.strategy_label}: ${plural(n, 'trade')}, ${(R.summary.return * 100).toFixed(1)}%${id ? ' · saved in Results' : ''}`);
  } catch (e) {
    G.running = false;
    paintBar();
    const el = $('#lab-ch-sprog', host);
    if (el) { el.textContent = e.message; el.classList.add('err'); }
    else toast(e.message, 'error');
  }
}

/* ---------- the legends ---------- */

/** The × that takes an indicator (or a strategy line) off the chart. */
const xBtn = (key, label) => `<button class="lab-ch-x" type="button" data-ch="indx" data-k="${esc(key)}" title="Remove ${esc(label)}" aria-label="Remove ${esc(label)}">${ic(IC.close)}</button>`;
const removable = (g) => IND[g.key] || g.key === 'splots' || g.key === 'equity' || g.key.startsWith('splot:');

function legend(j) {
  const el = st.el && $('.lab-ch-legend', st.el);
  if (!el || !st.B) return;
  const r = st.row;
  const head = `<div class="lab-ch-sym"><b>${esc(r.symbol)}</b> <span class="faint">· ${tfName(G.tf)} · ${esc(r.market === 'spot' ? 'Binance spot' : r.market === 'futures' ? 'Binance futures' : r.market)}</span>${G.replay ? ' <span class="lab-ch-rtag">REPLAY</span>' : ''}</div>`;
  const pl = $('.lab-ch-plegs', st.el);
  if (!st.K) {
    el.innerHTML = `${head}<div class="lab-ch-time faint">This file has no candles yet at this point of the replay.</div>`;
    if (pl) for (const box of pl.children) box.innerHTML = '';
    return;
  }
  const K = st.K;
  const last = st.shownTo;
  if (j == null || j > last || j < 0) j = last;
  const { bar, done } = barFor(j, K);
  const shown = st.ha ? (done ? { o: st.ha.O[j], h: st.ha.H[j], l: st.ha.L[j], c: st.ha.C[j] } : st.ha.tail(j, bar)) : bar;
  const prev = j > 0 ? st.B.C[j - 1] : bar.o;
  const ch = bar.c - prev, chp = prev ? (ch / prev) * 100 : 0;
  const tone = bar.c >= bar.o ? 'pos' : 'neg';
  const vals = (g) => g.feeds.map((f) => `<b style="color:${f.color}">${f.fmt(done ? f.get(j, K, null, true) : f.get(j, K, bar, false))}</b>`).join(' ');
  const name = (g) => (g.key === 'splots' ? g.feeds.map((f) => f.name).join(' · ') : g.label);
  const inds = st.groups.filter((g) => g.pane === 0).map((g) => `<span><span class="faint">${esc(name(g))}</span> ${vals(g)}${removable(g) ? xBtn(g.key, name(g)) : ''}</span>`).join('');
  let trade = '';
  if (st.strat && G.sshow.trades) {
    const now = nowT();
    const here = st.strat.trades.filter((x) => x.et <= now && (indexOfTime(x.et) === j || (x.xt <= now && indexOfTime(x.xt) === j)));
    trade = here.slice(0, 3).map((x) => {
      const ins = indexOfTime(x.et) === j, outs = x.xt <= now && indexOfTime(x.xt) === j;
      return `<span class="lab-ch-ltrade">#${x.n} ${x.side > 0 ? 'Long' : 'Short'}${ins ? ` in ${fmt(x.ep)}` : ''}${outs ? ` out ${fmt(x.xp)} <b class="${x.pnl >= 0 ? 'pos' : 'neg'}">${tradeResult(x)}</b> ${esc(x.why || '')}` : ''}</span>`;
    }).join('');
  }
  el.innerHTML = `${head}
    <div class="lab-ch-ohlc ${tone}"><span><span class="faint">O</span>${fmt(shown.o)}</span><span><span class="faint">H</span>${fmt(shown.h)}</span><span><span class="faint">L</span>${fmt(shown.l)}</span><span><span class="faint">C</span>${fmt(shown.c)}</span>
      <span>${ch >= 0 ? '+' : ''}${fmt(ch)} (${chp >= 0 ? '+' : ''}${chp.toFixed(2)}%)</span>${st.ind.vol.on ? `<span><span class="faint">Vol</span>${shortNum(bar.v)}${xBtn('vol', 'Volume')}</span>` : ''}${done ? '' : ' <span class="faint">forming</span>'}</div>
    <div class="lab-ch-time faint">${esc(when(st.B.T[j]))}</div>
    ${inds ? `<div class="lab-ch-inds">${inds}</div>` : ''}${trade ? `<div class="lab-ch-inds">${trade}</div>` : ''}`;
  if (pl) {
    for (const box of pl.children) {
      const p = Number(box.dataset.pane);
      box.innerHTML = st.groups.filter((g) => g.pane === p).map((g) => `<span class="faint">${esc(g.label)}</span> ${vals(g)}${removable(g) ? xBtn(g.key, g.label) : ''}`).join(' &nbsp; ');
    }
  }
}
function paintPaneLegends() {
  const pl = st.el && $('.lab-ch-plegs', st.el);
  if (!pl) return;
  const ps = [...new Set(st.groups.filter((g) => g.pane > 0).map((g) => g.pane))];
  pl.innerHTML = ps.map((p) => `<div class="lab-ch-legend lab-ch-plegend" data-pane="${p}"></div>`).join('');
}
/** Where pane i sits in the chart box: {top, height} in pixels (null before the chart has laid it out). */
function paneBox(i) {
  const p = st.chart && st.chart.panes()[i];
  const pe = p && p.getHTMLElement();
  if (!pe) return null;
  const r = pe.getBoundingClientRect(), top0 = st.el.getBoundingClientRect().top;
  return { top: r.top - top0, height: r.height };
}
/** Puts each pane's legend at the top of its pane (panes can be resized, so this runs again when they are). */
function placeLegends(p, tries = 0) {
  on(p, () => {
    const pl = st.el && $('.lab-ch-plegs', st.el);
    if (!pl || !st.chart) return;
    let missing = false;
    for (const box of pl.children) {
      const b = paneBox(Number(box.dataset.pane));
      if (b) box.style.top = `${Math.round(b.top + 4)}px`;
      else missing = true;
    }
    if (missing && tries < 20) p.placeTimer = setTimeout(() => placeLegends(p, tries + 1), 100);   // new panes appear after the chart's next paint
  });
}
function placeLegendsSoon(p = st) { clearTimeout(p.placeTimer); p.placeTimer = setTimeout(() => placeLegends(p), 30); }
function when(ms, short = false) {
  const d = new Date(ms);
  if (short) return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', ...(st.base < DAY ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) });
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...(G.tf < DAY ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) });
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
  if (x <= 0) return T[0] + x * G.tf;
  if (x >= n - 1) return T[n - 1] + (x - (n - 1)) * G.tf;
  const i = Math.floor(x);
  return T[i] + (x - i) * (T[i + 1] - T[i]);
}
function msToLogical(ms) {
  const n = st.B.n, T = st.B.T;
  if (ms <= T[0]) return (ms - T[0]) / G.tf;
  if (ms >= T[n - 1]) return n - 1 + (ms - T[n - 1]) / G.tf;
  const i = indexOfTime(ms);
  return i + (ms - T[i]) / Math.max(1, T[i + 1] - T[i]);
}
/** The x of logical position L. The library has no x for a place to the right of the last candle
    shown (a replay's future), so there it is counted on from that candle with the candle spacing. */
function xOf(L) {
  const ts = st.chart.timeScale(), last = st.shownTo;
  if (last < 1 || L <= last) return ts.logicalToCoordinate(L);
  const a = ts.logicalToCoordinate(last), b = ts.logicalToCoordinate(last - 1);
  return a == null || b == null ? null : a + (L - last) * (a - b);
}
/** The x of a replay cut: the line just after the last candle it shows. */
function cutX(ms) {
  const x = xOf(msToLogical(ms) - 0.5);
  return x == null ? null : Math.max(-10, Math.min(10000, x));
}

/** The replay portion and band fills (under the candles), and the trades and drawings (over them). */
class Layer {
  constructor(p) {
    this.views = [
      { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context: g, mediaSize }) => on(p, () => { paintPortion(g, mediaSize); paintFills(g); })) }) },
      { zOrder: () => 'top', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context: g, mediaSize }) => on(p, () => { paintEnd(g, mediaSize); paintTrades(g); paintDrawings(g, mediaSize); })) }) },
    ];
  }
  attached({ requestUpdate }) { this.update = requestUpdate; }
  detached() { this.update = null; }
  updateAllViews() {}
  paneViews() { return this.views; }
  redraw() { if (this.update) this.update(); }
}
const redrawAll = () => { for (const p of loaded()) if (p.layer) p.layer.redraw(); };

/** While the replay portion is picked: the part the replay hides (before the first click), then the portion. */
function paintPortion(g, size) {
  const P = G.picking;
  if (!P || !st.chart || !st.B) return;
  const xa = P.a != null ? cutX(P.a) : null;
  const ob = P.b != null ? P.b : P.h;
  const xb = ob != null ? cutX(ob) : null;
  const line = (x) => { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size.height); g.stroke(); };
  g.save();
  g.strokeStyle = 'rgba(74,222,128,0.85)';
  g.lineWidth = 1;
  g.setLineDash([5, 4]);
  if (xa == null) {
    if (xb != null) { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(xb, 0, size.width - xb, size.height); line(xb); }
  } else {
    const l = xb == null ? xa : Math.min(xa, xb), r = xb == null ? size.width : Math.max(xa, xb);
    g.fillStyle = 'rgba(34,197,94,0.13)';
    g.fillRect(l, 0, r - l, size.height);
    line(xa);
    if (xb != null) line(xb);
  }
  g.restore();
}
/** In a replay of a portion: where the portion ends. */
function paintEnd(g, size) {
  const r = G.replay;
  if (!r || r.end == null || !st.chart || !st.B) return;
  const x = cutX(r.end);
  if (x == null || x < 0 || x > size.width) return;
  g.save();
  g.strokeStyle = 'rgba(250,204,21,0.8)';
  g.lineWidth = 1;
  g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size.height); g.stroke();
  g.setLineDash([]);
  g.font = '11px ' + getComputedStyle(document.body).fontFamily;
  g.fillStyle = 'rgba(250,204,21,0.95)';
  g.fillText('End', x + 4, size.height - 8);
  g.restore();
}

function paintFills(g) {
  if (!st.fills.length || !st.chart) return;
  const ts = st.chart.timeScale(), r = ts.getVisibleLogicalRange();
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
      const x = ts.logicalToCoordinate(j), ya = fin(va) ? st.main.priceToCoordinate(va) : null, yb = fin(vb) ? st.main.priceToCoordinate(vb) : null;
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
  if (!st.chart) return;
  const s = st.strat, me = mineOf();
  if (s && G.sshow.trades) drawTrades(g, s.trades, s.sel, false);
  if (me) drawTrades(g, me.trades, me.sel, true);
}
/** One list of trades: a line from entry to exit (dashed for a backtest, solid for your own), the
    stop and target zones of the chosen or open trade, and its label. */
function drawTrades(g, list, selI, mine) {
  const ts = st.chart.timeScale(), r = ts.getVisibleLogicalRange();
  if (!r) return;
  const now = nowT(), main = st.main;
  g.save();
  for (const x of list) {
    if (x.et > now) break;
    const eb = indexOfTime(x.et);
    const isOpen = x.xt > now;
    const xb = isOpen ? st.shownTo : indexOfTime(x.xt);
    if (xb < r.from - 2 || eb > r.to + 2) continue;
    const x1 = ts.logicalToCoordinate(eb), x2 = ts.logicalToCoordinate(xb);
    const live = isOpen ? openResult(x) : null;
    const y1 = main.priceToCoordinate(x.ep), y2 = main.priceToCoordinate(isOpen ? live.p : x.xp);
    if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
    const sel = selI === x.n - 1;
    if (sel || isOpen) {
      const w = Math.max(8, x2 - x1);
      for (const [lvl, col] of [[x.stop, 'rgba(240,75,75,0.14)'], [x.tp, 'rgba(34,197,94,0.14)']]) {
        const y = fin(lvl) ? main.priceToCoordinate(lvl) : null;
        if (y == null) continue;
        g.fillStyle = col;
        g.fillRect(x1, Math.min(y1, y), w, Math.abs(y - y1));
      }
    }
    if (mine && (fin(x.stop) || fin(x.tp))) {
      const xr = Math.max(x2, x1 + 8);
      g.lineWidth = sel ? 1.6 : 1.1;
      g.setLineDash([3, 3]);
      for (const [lvl, col] of [[x.stop, 'rgba(240,75,75,0.95)'], [x.tp, 'rgba(34,197,94,0.95)']]) {
        const y = fin(lvl) ? main.priceToCoordinate(lvl) : null;
        if (y == null) continue;
        g.strokeStyle = col;
        g.beginPath(); g.moveTo(x1, y); g.lineTo(xr, y); g.stroke();
        if (sel) { g.font = '11px ' + getComputedStyle(document.body).fontFamily; g.fillStyle = col; g.fillText(`${lvl === x.stop ? 'SL' : 'TP'} ${fmt(lvl)}`, xr + 4, y + 4); }
      }
      g.setLineDash([]);
    }
    g.strokeStyle = isOpen ? 'rgba(229,231,235,0.85)' : x.pnl >= 0 ? 'rgba(34,197,94,0.95)' : 'rgba(240,75,75,0.95)';
    g.lineWidth = sel ? 2.2 : 1.2;
    g.setLineDash(mine ? [] : [5, 4]);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.setLineDash([]);
    if (sel) {
      const text = `${mine ? 'My ' : ''}#${x.n} ${x.side > 0 ? 'Long' : 'Short'} ${isOpen ? `${live.ret >= 0 ? '+' : ''}${(live.ret * 100).toFixed(2)}% open` : mine ? netText(x) : tradeResult(x)}`;
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
  const x = xOf(msToLogical(pt.t));
  const y = st.main.priceToCoordinate(pt.p);
  return x == null || y == null ? null : [x, y];
}
function paintDrawings(g, size) {
  const d0 = G.draft;
  const items = st.drawings.filter((d) => d.type !== 'hline').concat(d0 && d0.p === st && d0.b ? [d0] : []);
  g.save();
  g.font = '12px ' + getComputedStyle(document.body).fontFamily;
  for (const d of items) {
    const A1 = xy(d.a), Bp = xy(d.b);
    if (!A1 || !Bp) continue;
    const [x1, y1] = A1, [x2, y2] = Bp;
    const color = d.color || '#4ea1ff';
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 1.6;
    if (d.type === 'trend') {
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      for (const [x, y] of [A1, Bp]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    } else if (d.type === 'rect') {
      g.globalAlpha = 0.14; g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      g.globalAlpha = 1; g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (d.type === 'fib') {
      const lv = [[0, '#9ca3af'], [0.236, '#f04b4b'], [0.382, '#f59e0b'], [0.5, '#22c55e'], [0.618, '#14b8a6'], [0.786, '#38bdf8'], [1, '#9ca3af']];
      const left = Math.min(x1, x2), right = Math.max(x1, x2) + 60;
      for (const [f, c] of lv) {
        const p = d.b.p + (d.a.p - d.b.p) * f;
        const y = st.main.priceToCoordinate(p);
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
  if (!st.main) return;
  for (const pl of st.hlines) st.main.removePriceLine(pl);
  st.hlines = st.drawings.filter((d) => d.type === 'hline').map((d) => st.main.createPriceLine({ price: d.a.p, color: '#4ea1ff', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' }));
}
/** Saves this coin's drawings and redraws every chart that shows the coin. */
function saveDrawings() {
  const key = drawKey(), list = st.drawings;
  save(`draw.${key}`, list);
  for (const q of loaded()) if (drawKeyOf(q) === key) on(q, () => { st.drawings = list; paintHlines(); if (st.layer) st.layer.redraw(); });
  paintBar();
}

/* ---------- removing indicators and drawings ---------- */

/** The × in a legend: one indicator, or one of the strategy's lines, off this chart. */
function removeGroup(key) {
  if (IND[key]) { st.ind[key].on = false; st.undoAll = null; savePanes(); build(); return; }
  if (key === 'equity') { G.sshow.equity = false; save('sshow', G.sshow); }
  else if (key === 'splots') { if (st.strat && st.strat.plots) for (const p of st.strat.plots) if (p.kind === 'price') p.on = false; }
  else if (key.startsWith('splot:') && st.strat && st.strat.plots) { const p = st.strat.plots.find((x) => `splot:${x.name}` === key); if (p) p.on = false; }
  build();
}
function removeIndicators() {
  for (const x of Object.values(st.ind)) x.on = false;
  st.undoAll = null;
  savePanes();
  build();
}
/** The trash button and the Delete key: every drawing and indicator off this chart (Ctrl+Z brings them back). */
function clearAll() {
  const nd = st.drawings.length, ni = countOn();
  if (!nd && !ni) { toast('This chart has no drawings or indicators.'); return; }
  st.undoAll = { drawings: st.drawings.slice(), ind: JSON.parse(JSON.stringify(st.ind)) };
  if (G.draft && G.draft.p === st) G.draft = null;
  st.drawings = [];
  for (const x of Object.values(st.ind)) x.on = false;
  savePanes();
  saveDrawings();
  build();
  toast(`Deleted ${[nd && plural(nd, 'drawing'), ni && plural(ni, 'indicator')].filter(Boolean).join(' and ')} on ${st.row.symbol}. Ctrl+Z brings them back.`);
}
function undo() {
  if (st.undoAll) {
    const u = st.undoAll;
    st.undoAll = null;
    st.drawings = u.drawings;
    st.ind = mergeInd(u.ind);
    savePanes();
    saveDrawings();
    build();
    return;
  }
  if (!st.drawings.length) return;
  st.drawings.pop();
  saveDrawings();
}

/** The price under the pointer, pulled to a candle's open/high/low/close when it is within 10 pixels (a magnet). */
function pointAt(param) {
  if (!param.point || param.logical == null) return null;
  let p = st.main.coordinateToPrice(param.point.y);
  if (p == null) return null;
  const j = Math.round(param.logical);
  if (j >= 0 && j <= st.shownTo) {
    const d = st.main.dataByIndex(j);
    if (d && d.open != null) {
      let best = null;
      for (const v of [d.open, d.high, d.low, d.close]) {
        const y = st.main.priceToCoordinate(v);
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
function watchClicks(p) {
  const el = p.el;
  let down = null;
  // Capture phase: the library stops these events inside the chart.
  const touched = () => { p.userAt = performance.now(); };
  el.addEventListener('pointerdown', (e) => {
    down = e.button === 0 ? [e.clientX, e.clientY] : null;
    touched();
    if (p.i !== G.active) setActive(p);
  }, true);
  el.addEventListener('pointermove', (e) => { if (e.buttons) touched(); }, true);
  el.addEventListener('wheel', touched, { capture: true, passive: true });
  el.addEventListener('pointerup', (e) => {
    if (!down || !p.chart) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
    down = null;
    if (e.target.closest && e.target.closest('button, select, input, a')) return;   // a legend's ×, the file picker
    on(p, () => {
      placeLegendsSoon();                                    // the line between two panes may have been dragged
      if (moved > 5) return;                                 // a drag moves the chart
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const ts = st.chart.timeScale();
      if (x > r.width - st.chart.priceScale('right').width() || y > r.height - ts.height()) return;   // on a scale
      const p0 = paneBox(0);
      onChartClick({ point: { x, y }, logical: ts.coordinateToLogical(x), inMain: !p0 || y <= p0.top + p0.height });
    });
  }, true);
}

function onChartClick(param) {
  if (G.picking) {
    if (param.logical == null) return;
    const j = Math.max(1, Math.min(st.B.n - 2, Math.round(param.logical)));
    const cut = st.B.T[j] + G.tf;                            // the clicked candle is the last one shown
    const P = G.picking;
    if (P.a == null) { P.a = cut; P.fromStr = ''; hint('Now click the last candle of the portion, or press Start.'); redrawAll(); paintReplay(); }
    else { P.b = cut; beginPortion(); }
    return;
  }
  if (!param.inMain) return;
  if (!G.tool) {
    // A click on a trade's entry or exit candle selects that trade.
    if (param.logical == null) return;
    const j = Math.round(param.logical), now = nowT();
    const at = (x) => x.et <= now && (indexOfTime(x.et) === j || (x.xt <= now && indexOfTime(x.xt) === j));
    const s = st.strat, me = mineOf();
    const mineHit = me && me.trades.find(at);
    if (mineHit) { me.sel = mineHit.n - 1; paintMarkers(); if (st.layer) st.layer.redraw(); paintStrat(true); return; }
    const hit = s && G.sshow.trades && s.trades.find(at);
    if (hit) { s.sel = hit.n - 1; paintMarkers(); if (st.layer) st.layer.redraw(); paintStrat(true); }
    return;
  }
  const pt = pointAt(param);
  if (!pt) return;
  st.undoAll = null;
  if (G.tool === 'hline') {
    st.drawings.push({ type: 'hline', a: pt });
    saveDrawings();
    return;
  }
  if (!G.draft || G.draft.p !== st) { G.draft = { p: st, type: G.tool, a: pt, b: null }; hint('Click the second point. Esc cancels.'); return; }
  const d = G.draft;
  G.draft = null;
  if (d.type === 'measure') st.drawings = st.drawings.filter((x) => x.type !== 'measure');
  st.drawings.push({ type: d.type, a: d.a, b: pt });
  hint(toolHint());
  saveDrawings();
}

function onMove(param) {
  if (G.draft && G.draft.p === st && param.point && (param.paneIndex == null || param.paneIndex === 0)) {
    const pt = pointAt(param);
    if (pt) { G.draft.b = pt; st.layer.redraw(); }
  }
  if (G.picking && param.point && param.logical != null && param.sourceEvent) {
    const j = Math.max(1, Math.min(st.B.n - 2, Math.round(param.logical)));
    G.picking.h = st.B.T[j] + G.tf;
    redrawAll();
  }
  const j = param.time != null ? indexOfTime(unsec(param.time)) : param.logical != null && param.point ? Math.round(param.logical) : null;
  legend(param.point ? j : null);
  if (!syncing && G.sync && G.n > 1 && (param.sourceEvent || !param.point)) shareCrosshair(param);
}
/** With Sync on: the other charts show the crosshair at the same time. */
function shareCrosshair(param) {
  const ms = !param.point ? null : param.time != null ? unsec(param.time) : param.logical != null ? logicalToMs(param.logical) : null;
  const src = st;
  syncing = true;
  try {
    for (const q of loaded()) {
      if (q === src || !q.chart) continue;
      on(q, () => {
        const j = ms == null || !st.K || ms < st.B.T[0] ? -1 : indexOfTime(ms);
        if (j < 0 || j > st.shownTo) { st.chart.clearCrosshairPosition(); legend(null); return; }
        const d = st.main.dataByIndex(j);
        st.chart.setCrosshairPosition(d ? (d.close ?? d.value) : st.B.C[j], sec(st.B.T[j]), st.main);
        legend(j);
      });
    }
  } finally { syncing = false; }
}
/** With Sync on: scrolling or zooming one chart shows the same times on the others. Only the user's
    scrolling counts (a chart that changes size or is set by MEDUSA moves alone). */
function onRange(range) {
  if (syncing || !G.sync || G.n < 2 || !range || !st.B || performance.now() - st.userAt > 1200) return;
  shareRange(range);
}
function shareRange(range) {
  const a = logicalToMs(range.from), b = logicalToMs(range.to), src = st;
  syncing = true;
  try {
    for (const q of loaded()) {
      if (q === src || !q.chart) continue;
      on(q, () => {
        const want = { from: msToLogical(a), to: msToLogical(b) }, cur = st.chart.timeScale().getVisibleLogicalRange();
        if (!cur || Math.abs(cur.from - want.from) > 0.01 || Math.abs(cur.to - want.to) > 0.01) setRange(want, false);   // no echo back and forth
      });
    }
  } finally { syncing = false; }
}

const toolHint = () => (G.tool ? `${TOOLS.find(([t]) => t === G.tool)[1]}: ${G.tool === 'hline' ? 'click a price.' : 'click the first point.'} Esc stops.` : '');
function hint(text) {
  for (const p of live()) {
    const el = p.el && $('.lab-ch-hint', p.el);
    if (!el) continue;
    el.textContent = text;
    el.hidden = !text || !p.B;
  }
}
function setTool(t) {
  G.tool = G.tool === t ? null : t;
  G.draft = null;
  if (G.tool && G.picking && !G.replay) { G.picking = null; paintReplay(); }
  hint(toolHint());
  redrawAll();
  paintBar();
}

/* ======================= replay ======================= */

/** File candles of chart p that had closed by time `cut`. */
function kAt(p, cut) {
  const t = p.ds.cols.t, lim = cut - p.base;
  let a = 0, b = p.ds.n;
  while (a < b) { const m = (a + b) >> 1; if (t[m] <= lim) a = m + 1; else b = m; }
  return a;
}
function startPicking() {
  G.picking = { a: null, b: null, h: null, fromStr: '', toStr: '' };
  G.tool = null;
  G.draft = null;
  hint('Click the candle where the replay should start.');
  redrawAll();
  paintBar();
  paintReplay();
}
/** Starts the replay of the picked portion (the clicks or dates; the order doesn't matter). */
function beginPortion() {
  const P = G.picking;
  if (!P || P.a == null) { toast('Click the candle where the replay should start, or pick a From date.'); return; }
  let a = P.a, b = P.b;
  if (b != null && b < a) [a, b] = [b, a];
  if (b === a) b = null;
  startReplay(a, b);
}
/** Shows every chart as it was at time `cut` (the candles that had closed by then); the replay stops at `end`. */
function startReplay(cut, end = null) {
  const ps = loaded();
  if (!ps.length) return;
  const ks = ps.map((p) => kAt(p, cut));
  if (ks.every((k, q) => k >= ps[q].ds.n)) { toast('That is after the last candle. Pick an earlier start.'); return; }
  if (ks.every((k) => k < 1)) { toast('That is before the first candle. Pick a later start.'); return; }
  const old = G.replay;
  if (old) cancelAnimationFrame(old.timer);
  G.picking = null;
  G.replay = { cut, start: cut, end, playing: false, timer: null, speed: old ? old.speed : load('speed', 2), by: old ? old.by : load('by', 'bar') };
  hint('');
  each(() => {
    st.pos = null;
    st.ptrades = [];
    if (st.strat) st.strat.sel = -1;
    setAll(kAt(st, cut));
    paintMarkers();
    focusReplay();
    legend(null);
    if (st.layer) st.layer.redraw();
  }, ps);
  paintBar();
  paintReplay();
  paintStrat(true);
}
function focusReplay() {
  const j = st.K ? lastBar(st.K) : Math.round(msToLogical(G.replay.cut));
  setRange({ from: j - 140, to: j + 40 }, false);
}
function stopReplay() {
  const r = G.replay;
  G.picking = null;
  if (r) {
    cancelAnimationFrame(r.timer);
    G.replay = null;
    each(() => {
      st.pos = null;
      setAll(st.ds.n);
      paintMarkers();
      legend(null);
      st.chart.timeScale().scrollToRealTime();
    });
  }
  hint(G.tool ? toolHint() : '');
  redrawAll();
  paintBar();
  paintReplay();
  paintStrat(true);
}
/** The next moment a chart has something new: its forming or next candle done (or its next file candle). */
function nextCut() {
  const k = st.K;
  if (k >= st.ds.n) return Infinity;
  if (G.replay.by === 'file' || G.tf === st.base) return st.ds.cols.t[k] + st.base;
  const j = k ? lastBar(k) : -1;
  return st.B.T[k && k < st.B.first[j + 1] ? j : j + 1] + G.tf;
}
/** Back: without the chart's last candle (finished or forming), or its last file candle. */
function prevCut() {
  const k = st.K;
  if (k < 2) return -Infinity;
  if (G.replay.by === 'file' || G.tf === st.base) return st.ds.cols.t[k - 2] + st.base;
  return st.B.T[lastBar(k)];
}
/** One step of every chart: forward to the soonest next candle of any of them, or back by one. */
function step(dir = 1) {
  const r = G.replay;
  if (!r) return;
  const ps = loaded();
  if (!ps.length) return;
  let cut;
  if (dir > 0) {
    if (r.end != null && r.cut >= r.end) { pause(); toast('The replay reached the end of the portion you picked.'); return; }
    cut = Math.min(...ps.map((p) => on(p, nextCut)));
    if (!fin(cut)) { pause(); toast('The replay reached the end of the data.'); return; }
    if (r.end != null) cut = Math.min(cut, r.end);
  } else {
    cut = Math.max(...ps.map((p) => on(p, prevCut)));
    if (!fin(cut) || ps.every((p) => kAt(p, cut) < 2)) return;
  }
  r.cut = cut;
  for (const p of ps) on(p, () => { const k = kAt(st, cut); if (k !== st.K) { moveTo(k); p.dirty = true; } });   // a chart with nothing new isn't touched
  uiSoon();
}
/** Keeps a replay's newest candle on screen (several steps in one frame can run past the right edge). */
function follow() {
  const r = st.chart && st.chart.timeScale().getVisibleLogicalRange();
  if (!r || st.shownTo < 0) return;
  const d = st.shownTo > r.to - 3 ? st.shownTo - (r.to - 12) : st.shownTo < r.from + 3 ? st.shownTo - (r.from + 30) : 0;
  if (d) setRange({ from: r.from + d, to: r.to + d }, false);
}
/* The legends, markers and panels follow the replay once per screen frame, however many steps that
   frame had (several charts, fast speeds, a held arrow key). */
let uiFrame = 0;
function uiSoon() { if (!uiFrame) uiFrame = requestAnimationFrame(flushUi); }
function flushUi() {
  if (uiFrame) { cancelAnimationFrame(uiFrame); uiFrame = 0; }
  for (const p of loaded()) {
    if (!p.dirty) continue;
    p.dirty = false;
    on(p, () => { follow(); paintMarkers(); if (st.layer) st.layer.redraw(); legend(null); });
  }
  paintReplayInfo();
  paintStrat();
}
function play() {
  const r = G.replay;
  if (!r || r.playing) return;
  if ((r.end != null && r.cut >= r.end) || loaded().every((p) => p.K >= p.ds.n)) { toast('The replay is at the end. Pick an earlier start.'); return; }
  r.playing = true;
  // In step with the screen: each frame takes the steps that are due at this speed (a slow frame skips
  // ahead in time instead of queueing steps), then paints once.
  const t0 = performance.now();
  let done = 0;
  const tick = (now) => {
    if (G.replay !== r || !r.playing) return;
    if (!host || host.closest('[hidden]') || document.hidden) { pause(); return; }
    const due = Math.floor(((now - t0) / 1000) * r.speed) - done;
    const n = Math.min(due, 4);
    for (let i = 0; i < n && r.playing; i++) step(1);
    done += Math.max(0, due);
    if (n) flushUi();
    if (r.playing) r.timer = requestAnimationFrame(tick);
  };
  r.timer = requestAnimationFrame(tick);
  paintReplay();
}
function pause() {
  const r = G.replay;
  if (!r) return;
  const was = r.playing;
  r.playing = false;
  cancelAnimationFrame(r.timer);
  if (was) paintReplay();                                    // the Play button shows Play again
}
const nowPrice = () => st.ds.cols.c[st.K - 1];
const nowMs = () => st.ds.cols.t[st.K - 1];
/** Practice trades in a replay, on the active chart: buy or sell at the last price shown, then close. Prices only, no fees. */
function trade(side) {
  if (!G.replay || !st.B) return;
  if (!st.K) { toast('This chart has no candles yet at this point of the replay.'); return; }
  if (st.pos && st.pos.side !== side) closePos();
  else if (st.pos) return;
  st.pos = { side, entry: nowPrice(), t: nowMs() };
  paintMarkers();
  paintReplay();
}
function closePos() {
  if (!G.replay || !st.pos) return;
  const p = nowPrice();
  st.ptrades.push({ ...st.pos, exit: p, xt: nowMs(), ret: ((p - st.pos.entry) / st.pos.entry) * (st.pos.side === 'long' ? 1 : -1) * 100 });
  st.pos = null;
  paintMarkers();
  paintReplay();
}

/** The replay bar: picking the portion, or the replay's controls (practice trades are on the active chart). */
function paintReplay() { if (host) on(A(), paintReplayNow); }
function paintReplayNow() {
  const el = $('#lab-ch-replay', host);
  if (!el) return;
  const r = G.replay, P = G.picking;
  el.hidden = !r && !P;
  if (P && !r) {
    el.innerHTML = `<span class="dim small lab-ch-rtext">${P.a == null ? '<b>Pick the replay portion:</b> click the candle where it starts, then the one where it ends (or use the dates).' : `<b>Starts after ${esc(when(P.a - G.tf))}.</b> Click the last candle of the portion, or press Start to replay to the end.`}</span>
      <label class="lab-ch-rdate"><span class="faint small">From</span><input class="input lab-ch-date" type="date" data-ch="rfrom" value="${esc(P.fromStr)}" aria-label="Replay from"></label>
      <label class="lab-ch-rdate"><span class="faint small">To</span><input class="input lab-ch-date" type="date" data-ch="rto" value="${esc(P.toStr)}" aria-label="Replay to (optional)"></label>
      <button class="btn btn-sm btn-green" data-ch="rgo" title="Start the replay (Enter)" ${P.a == null ? 'disabled' : ''}>${icon('play')}Start</button>
      <button class="btn btn-sm" data-ch="rexit">${ic(IC.close)}Cancel</button>`;
    return;
  }
  if (!r) { el.innerHTML = ''; return; }
  const ps = loaded();
  const minBase = ps.length ? Math.min(...ps.map((p) => p.base)) : G.tf;
  const sub = ps.some((p) => G.tf > p.base);
  el.innerHTML = `
    <span class="lab-ch-rgroup">
      <button class="btn btn-sm" data-ch="rback" title="Step back (←)" aria-label="Step back">${ic(IC.prev)}</button>
      <button class="btn btn-sm btn-green" data-ch="rplay" title="${r.playing ? 'Pause' : 'Play'} (Space)" aria-label="${r.playing ? 'Pause' : 'Play'}">${r.playing ? ic(IC.pause) : icon('play')}</button>
      <button class="btn btn-sm" data-ch="rstep" title="Step forward (→)" aria-label="Step forward">${ic(IC.next)}</button>
      <select class="input lab-ch-speed" data-ch="speed" aria-label="Speed" title="Candles per second">${SPEEDS.map((s) => `<option value="${s}" ${s === r.speed ? 'selected' : ''}>${s}×/s</option>`).join('')}</select>
      ${sub ? `<select class="input lab-ch-by" data-ch="by" aria-label="Step size" title="Step a whole chart candle, or build each candle from the file's own ${tfName(minBase)} candles"><option value="bar" ${r.by === 'bar' ? 'selected' : ''}>Step: ${tfName(G.tf)} candle</option><option value="file" ${r.by === 'file' ? 'selected' : ''}>Step: ${tfName(minBase)} (build candles)</option></select>` : ''}
      <button class="btn btn-sm" data-ch="rpick" title="Pick a new portion to replay">${ic(IC.replay)}New portion</button>
    </span>
    <span class="lab-ch-rgroup lab-ch-trade">
      <button class="btn btn-sm lab-ch-buy" data-ch="buy" ${st.pos && st.pos.side === 'long' ? 'disabled' : ''}>Buy</button>
      <button class="btn btn-sm lab-ch-sell" data-ch="sell" ${st.pos && st.pos.side === 'short' ? 'disabled' : ''}>Sell</button>
      <button class="btn btn-sm" data-ch="flat" ${st.pos ? '' : 'disabled'}>Close</button>
      <span class="small" id="lab-ch-rinfo"></span>
    </span>
    <button class="btn btn-sm" data-ch="rexit" title="Leave the replay and show every candle">${ic(IC.close)}Exit replay</button>`;
  paintReplayInfo();
}
function paintReplayInfo() {
  on(A(), () => {
    const el = $('#lab-ch-rinfo', host);
    const r = G.replay;
    if (!el || !r) return;
    const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
    let pos = '';
    if (st.pos && st.K) {
      const p = nowPrice();
      const open = ((p - st.pos.entry) / st.pos.entry) * (st.pos.side === 'long' ? 1 : -1) * 100;
      pos = `<b class="${open >= 0 ? 'pos' : 'neg'}">${st.pos.side === 'long' ? 'Long' : 'Short'} ${sign(open)}</b> · `;
    }
    const total = st.ptrades.reduce((s, x) => s + x.ret, 0);
    const wins = st.ptrades.filter((x) => x.ret > 0).length;
    const done = st.ptrades.length ? `${plural(st.ptrades.length, 'trade')}, ${wins} won, <b class="${total >= 0 ? 'pos' : 'neg'}">${sign(total)}</b> <span class="faint">(no fees)</span> · ` : '';
    const prog = r.end != null ? ` <span class="faint">· ${Math.round(Math.max(0, Math.min(1, (r.cut - r.start) / Math.max(1, r.end - r.start))) * 100)}% of the portion, to ${esc(when(r.end - G.tf))}</span>` : '';
    el.innerHTML = `${G.n > 1 && st.row ? `<span class="faint">${esc(st.row.symbol)}:</span> ` : ''}${pos}${done}<span class="faint">${esc(when(st.B && st.K ? nowMs() : r.cut))}</span>${prog}`;
  });
}

/* ======================= events ======================= */

/** The chart an event is about: the one it happened in, else the active one (the toolbar, the panels). */
const paneOf = (target) => { const pe = target.closest && target.closest('.lab-ch-main'); return pe ? panes[Number(pe.dataset.pi)] : A(); };

function onClick(ev) {
  const el = ev.target.closest('[data-ch]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.disabled) return;
  on(paneOf(el), () => click(el));
}
function click(el) {
  const a = el.dataset.ch;
  switch (a) {
    case 'layout': setLayout(Number(el.dataset.n)); return;
    case 'sync': {
      G.sync = !G.sync;
      saveLayout();
      paintBar();
      const r = G.sync && st.chart && st.chart.timeScale().getVisibleLogicalRange();
      if (r) shareRange(r);
      return;
    }
    case 'type': st.type = el.dataset.type; savePanes(); build(); return;
    case 'srun': runStrategy(); return;
    case 'sdefaults': delete G.sform.params[G.sform.strategy]; save('sform', G.sform); paintBar(); return;
    case 'sload': {
      const p = st, id = el.dataset.id;
      el.disabled = true;
      ctx.fetchResult(id).then((R) => { G.menu = null; on(p, () => showResultHere(R, id)); }).catch((e) => { el.disabled = false; toast(e.message, 'error'); });
      return;
    }
    case 'png': savePng(); return;
    case 'mine': setMine(!G.mine); return;
    case 'full': setFull(!isFull()); return;
    case 'replay': if (G.replay || G.picking) stopReplay(); else if (loaded().length) startPicking(); return;
    case 'rpick': stopReplay(); startPicking(); return;
    case 'rgo': beginPortion(); return;
    case 'rexit': stopReplay(); return;
    case 'rplay': if (G.replay.playing) pause(); else play(); return;
    case 'rstep': pause(); step(1); return;
    case 'rback': pause(); step(-1); return;
    default: break;
  }
  if (!st.B) return;
  switch (a) {
    case 'tool': setTool(el.dataset.tool); break;
    case 'undo': undo(); break;
    case 'clear': clearAll(); break;
    case 'indx': removeGroup(el.dataset.k); break;
    case 'indoff': removeIndicators(); break;
    case 'log': st.log = !st.log; savePanes(); st.chart.priceScale('right').applyOptions({ mode: st.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }); paintBar(); break;
    case 'fit': setRange({ from: -2, to: Math.max(st.shownTo, 0) + 12 }); break;
    case 'buy': trade('long'); break;
    case 'sell': trade('short'); break;
    case 'flat': closePos(); break;
    case 'strade': { const i = Number(el.dataset.n); if (st.strat && st.strat.sel === i) { st.strat.sel = -1; paintMarkers(); if (st.layer) st.layer.redraw(); paintStrat(true); } else focusTrade(i); break; }
    case 'sprev': stepTrade(-1); break;
    case 'snext': stepTrade(1); break;
    case 'sreport': if (st.strat) ctx.openReport(st.strat.R, st.strat.id); break;
    case 'sremove': removeStrat(); break;
    case 'mtrade': { const me = mineOf(), i = Number(el.dataset.n); if (me && me.sel === i) { me.sel = -1; paintMarkers(); if (st.layer) st.layer.redraw(); paintStrat(true); } else focusMine(i); break; }
    case 'mprev': stepMine(-1); break;
    case 'mnext': stepMine(1); break;
    case 'sedit': G.menu = 'strat'; paintBar(); $('#lab-ch-smenu', host).scrollIntoView({ block: 'nearest' }); break;
    default: break;
  }
}

function onChange(ev) { on(paneOf(ev.target), () => change(ev.target)); }
function change(t) {
  const P = G.picking;
  if (t.dataset.ch === 'file') { if (t.value) openFile(t.value); else closeFile(); return; }
  if (t.dataset.ch === 'sname') { G.sform.strategy = t.value; save('sform', G.sform); paintBar(); return; }
  if (t.dataset.ch === 'ssave') { G.sform.save = t.checked; save('sform', G.sform); return; }
  if (t.dataset.sp) { readSparam(t); return; }
  if (t.dataset.sshow) { G.sshow[t.dataset.sshow] = t.checked; save('sshow', G.sshow); build(); return; }
  if (t.dataset.splot && st.strat && st.strat.plots) { st.strat.plots[Number(t.dataset.splot)].on = t.checked; build(); return; }
  if (t.dataset.ch === 'tf') { setTf(Number(t.value)); return; }
  if (t.dataset.ch === 'goto' && t.value && st.B) {
    const j = indexOfTime(new Date(`${t.value}T00:00:00`).getTime());
    setRange({ from: j - 80, to: j + 80 });
    return;
  }
  if (t.dataset.ch === 'rfrom' && P) {
    P.fromStr = t.value;
    P.a = t.value ? bucketStart(new Date(`${t.value}T00:00:00`).getTime()) : null;   // the candles before that date are shown
    hint(P.a == null ? 'Click the candle where the replay should start.' : 'Now click the last candle of the portion, or press Start.');
    redrawAll();
    paintReplay();
    return;
  }
  if (t.dataset.ch === 'rto' && P) {
    P.toStr = t.value;
    P.b = t.value ? bucketStart(new Date(`${t.value}T00:00:00`).getTime() + DAY - 1) + G.tf : null;   // to the end of that day
    redrawAll();
    paintReplay();
    return;
  }
  if (t.dataset.ch === 'speed' && G.replay) { G.replay.speed = Number(t.value); save('speed', G.replay.speed); if (G.replay.playing) { pause(); play(); } return; }
  if (t.dataset.ch === 'by' && G.replay) { G.replay.by = t.value; save('by', t.value); return; }
  if (t.dataset.ind) { st.ind[t.dataset.ind].on = t.checked; st.undoAll = null; savePanes(); build(); return; }
  if (t.dataset.indP) {
    const k = t.dataset.indP, pk = t.dataset.p;
    const spec = IND[k].params.find(([x]) => x === pk);
    const v = Number(t.value);
    if (!fin(v) || v < spec[3] || v > spec[4] || (spec[5] >= 1 && !Number.isInteger(v))) { t.value = st.ind[k][pk]; toast(`${spec[1]}: ${spec[3]} to ${spec[4]}.`); return; }
    st.ind[k][pk] = v;
    st.ind[k].on = true;
    st.undoAll = null;
    savePanes();
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
    G.menu = d.dataset.menu;
    fitPop(d);
    for (const o of $$('details.lab-ch-menu[open]', host)) if (o !== d) o.open = false;
  } else if (G.menu === d.dataset.menu) G.menu = null;
}
/** A click anywhere outside an open menu closes it (pointerdown, captured: the chart stops clicks). */
function closeMenusOutside(ev) {
  if (!host) return;
  for (const d of $$('details.lab-ch-menu[open]', host)) {
    if (!d.contains(ev.target)) { d.open = false; if (G.menu === d.dataset.menu) G.menu = null; }
  }
}

function onKey(ev) {
  if (!host || host.closest('[hidden]')) return;
  if (ev.key === 'Escape') {
    const open = $$('details.lab-ch-menu[open]', host);
    if (open.length) { for (const d of open) d.open = false; G.menu = null; return; }
  }
  if (!loaded().length) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  on(A(), () => key(ev));
}
function key(ev) {
  if (ev.key === 'Escape') {
    if (isFull() && !fsElement() && !G.draft && !G.tool && !G.picking) { setFull(false); return; }
    if (G.draft || G.tool) { G.draft = null; G.tool = null; hint(''); redrawAll(); paintBar(); }
    else if (G.picking && !G.replay) stopReplay();
    return;
  }
  if (ev.key === 'Enter' && G.picking && G.picking.a != null) { ev.preventDefault(); beginPortion(); return; }
  if (ev.key === 'Delete' && st.B) { ev.preventDefault(); clearAll(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && st.B && (st.undoAll || st.drawings.length)) { ev.preventDefault(); undo(); return; }
  if (!G.replay) return;
  if (ev.key === ' ') { ev.preventDefault(); if (G.replay.playing) pause(); else play(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); pause(); step(1); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); pause(); step(-1); }
}

/* ---------- full screen ---------- */

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const isFull = () => Boolean(host && $('.lab-ch.full', host));
/** Full screen: the browser's own where it has one (computers, Android, iPad); on an iPhone, which has
    none for a page, the charts fill the window instead. Either way Esc or the button leaves it. */
function setFull(on) {
  const c = host && $('.lab-ch', host);
  if (!c || on === c.classList.contains('full')) return;
  c.classList.toggle('full', on);
  document.documentElement.classList.toggle('lab-ch-locked', on);   // the page under it doesn't scroll
  if (on) {
    const req = c.requestFullscreen || c.webkitRequestFullscreen;
    if (req) { try { Promise.resolve(req.call(c, { navigationUI: 'hide' })).catch(() => {}); } catch { /* the window-filling view stays */ } }
  } else if (fsElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
  }
  paintBar();
  for (const p of loaded()) placeLegendsSoon(p);
}

/** The chart (every pane) as a PNG picture; with several charts, all of them as laid out on the screen. */
function savePng() {
  const ps = loaded();
  if (!ps.length) return;
  const name = `${ps.map((p) => p.row.symbol).join('-')}-${tfName(G.tf)}-${ymd(Date.now())}.png`;
  const done = (c) => c.toBlob((blob) => { if (blob) download(name, blob); }, 'image/png');
  if (ps.length === 1) { done(ps[0].chart.takeScreenshot()); return; }
  const box = $('#lab-ch-stage', host).getBoundingClientRect();
  const shots = ps.map((p) => ({ c: p.chart.takeScreenshot(), r: p.el.getBoundingClientRect() }));
  const s = Math.max(...shots.map((x) => x.c.width / Math.max(1, x.r.width)));
  const out = document.createElement('canvas');
  out.width = Math.round(box.width * s);
  out.height = Math.round(box.height * s);
  const g = out.getContext('2d');
  g.fillStyle = '#111';
  g.fillRect(0, 0, out.width, out.height);
  for (const x of shots) g.drawImage(x.c, (x.r.left - box.left) * s, (x.r.top - box.top) * s, x.r.width * s, x.r.height * s);
  done(out);
}
