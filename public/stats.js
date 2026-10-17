/*
 * Medusa: the math behind the journal. No DOM in here.
 * The page loads it as window.JournalStats; the tests load it with require().
 * Money is in the trade's margin currency. R = net P&L / risk (when a risk is known).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JournalStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var HOURS = [];
  for (var h = 0; h < 24; h++) HOURS.push(pad(h) + ':00');

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }

  /* ---------- dates (all local time: the phone and laptop share a timezone) ---------- */

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDay(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).getTime();
  }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function addDays(ms, n) { var d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  function weekdayIndex(ms) { return (new Date(ms).getDay() + 6) % 7; } // Monday = 0
  function localStamp(ms) {
    if (num(ms) === null) return '';
    var d = new Date(ms);
    return dayKey(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /* Morning from 5 am, afternoon from noon, evening from 5 pm (and through the night). */
  function greeting(ms) {
    var h = new Date(ms).getHours();
    return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : 'Good evening';
  }

  var PERIODS = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'mtd', label: 'This month' },
    { id: 'lastm', label: 'Last month' },
    { id: 'ytd', label: 'This year' },
    { id: 'all', label: 'All time' },
    { id: 'custom', label: 'Custom dates' },
  ];

  /* The [from, to) window a period filter covers, in ms. Windows that end "now" stay open-ended. */
  function periodRange(id, now, custom) {
    var today0 = startOfDay(now), d = new Date(now);
    switch (id) {
      case 'today': return { from: today0, to: Infinity };
      case '7d': return { from: addDays(today0, -6), to: Infinity };
      case '30d': return { from: addDays(today0, -29), to: Infinity };
      case '90d': return { from: addDays(today0, -89), to: Infinity };
      case 'mtd': return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: Infinity };
      case 'lastm': return {
        from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
        to: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      };
      case 'ytd': return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: Infinity };
      case 'custom':
        if (custom && custom.from && custom.to) {
          var a = parseDay(custom.from), b = parseDay(custom.to);
          if (b < a) { var x = a; a = b; b = x; }
          return { from: a, to: addDays(b, 1) };
        }
        return { from: -Infinity, to: Infinity };
      default: return { from: -Infinity, to: Infinity };
    }
  }

  /* ---------- one trade ---------- */

  /*
   * Everything the journal shows about a trade, computed from what was typed in.
   * Closed = it has an exit price or a typed net P&L. A typed net P&L wins over the price math.
   */
  function derive(t) {
    var dir = t.side === 'short' ? -1 : 1;
    var entry = num(t.entry), exit = num(t.exit), stop = num(t.stop), target = num(t.target);
    var qty = num(t.qty), fees = num(t.fees), pnl = num(t.pnl), riskIn = num(t.risk);
    var entryAt = num(t.entryAt), exitAt = num(t.exitAt);
    if (qty !== null) qty = Math.abs(qty);
    var gross = entry !== null && exit !== null && qty !== null ? (exit - entry) * qty * dir : null;
    var closed = exit !== null || pnl !== null;
    var net = !closed ? null : pnl !== null ? pnl : gross !== null ? gross - (fees || 0) : null;
    var stopDist = entry !== null && stop !== null && stop !== entry ? Math.abs(entry - stop) : null;
    var riskCalc = stopDist !== null && qty ? stopDist * qty : null;
    var risk = riskIn !== null && riskIn > 0 ? riskIn : riskCalc;
    var ok = Array.isArray(t.rulesOk) ? t.rulesOk.length : 0;
    var broken = Array.isArray(t.rulesBroken) ? t.rulesBroken.length : 0;
    return Object.assign({}, t, {
      dir: dir,
      gross: gross,
      net: net,
      closed: closed,
      closeAt: closed ? (exitAt !== null ? exitAt : entryAt) : null,
      hold: closed && exitAt !== null && entryAt !== null && exitAt >= entryAt ? exitAt - entryAt : null,
      risk: risk,
      r: net !== null && risk ? net / risk : null,
      plannedRR: stopDist !== null && target !== null ? Math.abs(target - entry) / stopDist : null,
      stopDist: stopDist,
      outcome: net === null ? null : net > 0 ? 'win' : net < 0 ? 'loss' : 'be',
      maeR: stopDist !== null && num(t.mae) !== null ? -Math.abs(t.mae - entry) / stopDist : null,
      mfeR: stopDist !== null && num(t.mfe) !== null ? Math.abs(t.mfe - entry) / stopDist : null,
      feesPaid: fees || 0,
      notional: entry !== null && qty !== null ? entry * qty : null,
      rulesTotal: ok + broken,
      rulesOkN: ok,
      allRules: ok + broken > 0 ? broken === 0 : null,
      mistakes: Array.isArray(t.mistakes) ? t.mistakes.filter(Boolean) : [],
    });
  }

  /* Closed trades with a known result, the only ones that count toward stats. */
  function isCounted(t) { return t.closed && t.net !== null && num(t.closeAt) !== null; }

  function byClose(a, b) {
    return (a.closeAt - b.closeAt) || ((a.entryAt || 0) - (b.entryAt || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /* ---------- sets of trades ---------- */

  function miniStats(list) {
    var n = list.length, wins = 0, losses = 0, gw = 0, gl = 0, net = 0, nR = 0, sR = 0;
    for (var i = 0; i < n; i++) {
      var t = list[i];
      net += t.net;
      if (t.net > 0) { wins++; gw += t.net; } else if (t.net < 0) { losses++; gl -= t.net; }
      if (t.r !== null) { nR++; sR += t.r; }
    }
    return {
      n: n, wins: wins, losses: losses,
      winRate: wins + losses ? wins / (wins + losses) : null,
      net: net, grossWin: gw, grossLoss: gl,
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
      expectancy: n ? net / n : null,
      nR: nR, sumR: sR, avgR: nR ? sR / nR : null,
    };
  }

  /* Running equity in money and in R, with the drawdown from the running peak at each trade. */
  function equitySeries(sorted, start) {
    var cum = 0, cumR = 0, peak = start, peakR = 0, out = [];
    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i];
      cum += t.net;
      cumR += t.r || 0;
      var eq = start + cum;
      if (eq > peak) peak = eq;
      if (cumR > peakR) peakR = cumR;
      out.push({ i: i + 1, at: t.closeAt, id: t.id, sym: t.sym, net: t.net, r: t.r, cum: cum, cumR: cumR, eq: eq, peak: peak, dd: eq - peak, ddR: cumR - peakR });
    }
    return out;
  }

  function summarize(list, startBalance) {
    var ts = list.slice().sort(byClose);
    var base = miniStats(ts);
    var fees = 0, best = null, worst = null, holdW = [], holdL = [], rs = [];
    var rulesN = 0, rulesAll = 0, rulesOk = 0, rulesTot = 0, bigLosses = 0, lossesR = 0;
    var maxW = 0, maxL = 0, run = 0, runType = null;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      fees += t.feesPaid;
      if (t.net > 0 && (!best || t.net > best.net)) best = t;
      if (t.net < 0 && (!worst || t.net < worst.net)) worst = t;
      if (t.hold !== null) { if (t.net > 0) holdW.push(t.hold); else if (t.net < 0) holdL.push(t.hold); }
      if (t.r !== null) {
        rs.push(t.r);
        if (t.net < 0) { lossesR++; if (t.r < -1.2) bigLosses++; }
      }
      if (t.rulesTotal > 0) {
        rulesN++; rulesOk += t.rulesOkN; rulesTot += t.rulesTotal;
        if (t.allRules) rulesAll++;
      }
      var type = t.outcome === 'win' || t.outcome === 'loss' ? t.outcome : null;
      if (type && type === runType) run++;
      else { run = type ? 1 : 0; runType = type; }
      if (runType === 'win' && run > maxW) maxW = run;
      if (runType === 'loss' && run > maxL) maxL = run;
    }
    var start = num(startBalance) || 0;
    var eq = equitySeries(ts, start);
    var maxDD = 0, maxDDR = 0, maxDDPct = null;
    for (var j = 0; j < eq.length; j++) {
      var p = eq[j];
      if (-p.dd > maxDD) maxDD = -p.dd;
      if (-p.ddR > maxDDR) maxDDR = -p.ddR;
      if (start > 0 && p.peak > 0) {
        var pct = -p.dd / p.peak;
        if (maxDDPct === null || pct > maxDDPct) maxDDPct = pct;
      }
    }
    var nR = rs.length, avgR = nR ? sum(rs) / nR : null, sdR = null;
    if (nR > 1) {
      var v = 0;
      for (var k = 0; k < nR; k++) v += (rs[k] - avgR) * (rs[k] - avgR);
      sdR = Math.sqrt(v / (nR - 1));
    }
    var preFee = base.net + fees;
    return Object.assign(base, {
      trades: ts,
      equity: eq,
      fees: fees,
      preFee: preFee,
      feeShare: preFee > 0 && fees > 0 ? fees / preFee : null,
      best: best,
      worst: worst,
      avgWin: base.wins ? base.grossWin / base.wins : null,
      avgLoss: base.losses ? base.grossLoss / base.losses : null,
      payoff: base.wins && base.losses ? (base.grossWin / base.wins) / (base.grossLoss / base.losses) : null,
      sdR: sdR,
      // Van Tharp's System Quality Number, with N capped at 100 as he does.
      sqn: nR >= 2 && sdR > 0 ? Math.sqrt(Math.min(nR, 100)) * avgR / sdR : null,
      lossesR: lossesR,
      bigLosses: bigLosses,
      maxDD: maxDD,
      maxDDR: maxDDR,
      maxDDPct: maxDDPct,
      ret: start > 0 ? base.net / start : null,
      maxWinStreak: maxW,
      maxLossStreak: maxL,
      streak: { type: runType, n: run },
      holdWin: holdW.length ? sum(holdW) / holdW.length : null,
      holdLoss: holdL.length ? sum(holdL) / holdL.length : null,
      nHoldWin: holdW.length,
      nHoldLoss: holdL.length,
      rulesN: rulesN,
      rulesAllShare: rulesN ? rulesAll / rulesN : null,
      rulesRate: rulesTot ? rulesOk / rulesTot : null,
    });
  }

  /* ---------- breakdowns ---------- */

  var HOLD_BUCKETS = [
    [5 * MIN, 'Under 5m'], [30 * MIN, '5–30m'], [2 * HOUR, '30m–2h'], [8 * HOUR, '2–8h'],
    [DAY, '8–24h'], [3 * DAY, '1–3 days'], [Infinity, 'Over 3 days'],
  ];
  var PERDAY_BUCKETS = [[1, '1 trade'], [3, '2–3 trades'], [5, '4–5 trades'], [Infinity, '6+ trades']];

  function holdBucket(ms) {
    for (var i = 0; i < HOLD_BUCKETS.length; i++) if (ms < HOLD_BUCKETS[i][0]) return HOLD_BUCKETS[i][1];
    return HOLD_BUCKETS[HOLD_BUCKETS.length - 1][1];
  }
  function perDayBucket(n) {
    for (var i = 0; i < PERDAY_BUCKETS.length; i++) if (n <= PERDAY_BUCKETS[i][0]) return PERDAY_BUCKETS[i][1];
    return PERDAY_BUCKETS[PERDAY_BUCKETS.length - 1][1];
  }
  function labels(table) { return table.map(function (x) { return x[1]; }); }

  var LEV_BUCKETS = [[3, 'Up to 3x'], [5, '4x to 5x'], [10, '6x to 10x'], [20, '11x to 20x'], [Infinity, 'Over 20x']];
  function levBucket(l) {
    for (var i = 0; i < LEV_BUCKETS.length; i++) if (l <= LEV_BUCKETS[i][0]) return LEV_BUCKETS[i][1];
    return LEV_BUCKETS[LEV_BUCKETS.length - 1][1];
  }

  var DIMENSIONS = [
    { id: 'sym', label: 'Symbol', key: function (t) { return t.sym || 'Unknown'; } },
    { id: 'side', label: 'Side', key: function (t) { return t.side === 'short' ? 'Short' : 'Long'; }, order: ['Long', 'Short'] },
    { id: 'setup', label: 'Setup', key: function (t) { return t.setup || 'No setup'; } },
    { id: 'tags', label: 'Tags', key: function (t) { return t.tags && t.tags.length ? t.tags : ['No tags']; } },
    { id: 'mistakes', label: 'Mistakes', key: function (t) { return t.mistakes.length ? t.mistakes : ['No mistakes']; } },
    { id: 'exit', label: 'Exit', key: function (t) { return t.exitKind || 'Unknown'; }, order: ['Take profit', 'Stop in profit', 'Manual close', 'Quick exit', 'Stop loss', 'Liquidation', 'Unknown'] },
    { id: 'entrytype', label: 'Entry order', key: function (t) { return t.entryType || 'Unknown'; } },
    { id: 'lev', label: 'Leverage', key: function (t) { return t.lev ? levBucket(t.lev) : 'Unknown'; }, order: labels(LEV_BUCKETS).concat(['Unknown']) },
    { id: 'weekday', label: 'Weekday', key: function (t) { return WEEKDAYS[weekdayIndex(t.entryAt)]; }, order: WEEKDAYS },
    { id: 'hour', label: 'Hour opened', key: function (t) { return HOURS[new Date(t.entryAt).getHours()]; }, order: HOURS },
    { id: 'hold', label: 'Hold time', key: function (t) { return t.hold === null ? 'Unknown' : holdBucket(t.hold); }, order: labels(HOLD_BUCKETS).concat(['Unknown']) },
    { id: 'perday', label: 'Trades that day', key: function (t, ctx) { return perDayBucket(ctx.counts[dayKey(t.entryAt)] || 1); }, order: labels(PERDAY_BUCKETS) },
    { id: 'emo', label: 'Emotion', key: function (t) { return t.emo || 'Not logged'; } },
    { id: 'conf', label: 'Execution', key: function (t) { return t.conf ? t.conf + ' of 5' : 'Not rated'; }, order: ['5 of 5', '4 of 5', '3 of 5', '2 of 5', '1 of 5', 'Not rated'] },
    { id: 'rules', label: 'Plan', key: function (t) { return t.allRules === null ? 'Not marked' : t.allRules ? 'Followed plan' : 'Broke plan'; }, order: ['Followed plan', 'Broke plan', 'Not marked'] },
  ];
  var DIM_INDEX = {};
  DIMENSIONS.forEach(function (d) { DIM_INDEX[d.id] = d; });

  function groupBy(list, dimId) {
    var dim = DIM_INDEX[dimId] || DIMENSIONS[0];
    var ctx = { counts: {} };
    if (dim.id === 'perday') list.forEach(function (t) { var k = dayKey(t.entryAt); ctx.counts[k] = (ctx.counts[k] || 0) + 1; });
    var groups = new Map();
    list.forEach(function (t) {
      var keys = dim.key(t, ctx);
      if (!Array.isArray(keys)) keys = [keys];
      keys.forEach(function (k) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      });
    });
    var rows = [];
    groups.forEach(function (items, key) { rows.push(Object.assign({ key: key, items: items }, miniStats(items))); });
    if (dim.order) {
      var rank = function (k) { var i = dim.order.indexOf(k); return i < 0 ? 1e6 : i; };
      rows.sort(function (a, b) { return rank(a.key) - rank(b.key) || b.n - a.n; });
    } else {
      rows.sort(function (a, b) { return b.n - a.n || b.net - a.net; });
    }
    return rows;
  }

  /* R histogram: half-R bins centred on -3 ... +3, so a clean -1R stop-out sits in one bin. */
  function rHistogram(list) {
    var bins = [{ lo: -Infinity, hi: -3.25, mid: -3.5, n: 0 }];
    for (var c = -6; c <= 6; c++) bins.push({ lo: c / 2 - 0.25, hi: c / 2 + 0.25, mid: c / 2, n: 0 });
    bins.push({ lo: 3.25, hi: Infinity, mid: 3.5, n: 0 });
    list.forEach(function (t) {
      if (t.r === null) return;
      for (var i = 0; i < bins.length; i++) if (t.r >= bins[i].lo && t.r < bins[i].hi) { bins[i].n++; break; }
    });
    return bins;
  }

  /* Closed trades by the local day they closed on. */
  function byDay(list) {
    var out = {};
    list.forEach(function (t) {
      var k = dayKey(t.closeAt);
      var d = out[k] || (out[k] = { net: 0, n: 0, sumR: 0, nR: 0, wins: 0, losses: 0 });
      d.net += t.net; d.n++;
      if (t.r !== null) { d.sumR += t.r; d.nR++; }
      if (t.net > 0) d.wins++; else if (t.net < 0) d.losses++;
    });
    return out;
  }

  /* Trades opened while the last k closed trades before them were all losses (breakevens are skipped). */
  function afterLosses(list, k) {
    var sorted = list.slice().sort(byClose);
    var closes = sorted.map(function (t) { return t.closeAt; });
    var out = [];
    list.forEach(function (t) {
      if (num(t.entryAt) === null) return;
      var lo = 0, hi = closes.length; // first index with closeAt > entryAt
      while (lo < hi) { var mid = (lo + hi) >> 1; if (closes[mid] <= t.entryAt) lo = mid + 1; else hi = mid; }
      var run = 0;
      for (var i = lo - 1; i >= 0 && run < k; i--) {
        var p = sorted[i];
        if (p.id === t.id) continue;
        if (p.outcome === 'loss') run++;
        else if (p.outcome === 'win') break;
      }
      if (run >= k) out.push(t);
    });
    return out;
  }

  function todayStatus(list, now, settings) {
    var key = dayKey(now), entered = 0, net = 0, closedN = 0, sumR = 0;
    list.forEach(function (t) {
      if (num(t.entryAt) !== null && dayKey(t.entryAt) === key) entered++;
      if (isCounted(t) && dayKey(t.closeAt) === key) {
        net += t.net; closedN++;
        if (t.r !== null) sumR += t.r;
      }
    });
    var lim = num(settings && settings.dailyLossLimit), maxT = num(settings && settings.maxTrades);
    return {
      entered: entered, closed: closedN, net: net, sumR: sumR,
      loss: lim && lim > 0 ? { limit: lim, used: Math.max(0, -net), share: Math.max(0, -net) / lim, hit: -net >= lim } : null,
      count: maxT && maxT > 0 ? { limit: maxT, used: entered, share: entered / maxT, hit: entered >= maxT } : null,
    };
  }

  /* ---------- plain-language findings ---------- */

  /*
   * Rule-based findings, most costly leaks first. Groups need MIN_GROUP trades before they're
   * mentioned, and anything under 20 trades is flagged as a small sample.
   * fmt supplies money(v, signed), r(v), pct(v) and dur(ms) so the wording matches the page.
   */
  var MIN_GROUP = 5;
  function insights(list, s, fmt) {
    var out = [];
    if (!s || s.n < 3) return out;
    function add(tone, rank, title, detail, n) { out.push({ tone: tone, rank: rank, title: title, detail: detail, n: n, small: n < 20 }); }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    // Losses bigger than the plan: a moved or missing stop.
    if (s.lossesR >= 3 && s.bigLosses >= 2 && s.bigLosses / s.lossesR >= 0.15) {
      var big = list.filter(function (t) { return t.r !== null && t.net < 0 && t.r < -1.2; });
      var excess = big.reduce(function (a, t) { return a + (t.r + 1) * t.risk; }, 0);
      var worstR = big.reduce(function (a, t) { return Math.min(a, t.r); }, 0);
      add('bad', 1, plural(s.bigLosses, 'loss') + ' went past your stop',
        'These losses were worse than −1.2R, which usually means the stop was moved, missing or skipped. The part beyond −1R cost ' +
        fmt.money(-excess, false) + '. The worst was ' + fmt.r(worstR) + '.', s.lossesR);
    }

    // What the mistake tags cost.
    var withM = list.filter(function (t) { return t.mistakes.length; });
    var clean = list.filter(function (t) { return !t.mistakes.length; });
    if (withM.length >= 3) {
      var m = miniStats(withM);
      if (m.net < 0) {
        var rows = groupBy(withM, 'mistakes').sort(function (a, b) { return a.net - b.net; });
        var top = rows[0];
        var detail = plural(withM.length, 'trade') + ' tagged with a mistake lost ' + fmt.money(-m.net, false) + ' in total.';
        if (top && top.net < 0) detail += ' The most expensive tag was ' + top.key + ': ' + fmt.money(top.net) + ' over ' + plural(top.n, 'trade') + '.';
        if (clean.length >= 3) {
          var c = miniStats(clean);
          if (c.avgR !== null && m.avgR !== null) detail += ' Trades without mistakes averaged ' + fmt.r(c.avgR) + ', trades with them ' + fmt.r(m.avgR) + '.';
        }
        add('bad', 2, 'Mistakes cost you ' + fmt.money(-m.net, false), detail, withM.length);
      }
    }

    // Tilt: the trade after two losses in a row.
    var tilt = afterLosses(list, 2);
    if (tilt.length >= MIN_GROUP) {
      var ts = miniStats(tilt);
      var worse = (ts.winRate !== null && s.winRate !== null && ts.winRate < s.winRate - 0.1) || (ts.avgR !== null && ts.avgR < 0 && (s.avgR === null || ts.avgR < s.avgR - 0.2));
      if (worse) {
        var d2 = 'After two losses in a row you won ' + fmt.pct(ts.winRate) + ' of the next ' + plural(tilt.length, 'trade') + ', against ' + fmt.pct(s.winRate) + ' overall.';
        if (ts.net < 0) d2 += ' Stopping after two losses would have saved ' + fmt.money(-ts.net, false) + '.';
        add('bad', 3, 'You trade worse after two losses', d2, tilt.length);
      }
    }

    var setups = groupBy(list, 'setup').filter(function (r) { return r.key !== 'No setup' && r.n >= MIN_GROUP && r.avgR !== null; });
    setups.sort(function (a, b) { return b.avgR - a.avgR; });
    var worstSetup = setups.length ? setups[setups.length - 1] : null;
    if (worstSetup && worstSetup.avgR < 0) {
      add('bad', 4, worstSetup.key + ' is losing money',
        plural(worstSetup.n, 'trade') + ', ' + fmt.r(worstSetup.avgR) + ' per trade, ' + fmt.money(worstSetup.net) + ' in total. Review these trades before taking the setup again.', worstSetup.n);
    }

    if (s.fees > 0 && s.preFee > 0 && s.feeShare >= 0.25 && s.n >= MIN_GROUP) {
      add('bad', 5, 'Fees took ' + fmt.pct(s.feeShare) + ' of your profit',
        'You made ' + fmt.money(s.preFee) + ' before fees and paid ' + fmt.money(s.fees, false) + ' in fees across ' + plural(s.n, 'trade') + '. Fewer, larger-R trades keep more of it.', s.n);
    } else if (s.fees > 0 && s.preFee <= 0 && s.n >= MIN_GROUP) {
      add('bad', 5, 'Fees added ' + fmt.money(s.fees, false) + ' to your losses',
        'You were already down ' + fmt.money(s.preFee) + ' before fees across ' + plural(s.n, 'trade') + '.', s.n);
    }

    if (s.nHoldWin >= MIN_GROUP && s.nHoldLoss >= MIN_GROUP && s.holdLoss > s.holdWin * 1.5) {
      add('bad', 6, 'You hold losers longer than winners',
        'Your average loser stayed open ' + fmt.dur(s.holdLoss) + ', your average winner ' + fmt.dur(s.holdWin) + '. Letting the stop do its job keeps losses at −1R.', s.nHoldWin + s.nHoldLoss);
    }

    var perday = groupBy(list, 'perday');
    var busy = perday.filter(function (r) { return r.key === '4–5 trades' || r.key === '6+ trades'; });
    var calm = perday.filter(function (r) { return r.key === '1 trade' || r.key === '2–3 trades'; });
    var busyS = miniStats([].concat.apply([], busy.map(function (r) { return r.items; })));
    var calmS = miniStats([].concat.apply([], calm.map(function (r) { return r.items; })));
    if (busyS.n >= MIN_GROUP && calmS.n >= MIN_GROUP && busyS.avgR !== null && calmS.avgR !== null && busyS.avgR < 0 && busyS.avgR < calmS.avgR - 0.2) {
      add('bad', 7, 'Busy days cost you',
        'On days with 4 or more trades you averaged ' + fmt.r(busyS.avgR) + ' per trade (' + fmt.money(busyS.net) + '). On quieter days, ' + fmt.r(calmS.avgR) + '.', busyS.n);
    }

    var emos = groupBy(list, 'emo').filter(function (r) { return r.key !== 'Not logged' && r.n >= MIN_GROUP && r.avgR !== null; });
    emos.sort(function (a, b) { return a.avgR - b.avgR; });
    if (emos.length && emos[0].avgR < -0.2) {
      add('bad', 8, 'Trades taken feeling ' + emos[0].key.toLowerCase() + ' lose',
        plural(emos[0].n, 'trade') + ' logged as ' + emos[0].key + ' averaged ' + fmt.r(emos[0].avgR) + ' (' + fmt.money(emos[0].net) + ').', emos[0].n);
    }

    var hours = groupBy(list, 'hour').filter(function (r) { return r.n >= MIN_GROUP && r.avgR !== null; });
    hours.sort(function (a, b) { return a.avgR - b.avgR; });
    if (hours.length >= 2 && hours[0].avgR < -0.3) {
      add('bad', 9, 'Trades opened at ' + hours[0].key + ' lose most',
        plural(hours[0].n, 'trade') + ' opened in that hour averaged ' + fmt.r(hours[0].avgR) + '. Your best hour is ' + hours[hours.length - 1].key + ' at ' + fmt.r(hours[hours.length - 1].avgR) + '.', hours[0].n);
    }

    var rules = groupBy(list, 'rules');
    var followed = rules.filter(function (r) { return r.key === 'Followed plan'; })[0];
    var brokeR = rules.filter(function (r) { return r.key === 'Broke plan'; })[0];
    if (followed && brokeR && followed.n >= MIN_GROUP && brokeR.n >= MIN_GROUP && followed.avgR !== null && brokeR.avgR !== null && followed.avgR > brokeR.avgR) {
      add('good', 10, 'Following your plan pays',
        'When you followed your plan you averaged ' + fmt.r(followed.avgR) + ' over ' + plural(followed.n, 'trade') + '. When you broke it, ' + fmt.r(brokeR.avgR) + ' over ' + plural(brokeR.n, 'trade') + '.', followed.n + brokeR.n);
    }

    var bestSetup = setups.length ? setups[0] : null;
    if (bestSetup && bestSetup.avgR > 0 && bestSetup !== worstSetup) {
      add('good', 11, bestSetup.key + ' is your best setup',
        plural(bestSetup.n, 'trade') + ', ' + fmt.r(bestSetup.avgR) + ' per trade, ' + fmt.pct(bestSetup.winRate) + ' won, ' + fmt.money(bestSetup.net) + ' in total.', bestSetup.n);
    }

    var sides = groupBy(list, 'side').filter(function (r) { return r.n >= MIN_GROUP && r.avgR !== null; });
    if (sides.length === 2 && Math.abs(sides[0].avgR - sides[1].avgR) >= 0.3) {
      var better = sides[0].avgR > sides[1].avgR ? sides[0] : sides[1];
      var other = better === sides[0] ? sides[1] : sides[0];
      add('info', 12, 'Your ' + better.key.toLowerCase() + 's do better',
        better.key + 's average ' + fmt.r(better.avgR) + ' over ' + plural(better.n, 'trade') + '; ' + other.key.toLowerCase() + 's ' + fmt.r(other.avgR) + ' over ' + plural(other.n, 'trade') + '.', better.n + other.n);
    }

    var liq = groupBy(list, 'exit').filter(function (r) { return r.key === 'Liquidation'; })[0];
    if (liq) {
      add('bad', 0, plural(liq.n, 'trade') + ' ended in liquidation',
        'Liquidations cost ' + fmt.money(-liq.net, false) + ' in this period. A stop-loss on every position closes it long before the exchange does.', liq.n);
    }

    out.sort(function (a, b) { return a.rank - b.rank; });
    return out;
  }

  /* ---------- export ---------- */

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(Math.round(v * 1e8) / 1e8) : '';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets reading typed text as a formula
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* columns: [[header, fn(row)], ...]. Starts with a byte-order mark so Excel reads it as UTF-8. */
  function toCSV(columns, rows) {
    var lines = [columns.map(function (c) { return csvCell(c[0]); }).join(',')];
    rows.forEach(function (r) { lines.push(columns.map(function (c) { return csvCell(c[1](r)); }).join(',')); });
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  return {
    MIN: MIN, HOUR: HOUR, DAY: DAY,
    WEEKDAYS: WEEKDAYS, HOURS: HOURS, PERIODS: PERIODS, DIMENSIONS: DIMENSIONS,
    num: num, pad: pad, dayKey: dayKey, parseDay: parseDay, startOfDay: startOfDay, addDays: addDays,
    weekdayIndex: weekdayIndex, localStamp: localStamp, greeting: greeting, periodRange: periodRange,
    derive: derive, isCounted: isCounted, byClose: byClose,
    miniStats: miniStats, equitySeries: equitySeries, summarize: summarize,
    groupBy: groupBy, rHistogram: rHistogram, byDay: byDay, afterLosses: afterLosses,
    todayStatus: todayStatus, insights: insights,
    csvCell: csvCell, toCSV: toCSV,
  };
});
