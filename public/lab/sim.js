// MEDUSA Lab: the Chart tab's trading simulation. An account with a starting amount trades orders on a
// file's candles, one candle at a time, the way an exchange fills them: a market order at the close of the
// candle it is placed in, a limit or stop entry when a later candle reaches its price, then the stop loss,
// take profit, trailing stop and liquidation price. Fees and slippage are paid on every fill. Nothing here
// touches the page: chart.js turns position drawings and the order ticket into orders and draws the result.
//
// Inside a candle the order of its high and low isn't known, so the worse case is taken: a candle that
// reaches both the stop and the take profit counts as the stop, and in the candle where a trade starts only
// a close beyond the take profit counts as reaching it (its high could have come before the fill).
//
// An order: {id, n, seq, src ('draw' or 'ticket'), side (1 long, -1 short), kind ('market', 'limit' or 'stop'),
//   price (limit and stop orders), sl and tp (prices, NaN for none), trail (a fraction, 0 for none),
//   k0 (the file candle it is placed in), kEnd (the last file candle it lives through, or Infinity),
//   size: {mode: 'risk' (% of the account lost at the stop), 'pct' (% of the account as margin) or 'usdt', value}}.
// An action: {type: 'close' or 'cancel', id, seq, k}, at the close of file candle k. Orders and actions in
// the same candle happen in the order of their seq (the order you did them in).
// The account: {capital, fee and slip (fractions of the value, per fill), lev (leverage), liq (false: none)}.

const fin = Number.isFinite;
/** Maintenance margin, as a fraction of a position's value (Binance's lowest tier): sets the liquidation price. */
export const MMR = 0.005;

/** The price a waiting entry fills at in a candle (its open, high and low), or null. A stop fills worse by the slippage. */
function entryFill(od, O, H, L, slip) {
  const P = od.price, s = od.side;
  if (od.kind === 'limit') {
    if (s > 0) return O <= P ? O : L <= P ? P : null;          // buy limit: when the price comes down to it
    return O >= P ? O : H >= P ? P : null;                      // sell limit: when it comes up to it
  }
  if (s > 0) return O >= P ? O * (1 + slip) : H >= P ? P * (1 + slip) : null;   // buy stop: when the price rises to it
  return O <= P ? O * (1 - slip) : L <= P ? P * (1 - slip) : null;               // sell stop: when it falls to it
}

export class Sim {
  /** cols: the file's candles {t, o, h, l, c}. The orders and actions are copied and sorted by time. */
  constructor(cols, orders, actions, cfg) {
    this.c = cols;
    this.cfg = cfg;
    this.orders = orders.slice().sort((a, b) => a.k0 - b.k0 || a.seq - b.seq);
    this.actions = actions.slice().sort((a, b) => a.k - b.k || a.seq - b.seq);
    this.oi = 0;
    this.ai = 0;
    this.k = this.orders.length ? this.orders[0].k0 : Infinity;   // the next candle to look at
    this.K = 0;                                                      // candles looked at: 0 to K-1
    this.balance = cfg.capital;                                      // the start, plus closed results, minus fees
    this.fees = 0;
    this.pending = [];                                               // entries waiting for their price
    this.open = [];                                                  // open trades
    this.trades = [];                                                // closed trades, in the order they closed
    this.events = [];                                                // every trigger, in time order
    this.peak = cfg.capital;
    this.maxDD = 0;
  }

  /** Looks at the candles up to (not including) K: the whole file, or a replay's "now". Only goes forward. */
  advance(K) {
    const n = Math.min(K, this.c.t.length);
    while (this.k < n) {
      if (!this.pending.length && !this.open.length) {             // nothing running: on to the next order
        const next = this.oi < this.orders.length ? this.orders[this.oi].k0 : Infinity;
        if (next >= n) { this.k = n; break; }
        if (next > this.k) this.k = next;
      }
      this.candle(this.k++);
    }
    if (n > this.K) this.K = n;
    return this;
  }

  candle(k) {
    const { o, h, l, c } = this.c, slip = this.cfg.slip;
    const O = o[k], H = h[k], L = l[k], C = c[k];
    // 1. waiting entries this candle reaches
    if (this.pending.length) {
      const wait = [];
      for (const od of this.pending) {
        const px = entryFill(od, O, H, L, slip);
        if (px == null) wait.push(od);
        else this.fill(od, k, px);
      }
      this.pending = wait;
    }
    // 2. the stops and targets of the open trades (and of the ones that just started)
    for (const p of this.open.slice()) this.exits(p, k, O, H, L, C);
    // 3. a drawing's box ends: its trade is closed at the close, an entry still waiting is cancelled
    for (const p of this.open.slice()) if (p.o.kEnd <= k) this.exit(p, k, C * (1 - p.side * slip), 'end');
    if (this.pending.length) this.pending = this.pending.filter((od) => (od.kEnd > k ? true : (this.event(k, od, 'expired', NaN), false)));
    // 4. at the close: what you did and the orders placed in this candle, in the order you did them
    this.atClose(k, C);
    // 5. the account value at the close, for the worst drawdown
    let u = 0;
    for (const p of this.open) u += (C - p.px) * p.qty * p.side;
    const eq = this.balance + u;
    if (eq > this.peak) this.peak = eq;
    else if (this.peak > 0 && (this.peak - eq) / this.peak > this.maxDD) this.maxDD = (this.peak - eq) / this.peak;
  }

  atClose(k, C) {
    const now = [];
    while (this.oi < this.orders.length && this.orders[this.oi].k0 <= k) { const od = this.orders[this.oi++]; if (od.k0 === k) now.push([od.seq, od, null]); }
    while (this.ai < this.actions.length && this.actions[this.ai].k < k) this.ai++;
    while (this.ai < this.actions.length && this.actions[this.ai].k === k) { const a = this.actions[this.ai++]; now.push([a.seq, null, a]); }
    if (now.length > 1) now.sort((a, b) => a[0] - b[0]);
    for (const [, od, a] of now) {
      if (od) this.place(od, k, C);
      else this.act(a, k, C);
    }
  }

  place(od, k, C) {
    this.event(k, od, 'placed', od.kind === 'market' ? C : od.price);
    if (od.kind === 'market') this.fill(od, k, C * (1 + od.side * this.cfg.slip));
    else if (od.kEnd <= k) this.event(k, od, 'expired', NaN);
    else this.pending.push(od);
  }

  act(a, k, C) {
    if (a.type === 'close') {
      const p = this.open.find((x) => x.id === a.id);
      if (p) this.exit(p, k, C * (1 - p.side * this.cfg.slip), 'close');
      return;
    }
    const i = this.pending.findIndex((x) => x.id === a.id);
    if (i >= 0) { this.event(k, this.pending[i], 'cancel', NaN); this.pending.splice(i, 1); }
  }

  /** Opens a trade for order od at price px in candle k, sized from the account (cut down to the free money). */
  fill(od, k, px) {
    const cfg = this.cfg, s = od.side, v = od.size.value;
    let used = 0;
    for (const p of this.open) used += p.margin;
    const room = (this.balance - used) / (1 + cfg.fee * cfg.lev);   // free money, keeping enough for the entry fee
    let qty;
    if (od.size.mode === 'risk') {
      const d = Math.abs(px - od.sl);
      if (!(d > 0)) return this.reject(k, od, px, 'a size by risk needs a stop loss');
      qty = (this.balance * v) / 100 / d;
    } else qty = ((od.size.mode === 'usdt' ? v : (this.balance * v) / 100) * cfg.lev) / px;
    let capped = false;
    if ((qty * px) / cfg.lev > room) { qty = (room * cfg.lev) / px; capped = true; }
    if (!(room > 0) || !(qty > 0)) return this.reject(k, od, px, 'no free money in the account');
    const fee = qty * px * cfg.fee;
    this.balance -= fee;
    this.fees += fee;
    const p = {
      o: od, id: od.id, n: od.n, side: s, k, px, qty, margin: (qty * px) / cfg.lev, fee, sl: od.sl, tp: od.tp, trail: od.trail || 0,
      // a long without leverage can't be liquidated (its margin is its whole value)
      best: px, tstop: NaN, liq: cfg.liq === false || (s > 0 && cfg.lev <= 1) ? NaN : px * (1 - s / cfg.lev + s * MMR), capped,
    };
    if (p.trail > 0) p.tstop = px * (1 - s * p.trail);
    this.open.push(p);
    this.event(k, od, 'filled', px, capped ? 'size cut to the free money' : '');
    return p;
  }

  reject(k, od, px, why) { this.event(k, od, 'rejected', px, why); return null; }

  /** The stop loss, trailing stop, liquidation and take profit of trade p in candle k. */
  exits(p, k, O, H, L, C) {
    const s = p.side, slip = this.cfg.slip, tp = p.tp;
    let stop = NaN, why = '';
    for (const [lvl, w] of [[p.sl, 'sl'], [p.tstop, 'trail'], [p.liq, 'liq']]) if (fin(lvl) && (!fin(stop) || (lvl - stop) * s > 0)) { stop = lvl; why = w; }
    // a stop fills worse by the slippage, never past the liquidation price (the most an isolated position can lose)
    const out = (x, w) => {
      if (w !== 'liq') x *= 1 - s * slip;
      if (fin(p.liq) && (p.liq - x) * s > 0) { x = p.liq; w = 'liq'; }
      return this.exit(p, k, x, w);
    };
    if (p.k === k) {                                              // the trade started in this candle
      if (fin(stop) && (stop - p.px) * s >= 0) return out(why === 'liq' ? stop : p.px, why);   // it filled past its stop
      if (fin(tp) && (p.px - tp) * s >= 0) return this.exit(p, k, p.px, 'tp');                   // or past its target
      if (fin(stop) && (s > 0 ? L <= stop : H >= stop)) return out(stop, why);
      if (fin(tp) && (s > 0 ? C >= tp : C <= tp)) return this.exit(p, k, tp, 'tp');
    } else {
      if (fin(stop) && (s > 0 ? O <= stop : O >= stop)) return out(why === 'liq' ? stop : O, why);   // opened past the stop
      if (fin(tp) && (s > 0 ? O >= tp : O <= tp)) return this.exit(p, k, O, 'tp');                    // opened past the target
      if (fin(stop) && (s > 0 ? L <= stop : H >= stop)) return out(stop, why);
      if (fin(tp) && (s > 0 ? H >= tp : L <= tp)) return this.exit(p, k, tp, 'tp');
    }
    if (p.trail > 0) {                                            // the trailing stop follows the best price so far
      const x = p.k === k ? C : s > 0 ? H : L;
      if ((x - p.best) * s > 0) { p.best = x; p.tstop = x * (1 - s * p.trail); }
    }
    return null;
  }

  exit(p, k, price, why) {
    const gross = (price - p.px) * p.qty * p.side;
    const fee = p.qty * price * this.cfg.fee;
    this.balance += gross - fee;
    this.fees += fee;
    const net = gross - fee - p.fee;
    const risk = fin(p.sl) ? Math.abs(p.px - p.sl) * p.qty : NaN;
    this.open.splice(this.open.indexOf(p), 1);
    const x = {
      id: p.id, n: p.n, src: p.o.src, kind: p.o.kind, side: p.side, ek: p.k, ep: p.px, xk: k, xp: price, why, qty: p.qty, margin: p.margin,
      fees: p.fee + fee, net, r: risk > 0 ? net / risk : NaN, move: ((price - p.px) / p.px) * p.side, bal: this.balance, sl: p.sl, tp: p.tp, capped: p.capped,
    };
    this.trades.push(x);
    this.event(k, p.o, why, price, '', net);
    return x;
  }

  event(k, od, what, price, note = '', net = NaN) {
    this.events.push({ k, id: od.id, n: od.n, side: od.side, kind: od.kind, src: od.src, what, price, note, net, bal: this.balance });
  }

  /** The account after the candles looked at, with the open trades valued at the last close. */
  view() {
    const last = this.K > 0 ? this.c.c[this.K - 1] : NaN;
    let u = 0, gw = 0, gl = 0, wins = 0;
    const open = this.open.map((p) => {
      const pnl = (last - p.px) * p.qty * p.side;
      u += pnl;
      return { ...p, last, pnl, move: ((last - p.px) / p.px) * p.side };
    });
    for (const x of this.trades) { if (x.net > 0) { gw += x.net; wins++; } else gl -= x.net; }
    const eq = this.balance + u, cap = this.cfg.capital;
    return {
      capital: cap, balance: this.balance, equity: eq, upnl: u, net: eq - cap, ret: cap > 0 ? eq / cap - 1 : NaN, fees: this.fees, last,
      open, pending: this.pending.slice(), trades: this.trades, events: this.events, n: this.trades.length, wins,
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN, maxDD: this.peak > 0 ? Math.max(this.maxDD, (this.peak - eq) / this.peak) : 0,
    };
  }
}
