// Turns CoinDCX futures orders (plus CoinDCX's own profit/loss and fee records) into closed
// round-trip trades: a trade starts when the position leaves zero and ends when it is back at zero.
// Only closed trades come out. An open position is left out on purpose.

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** "B-PEOPLE_USDT" -> { sym: "PEOPLEUSDT", base: "PEOPLE", quote: "USDT" } */
export function parsePair(pair) {
  const m = /^[A-Z]{1,3}-([A-Z0-9]+)_([A-Z0-9]+)$/i.exec(String(pair || ''));
  if (m) return { sym: (m[1] + m[2]).toUpperCase(), base: m[1].toUpperCase(), quote: m[2].toUpperCase() };
  const s = String(pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return { sym: s, base: s, quote: '' };
}

/** Logo lookup key: "1000PEPE" -> "PEPE", "1000000MOG" -> "MOG". */
export function logoKey(base) {
  const b = String(base || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return b.replace(/^(1000000|100000|10000|1000|1M)(?=[A-Z])/, '') || b;
}

/** A CoinDCX futures order, as stored. */
export function normOrder(o, mcurFallback = 'USDT') {
  const filled = num(o.total_quantity) - num(o.remaining_quantity) - num(o.cancelled_quantity);
  const created = num(o.created_at);
  return {
    id: String(o.id),
    pair: String(o.pair || ''),
    mcur: String(o.margin_currency_short_name || mcurFallback),
    side: o.side === 'sell' ? 'sell' : 'buy',
    qty: filled > 1e-12 ? Number(filled.toPrecision(12)) : 0,
    price: num(o.avg_price),
    fee: num(o.fee_amount),
    lev: num(o.leverage) || null,
    otype: o.order_type ? String(o.order_type) : null,
    stage: o.stage ? String(o.stage) : null,
    status: o.status ? String(o.status) : null,
    created_at: created,
    updated_at: num(o.updated_at) || created,
  };
}

/** A stop-loss or take-profit order (any status), as stored in `triggers`. Other orders give null. */
export function normTrigger(o, mcurFallback = 'USDT') {
  const ot = String(o.order_type || '');
  const kind = /take_profit/.test(ot) ? 'tp' : /stop/.test(ot) ? 'sl' : null;
  const price = num(o.stop_price);
  if (!kind || !(price > 0) || !o.pair) return null;
  const created = num(o.created_at);
  return {
    id: String(o.id),
    pair: String(o.pair),
    mcur: String(o.margin_currency_short_name || mcurFallback),
    side: o.side === 'sell' ? 'sell' : 'buy',
    kind,
    price,
    status: o.status ? String(o.status) : null,
    created_at: created,
    updated_at: num(o.updated_at) || created,
  };
}

/** Take-profit and stop-loss prices typed into an entry order itself, when CoinDCX sends them. */
export function attachedTriggers(o, mcurFallback = 'USDT') {
  if (/stop|take_profit/.test(String(o.order_type || '')) || !o.pair) return [];
  const created = num(o.created_at);
  const base = {
    pair: String(o.pair),
    mcur: String(o.margin_currency_short_name || mcurFallback),
    side: o.side === 'sell' ? 'buy' : 'sell', // they close the position, so they sit on the other side
    status: 'attached',
    created_at: created,
    updated_at: num(o.updated_at) || created,
  };
  return [['take_profit_price', 'tp'], ['stop_loss_price', 'sl']]
    .filter(([field]) => num(o[field]) > 0)
    .map(([field, kind]) => ({ ...base, id: `${o.id}:${kind}`, kind, price: num(o[field]) }));
}

/**
 * The stop loss and take profit of one closed trade: orders on the closing side that existed while the
 * position was open (placed before it closed, last changed after it opened). If one was moved, the
 * last one placed is the one that counted.
 */
export function pickLevels(trade, triggers) {
  const exitSide = trade.side === 'long' ? 'sell' : 'buy';
  const live = triggers
    .filter((x) => x.side === exitSide && x.created_at <= trade.close_ts && x.updated_at >= trade.open_ts)
    .sort((a, b) => a.created_at - b.created_at);
  const last = (kind) => live.filter((x) => x.kind === kind).pop() || null;
  return { sl: last('sl'), tp: last('tp') };
}

/** A CoinDCX profit/loss, fee or funding record, as stored. `k` is its de-duplication key. */
export function normTx(t, mcurFallback = 'USDT') {
  const created = num(t.created_at);
  const k = t.id !== undefined && t.id !== null && t.id !== ''
    ? 'id:' + String(t.id)
    : ['f', t.parent_id ?? '', t.position_id ?? '', t.stage ?? '', created, num(t.amount), num(t.fee_amount)].join('|');
  return {
    k,
    pair: String(t.pair || ''),
    mcur: String(t.margin_currency_short_name || mcurFallback),
    order_id: t.parent_id !== undefined && t.parent_id !== null ? String(t.parent_id) : '',
    stage: String(t.stage || ''),
    amount: num(t.amount),
    fee: num(t.fee_amount),
    created_at: created,
  };
}

function exitKind(o, net) {
  const st = String(o.stage || ''), ot = String(o.otype || '');
  if (/liquidat/.test(st)) return 'Liquidation';
  if (/take_profit/.test(ot)) return 'Take profit';
  if (st === 'tpsl_exit' || /stop/.test(ot)) return net < 0 ? 'Stop loss' : 'Stop in profit';
  if (st === 'exit') return 'Quick exit';
  return 'Manual close';
}

function entryType(o) {
  const ot = String(o.otype || '');
  if (/market/.test(ot) && !/stop|take_profit/.test(ot)) return 'Market';
  if (/limit/.test(ot) && !/stop|take_profit/.test(ot)) return 'Limit';
  if (/stop|take_profit/.test(ot)) return 'Stop';
  return ot || 'Order';
}

/**
 * orders, txs: everything stored for ONE pair and margin currency.
 * Profit/loss comes from CoinDCX's own records when they exist (they exclude fees); otherwise it is
 * worked out from the fill prices. net = pnl - fees + funding (funding is signed: + received, - paid).
 */
export function buildTrades(orders, txs) {
  const byOrder = new Map();
  const funding = [];
  for (const t of txs) {
    if (t.stage === 'funding') { funding.push(t); continue; }
    if (!t.order_id) continue;
    const a = byOrder.get(t.order_id) || { pnl: 0, fee: 0 };
    a.pnl += num(t.amount);
    a.fee += num(t.fee);
    byOrder.set(t.order_id, a);
  }
  const fills = orders
    .filter((o) => num(o.qty) > 0 && num(o.price) > 0)
    .sort((a, b) => a.updated_at - b.updated_at || a.created_at - b.created_at || (a.id < b.id ? -1 : 1));

  const out = [];
  let pos = 0, cur = null;
  const pnlDone = new Set();

  const close = (o) => {
    const inQty = cur.inQty || 1;
    const entry = cur.inVal / inQty;
    const exit = cur.outQty ? cur.outVal / cur.outQty : entry;
    let fund = 0;
    for (const f of funding) if (f.created_at >= cur.open_ts && f.created_at <= o.updated_at) fund += num(f.amount);
    const pnl = cur.pnl + cur.calcPnl;
    const net = pnl - cur.fees + fund;
    const { sym, base, quote } = parsePair(cur.first.pair);
    out.push({
      id: `${cur.first.pair}:${cur.first.id}`,
      pair: cur.first.pair, sym, base, quote, mcur: cur.first.mcur,
      side: cur.side,
      open_ts: cur.open_ts, close_ts: o.updated_at,
      qty: Number(cur.maxQty.toPrecision(12)),
      entry: Number(entry.toPrecision(12)), exit: Number(exit.toPrecision(12)),
      pnl: round(pnl), fees: round(cur.fees), funding: round(fund), net: round(net),
      lev: cur.lev, entry_type: entryType(cur.first), exit_kind: exitKind(o, net),
      orders: cur.orders.size, pnl_source: cur.calcPnl ? 'prices' : 'coindcx',
    });
    cur = null;
    pos = 0;
  };

  for (const o of fills) {
    const rec = byOrder.get(o.id);
    const orderFee = rec ? rec.fee : num(o.fee);
    let left = o.side === 'buy' ? o.qty : -o.qty;
    const tol = Math.max(1e-12, o.qty * 1e-9);
    while (Math.abs(left) > tol) {
      if (!cur) {
        cur = {
          first: o, side: left > 0 ? 'long' : 'short', open_ts: o.updated_at,
          inQty: 0, inVal: 0, outQty: 0, outVal: 0, pnl: 0, calcPnl: 0, fees: 0,
          orders: new Set(), lev: o.lev, maxQty: 0,
        };
      }
      const dir = cur.side === 'long' ? 1 : -1;
      const adding = Math.sign(left) === dir;
      const part = adding ? left : Math.sign(left) * Math.min(Math.abs(left), Math.abs(pos));
      const size = Math.abs(part);
      cur.orders.add(o.id);
      cur.fees += orderFee * (size / o.qty);
      if (adding) {
        cur.inQty += size;
        cur.inVal += size * o.price;
      } else {
        const avgIn = cur.inVal / cur.inQty;
        cur.outQty += size;
        cur.outVal += size * o.price;
        // CoinDCX books an order's whole realized P&L on its closing part.
        if (rec && !pnlDone.has(o.id)) { cur.pnl += rec.pnl; pnlDone.add(o.id); }
        if (!rec) cur.calcPnl += (o.price - avgIn) * size * dir;
      }
      pos += part;
      left -= part;
      if (Math.abs(pos) > cur.maxQty) cur.maxQty = Math.abs(pos);
      if (!adding && Math.abs(pos) <= Math.max(1e-12, cur.maxQty * 1e-9)) close(o);
    }
    // An order that only opened or added still has its (normally zero) P&L counted once.
    if (rec && !pnlDone.has(o.id) && cur && cur.orders.has(o.id)) { cur.pnl += rec.pnl; pnlDone.add(o.id); }
  }
  return out;
}

function round(v) {
  return Math.round(v * 1e8) / 1e8;
}
