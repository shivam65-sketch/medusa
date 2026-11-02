// MEDUSA Risk: what has held up, when it works, and how much to trade. Downloaded only when the page is
// opened (app.js). The history below is fixed: it comes from tests run outside the app, on data to the date
// in HISTORY.asOf (docs/risk-research.md). Live here: BTC's and ETH's place against their 50-day average,
// straight from Binance, and each market's normal from the scanner's data, for the Bad day warning.

const REST = 'https://fapi.binance.com/fapi/v1';

const HISTORY = {
  asOf: '31 Oct 2026',
  years: [['2020, from July', 139.3, 182.3], ['2021', 110.5, 113.3], ['2022', -41.1, -66], ['2023', 84.6, 105.7], ['2024', 37.6, 61.7], ['2025', 40.9, -10.8], ['2026, to October', 19.1, -19.2]],
  periods: { to2024: { rule: 57, held: 54 }, from2025: { rule: 33, held: -16 } },
  whole: { rule: 12.6, held: 4.9, ruleFall: -56, heldFall: -77 },
  months: [['Jan', 15.4, -3], ['Feb', 10.2, -2.1], ['Mar', 9.2, -4.4], ['Apr', -2.2, 6], ['May', -3.7, 11.1], ['Jun', -1.6, -1], ['Jul', 6.3, 9.7], ['Aug', 3.2, 16.1], ['Sep', -8.4, 2], ['Oct', 11.3, -4.1], ['Nov', 12.3, 0], ['Dec', 4, 0]],
};

// [the idea, 2020-2024, from 2025, what happened]
const FAILED = [
  ['Holding BTC only in November to April', '+50% a year', '−15% a year', 'Best months didn’t repeat'],
  ['Holding BTC only at the turn of the month', '+21% a year', '−6% a year', 'Faded'],
  ['Trading 21–23 UTC, BTC', '−7% a year', '−20% a year', 'A small drift, smaller than the fees'],
  ['28-day momentum, top 30 coins, long', '+33% a year', '−67% a year', 'Altcoins fell from 2025'],
  ['Turtle breakout, 30 futures', '+663R, t 3.2', '−109R, t −1.1', 'Stopped working from 2025'],
  ['Shorting after unusual up moves', 't 0.0', 't −0.1', 'Looked good until funding and equal sizing were counted'],
  ['3:1 in season, 1.5:1 at half size off season', 't −0.1', 't 1.0', 'The season didn’t repeat'],
  ['Scalping on 1-minute candles, 6 coins', '0 of 132 tests', '0 of 132 tests', 'Made 0.00–0.02% a trade before 0.12% costs'],
  ['Memecoins above their 50-day average', '+61% a year', '−4% a year', 'Cut the losses, made no profit'],
];

// [method, money grew, worst fall, from 2025 a year]
const METHODS = [
  ['Full size', '12.6x', '−56%', '+33%'],
  ['Volatility target of 40%', '9.5x', '−50%', '+30%'],
  ['Quarter Kelly', '5.6x', '−40%', '+21%'],
  ['Half size after a 15% fall', '4.8x', '−43%', '+18%'],
];

const DEFAULTS = {
  side: 'long', market: '', account: 100000, riskPct: 1, entry: 100, stop: 97, feePct: 0.05,
  beStop: 3, beFee: 0.05, beFunding: 0.03, beDays: 1,
  dayAccount: 100000, dayPct: 3, dayTrade: 1,
  win: 45, avgWin: 1.5, avgLoss: 1, trades: 100,
};

let api = null, host = null;
const S = { form: null, trend: null, base: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const sign = (v, unit = '%') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), 1)}${unit}`;
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim');
const signed = (v, unit) => `<span class="${cls(v)}">${sign(v, unit)}</span>`;
const f = (k) => Number(S.form[k]);

/** Share of normal days below x. */
function normalBelow(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Above or below the 50-day average, on closed daily candles: the last candle is today's, still open. */
async function trend(symbol) {
  const r = await fetch(`${REST}/klines?symbol=${symbol}&interval=1d&limit=52`, { credentials: 'omit' });
  if (!r.ok) throw new Error(`Binance answered ${r.status}`);
  const closes = (await r.json()).slice(0, -1).map((k) => Number(k[4]));
  const last = closes.at(-1);
  const avg = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
  return { last, avg, gap: last / avg - 1 };
}

async function loadTrend() {
  try {
    const [btc, eth] = await Promise.all([trend('BTCUSDT'), trend('ETHUSDT')]);
    S.trend = { btc, eth };
  } catch (e) {
    S.trend = { err: e.message };
    api.log('risk', `The trend check couldn't reach Binance: ${e.message}`, null, 'error');
  }
  const el = host && host.querySelector('#risk-live');
  if (el) el.innerHTML = liveHtml();
}

async function loadBase() {
  try {
    const d = await api.call('GET', '/api/market/scanner');
    const part = d.market_baseline;
    S.base = new Map((part ? part.rows : []).map((r) => {
      const row = Object.fromEntries(part.columns.map((c, i) => [c, r[i]]));
      return [row.symbol, row];
    }));
  } catch (e) {
    api.log('risk', `The Bad day check isn't available: ${e.message}`, null, 'error');
  }
  const list = host && host.querySelector('#risk-markets');
  if (list && S.base) list.innerHTML = [...S.base.keys()].map((k) => `<option value="${esc(k)}">`).join('');
  update();
}

function liveHtml() {
  if (!S.trend) return '<div class="faint">Checking BTC and ETH…</div>';
  if (S.trend.err) return `<div class="faint">Couldn’t check BTC and ETH right now: ${esc(S.trend.err)}</div>`;
  const card = (name, t) => `<div class="kpi"><div class="k"><span class="kt">${name}</span></div>
    <div class="v ${t.gap > 0 ? 'pos' : 'neg'}">${t.gap > 0 ? 'Above' : 'Below'}</div>
    <div class="s">${sign(t.gap * 100)} from its 50-day average</div>
    <div class="s">The rule: ${t.gap > 0 ? 'hold' : 'stay out'}</div></div>`;
  return `<div class="risk-live">${card('BTC', S.trend.btc)}${card('ETH', S.trend.eth)}</div>`;
}

function field(key, label, step = 'any') {
  return `<label class="risk-f"><span>${label}</span><input type="number" inputmode="decimal" step="${step}" data-risk="${key}" value="${esc(S.form[key])}"></label>`;
}

function page() {
  const yrs = HISTORY.years.map(([y, a, b]) => `<tr><td>${y}</td><td class="num">${signed(a)}</td><td class="num">${signed(b)}</td></tr>`).join('');
  const { to2024, from2025 } = HISTORY.periods;
  const w = HISTORY.whole;
  const months = HISTORY.months.map(([m, a, b]) => `<tr><td>${m}</td><td class="num">${signed(a)}</td><td class="num">${signed(b)}</td></tr>`).join('');
  const failed = FAILED.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="dim">${r[3]}</td></tr>`).join('');
  const methods = METHODS.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td></tr>`).join('');
  return `<div class="risk">
    <section class="card">
      <div class="card-head"><div><h2>The trend rule</h2><p>Half the money in BTC, half in ETH. Hold each only while its daily close is above its 50-day average; otherwise stay out.</p></div><span class="risk-tag warn">Not proven</span></div>
      <div id="risk-live">${liveHtml()}</div>
      <div class="risk-scroll"><table class="risk-table"><thead><tr><th></th><th>The rule</th><th>Holding both</th></tr></thead><tbody>
        ${yrs}
        <tr class="risk-sum"><td>A year, to 2024</td><td class="num">${signed(to2024.rule)}</td><td class="num">${signed(to2024.held)}</td></tr>
        <tr class="risk-sum"><td>A year, from 2025</td><td class="num">${signed(from2025.rule)}</td><td class="num">${signed(from2025.held)}</td></tr>
        <tr class="risk-sum"><td>Money grew</td><td class="num">${w.rule}x</td><td class="num">${w.held}x</td></tr>
        <tr class="risk-sum"><td>Worst fall</td><td class="num">${sign(w.ruleFall)}</td><td class="num">${sign(w.heldFall)}</td></tr>
      </tbody></table></div>
      <p class="risk-note">It beat holding in both periods, but t is 2.5 to 2024 and 1.4 from 2025, under the pass mark of 2, and from 2025 is only 22 months. Trend rules also trail holding in strong years. After real funding and 0.10% a round trip, on data to ${HISTORY.asOf}. Only new days can prove it.</p>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>When does it work?</h2><p>Does the rule do better at certain times? A pattern counts only if it shows up in both periods.</p></div></div>
      <div class="risk-scroll"><table class="risk-table"><thead><tr><th>When</th><th>2020–2024</th><th>From 2025</th><th>Result</th></tr></thead><tbody>
        <tr><td>Its 4 best months of 2020–2024: Jan, Feb, Oct, Nov</td><td class="num">${signed(12.3)} a month</td><td class="num">${signed(-2.3)} a month</td><td><span class="risk-tag bad">Didn’t repeat</span></td></tr>
        <tr><td>The other 8 months</td><td class="num">${signed(0.8)} a month</td><td class="num">${signed(4.9)} a month</td><td><span class="risk-tag bad">Didn’t repeat</span></td></tr>
        <tr><td>Wild market: BTC’s last 30 days above the usual</td><td class="num">${signed(84)} a year</td><td class="num">${signed(-12)} a year</td><td><span class="risk-tag bad">Didn’t repeat</span></td></tr>
        <tr><td>Calm market</td><td class="num">${signed(29)} a year</td><td class="num">${signed(39)} a year</td><td><span class="risk-tag warn">Not proven</span></td></tr>
      </tbody></table></div>
      <p class="risk-note">The months that were best to 2024 were not the best afterwards: their order from one period to the next has a correlation of −0.47. So on crypto, size shouldn’t follow the calendar. Wild markets from 2025 are only 75 days.</p>
      <details class="risk-more"><summary>Month by month</summary>
        <div class="risk-scroll"><table class="risk-table"><thead><tr><th>Month</th><th>2020–2024, average</th><th>From 2025, average</th></tr></thead><tbody>${months}</tbody></table></div>
      </details>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>How much to trade</h2><p>Your stop, your fees and your own numbers. Sizing limits damage; it can’t turn a losing idea into a winning one.</p></div></div>
      <div class="risk-grid">
        <div class="risk-tool"><h3>Position size</h3>
          <div class="risk-fields">
            <label class="risk-f"><span>Side</span><select data-risk="side"><option value="long"${S.form.side === 'long' ? ' selected' : ''}>Long</option><option value="short"${S.form.side === 'short' ? ' selected' : ''}>Short</option></select></label>
            <label class="risk-f"><span>Market, for the Bad day check</span><input type="text" list="risk-markets" data-risk="market" placeholder="BTCUSDT" value="${esc(S.form.market)}" autocomplete="off" spellcheck="false"></label>
            ${field('account', 'Account size')}${field('riskPct', 'Risk a trade, %')}${field('entry', 'Entry')}${field('stop', 'Stop')}${field('feePct', 'Fee a side, %')}
          </div><datalist id="risk-markets"></datalist><div class="risk-out" id="risk-size"></div></div>
        <div class="risk-tool"><h3>Break-even win rate</h3>
          <div class="risk-fields">${field('beStop', 'Stop, %')}${field('beFee', 'Fee a side, %')}${field('beFunding', 'Funding paid a day, %')}${field('beDays', 'Days held')}</div>
          <div class="risk-out" id="risk-be"></div></div>
        <div class="risk-tool"><h3>Daily loss limit</h3>
          <div class="risk-fields">${field('dayAccount', 'Account size')}${field('dayPct', 'Most to lose a day, %')}${field('dayTrade', 'Risk a trade, %')}</div>
          <div class="risk-out" id="risk-day"></div></div>
        <div class="risk-tool"><h3>Kelly</h3>
          <div class="risk-fields">${field('win', 'Win rate, %')}${field('avgWin', 'Average win')}${field('avgLoss', 'Average loss')}${field('trades', 'Trades behind these numbers')}</div>
          <button class="btn btn-sm" data-risk-act="journal">Use my Journal</button>
          <div class="risk-out" id="risk-kelly"></div></div>
      </div>
      <h3 class="risk-sub">What these methods did to the trend rule</h3>
      <div class="risk-scroll"><table class="risk-table"><thead><tr><th>Method</th><th>Money grew</th><th>Worst fall</th><th>A year, from 2025</th></tr></thead><tbody>${methods}</tbody></table></div>
      <p class="risk-note">Each one gave up return for a smaller fall. None created an edge, and halving size after a fall gave up the most for the least.</p>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Tested and failed</h2><p>So they don’t get tested again. Chosen on 2020–2024, checked from 2025, after costs.</p></div></div>
      <div class="risk-scroll"><table class="risk-table"><thead><tr><th>Idea</th><th>2020–2024</th><th>From 2025</th><th>What happened</th></tr></thead><tbody>${failed}</tbody></table></div>
      <p class="risk-note">One thing did pass: collecting BTC’s funding, long spot and short the perpetual. It’s small and shrinking: +14% a year to 2024, about +4% since.</p>
    </section>
    <p class="risk-note risk-foot">Past results, not financial advice.</p>
  </div>`;
}

const rows = (list) => `<dl class="risk-dl">${list.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join('')}</dl>`;

function sizeHtml() {
  const account = f('account'), entry = f('entry'), stop = f('stop');
  const long = S.form.side === 'long';
  if (!(account > 0 && entry > 0 && stop > 0 && f('riskPct') > 0)) return '<p class="faint">Fill in the account, risk, entry and stop.</p>';
  if (long ? stop >= entry : stop <= entry) return `<p class="neg">For a ${S.form.side}, the stop must be ${long ? 'below' : 'above'} the entry.</p>`;
  const dist = Math.abs(entry - stop) / entry;
  const cost = 2 * f('feePct') / 100;
  const risk = account * f('riskPct') / 100;
  const value = risk / (dist + cost);
  let html = rows([['Position value', num(value)], ['Quantity', num(value / entry, 6)], ['Leverage needed', `${num(value / account, 1)}x`], ['Loss at the stop, with fees', num(risk)]]);
  const m = S.base && S.base.get(S.form.market.trim().toUpperCase());
  if (m && m.history_days >= 20 && m.sd_return_30d > 0) {
    const avg = m.avg_return_30d, sd = m.sd_return_30d;
    const bad = long ? avg - 1.645 * sd : avg + 1.645 * sd;
    const chance = long ? normalBelow((-dist - avg) / sd) : 1 - normalBelow((dist - avg) / sd);
    const every = chance > 0 ? Math.max(1, Math.round(1 / chance)) : null;
    const inside = dist < Math.abs(bad);
    html += `<p class="${inside ? 'risk-warn' : 'risk-note'}">A bad day for ${esc(m.symbol)} is ${sign(bad * 100)}. ${inside ? `Your ${num(dist * 100, 1)}% stop is closer than that, so a normal bad day can hit it` : `Your ${num(dist * 100, 1)}% stop is wider than that`}${every ? `: about 1 day in ${every}, judged by its last 30 days.` : '.'}</p>`;
  } else if (S.form.market.trim() && S.base) html += `<p class="faint">No Bad day figure for ${esc(S.form.market.trim().toUpperCase())}.</p>`;
  return html;
}

function beHtml() {
  const stop = f('beStop'), cost = 2 * f('beFee') + f('beFunding') * f('beDays');
  if (!(stop > 0)) return '<p class="faint">Fill in the stop.</p>';
  const table = [1, 1.5, 2, 3].map((r) => {
    const need = (stop + cost) / (stop * (r + 1));
    return `<tr><td>${r}:1</td><td class="num">${num(100 / (r + 1), 1)}%</td><td class="num"><b>${num(need * 100, 1)}%</b></td></tr>`;
  }).join('');
  return `<div class="risk-scroll"><table class="risk-table"><thead><tr><th>Reward to risk</th><th>Before costs</th><th>After costs</th></tr></thead><tbody>${table}</tbody></table></div>
    <p class="risk-note">Costs take ${num(cost, 2)}% a trade, which is ${num(cost / stop * 100, 0)}% of your stop. A closer stop makes this share bigger.</p>`;
}

function dayHtml() {
  const account = f('dayAccount'), day = f('dayPct'), trade = f('dayTrade');
  if (!(account > 0 && day > 0 && trade > 0)) return '<p class="faint">Fill in all three.</p>';
  const n = Math.floor(day / trade + 1e-9);
  return rows([['Stop for the day at a loss of', num(account * day / 100)], ['Losing trades that takes', n ? String(n) : 'Less than 1: risk less a trade']]);
}

function kellyHtml() {
  const p = f('win') / 100, win = f('avgWin'), loss = f('avgLoss'), n = f('trades');
  if (!(p > 0 && p < 1 && win > 0 && loss > 0)) return '<p class="faint">Fill in the win rate and the average win and loss.</p>';
  const b = win / loss;
  const full = p - (1 - p) / b;
  if (full <= 0) return `<p class="risk-warn">These numbers show no edge, so Kelly says don’t bet. A ${num(b, 2)}:1 payoff needs a win rate above ${num(100 / (b + 1), 1)}%.</p>`;
  const pct = (v) => `${num(v * 100, 2)}% of the account`;
  let html = rows([['Full Kelly, risk a trade', pct(full)], ['Half', pct(full / 2)], ['Quarter', pct(full / 4)]]);
  if (n > 1) {
    const low = p - 1.96 * Math.sqrt(p * (1 - p) / n);
    const lowFull = low - (1 - low) / b;
    html += `<p class="risk-note">With ${num(n, 0)} trades the true win rate could be as low as ${num(low * 100, 1)}%. ${lowFull > 0 ? `That makes full Kelly ${num(lowFull * 100, 2)}%.` : 'At that rate there’s no edge at all.'} Betting twice full Kelly grows nothing, so most traders use a quarter to a half.</p>`;
  }
  return html;
}

function update() {
  if (!host) return;
  const put = (id, html) => { const el = host.querySelector(id); if (el) el.innerHTML = html; };
  put('#risk-size', sizeHtml());
  put('#risk-be', beHtml());
  put('#risk-day', dayHtml());
  put('#risk-kelly', kellyHtml());
}

function onInput(e) {
  const k = e.target.dataset.risk;
  if (!k) return;
  S.form[k] = e.target.value;
  api.store.set('risk', S.form);
  update();
}

function onClick(e) {
  if (!e.target.closest('[data-risk-act="journal"]')) return;
  const s = api.journal();
  if (!s || !s.n || !s.avgLoss || s.winRate == null) { api.toast('No closed trades in the Journal’s current view.', 'error'); return; }
  S.form.win = Number((s.winRate * 100).toFixed(1));
  S.form.avgWin = Number((s.avgWin || 0).toFixed(2));
  S.form.avgLoss = Number(s.avgLoss.toFixed(2));
  S.form.trades = s.n;
  api.store.set('risk', S.form);
  for (const k of ['win', 'avgWin', 'avgLoss', 'trades']) host.querySelector(`[data-risk="${k}"]`).value = S.form[k];
  update();
}

export function render(el, appApi) {
  api = appApi;
  if (host === el && el.querySelector('.risk')) return;
  host = el;
  S.form = { ...DEFAULTS, ...(api.store.get('risk', {}) || {}) };
  el.innerHTML = page();
  el.addEventListener('input', onInput);
  el.addEventListener('click', onClick);
  update();
  loadTrend();
  loadBase();
}
