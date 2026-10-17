// MEDUSA Lab "Strategy guide" tab: guides and a page for every strategy (yours too, from its docstring). The pages are HTML files in
// public/lab/docs/ (edit them like any web page). A <figure data-example="turtle" data-part="win">
// in a page becomes an interactive chart of a real trade, drawn from public/lab/docs/examples/turtle.json
// (made by running the strategy on real Binance candles).

import { esc, isNum, price, dateLocal, ymd, icon, $, $$, inrRate } from './util.js';
import { highlight } from './editor.js';

export const GUIDES = [
  ['start', 'What is backtesting?'],
  ['lab', 'How MEDUSA Lab works'],
  ['report', 'Reading the report'],
  ['data', 'Getting data'],
  ['write', 'Writing your own strategy'],
  ['python', 'The Python tab'],
  ['glossary', 'Glossary'],
];
/** How the built-in strategies are grouped (a strategy's `group` in its .py file). */
export const GROUPS = [
  ['classic', 'Classic indicators'],
  ['intraday', 'Intraday and scalping'],
  ['swing', 'Short-term swing'],
];
const BUILTIN = [
  ['ema_cross', 'EMA crossover', 'classic'],
  ['turtle', 'Turtle breakout', 'classic'],
  ['rsi_reversal', 'RSI reversal', 'classic'],
  ['macd_cross', 'MACD crossover', 'classic'],
  ['bollinger_reversion', 'Bollinger band reversion', 'classic'],
  ['buy_hold', 'Buy and hold', 'classic'],
  ['vwap_trend', 'VWAP trend', 'intraday'],
  ['vwap_reversion', 'VWAP band reversion', 'intraday'],
  ['orb', 'Opening range breakout', 'intraday'],
  ['noise_breakout', 'Noise-area breakout', 'intraday'],
  ['intraday_momentum', 'First half-hour momentum', 'intraday'],
  ['hour_seasonality', 'Bitcoin night hours', 'intraday'],
  ['candle_reversal', 'Fade the last candle', 'intraday'],
  ['supertrend', 'Supertrend', 'intraday'],
  ['macd_ema200', 'MACD + 200 EMA', 'intraday'],
  ['ma_band', 'Price vs moving average', 'intraday'],
  ['volatility_breakout', 'Volatility breakout', 'swing'],
  ['connors_rsi2', 'RSI(2) pullback', 'swing'],
  ['ttm_squeeze', 'TTM Squeeze', 'swing'],
  ['turtle_soup', 'Turtle Soup', 'swing'],
  ['max_min', 'Bitcoin 10-day high / low', 'swing'],
  ['abnormal_momentum', 'Follow an abnormal day', 'swing'],
  ['funding_fade', 'Fade extreme funding', 'swing'],
  ['ichimoku', 'Ichimoku cloud', 'swing'],
];
/** Our one-shot test of each built-in strategy with its published settings on 7 coins, 2019-2026, after
 * Lab-default costs (details on each guide page): works = profitable after costs, gross = an edge before
 * costs only, none = no edge. */
export const VERDICT = {
  turtle: 'works', ichimoku: 'works', max_min: 'works',
  ema_cross: 'gross', macd_cross: 'gross', vwap_trend: 'gross', hour_seasonality: 'gross', candle_reversal: 'gross', supertrend: 'gross',
  ma_band: 'gross', volatility_breakout: 'gross', connors_rsi2: 'gross',
  rsi_reversal: 'none', bollinger_reversion: 'none', vwap_reversion: 'none', orb: 'none', noise_breakout: 'none', intraday_momentum: 'none',
  macd_ema200: 'none', ttm_squeeze: 'none', turtle_soup: 'none', abnormal_momentum: 'none', funding_fade: 'none',
};
export const VERDICT_TEXT = { works: 'Profitable after costs in our test', gross: 'Edge before costs only', none: 'No edge in our test' };
export const verdictBadge = (key) => (VERDICT[key] ? `<span class="lab-verdict ${VERDICT[key]}">${VERDICT_TEXT[VERDICT[key]]}</span>` : '');
export const DOC_FOR = (s) => (s.origin === 'builtin' ? s.key : `mine:${s.key}`);

/* Times in the guide: the example trades carry ⟨t:ms⟩ / ⟨d:ms⟩ tokens, shown in your time zone, and a rule's
   "21:00 UTC" gets your local time next to it (strategy rules are defined in UTC, like exchange candles). */
const two = (n) => String(n).padStart(2, '0');
function utcToLocal(h, m) {
  const d = new Date();
  d.setUTCHours(Number(h), Number(m), 0, 0);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function localize(text) {
  let out = String(text ?? '').replace(/⟨t:(\d+)⟩/g, (_, ms) => dateLocal(Number(ms), true)).replace(/⟨d:(\d+)⟩/g, (_, ms) => dateLocal(Number(ms)));
  if (new Date().getTimezoneOffset() !== 0) {
    out = out.replace(/\b(\d{1,2}):(\d{2})(?:[–-](\d{1,2}):(\d{2}))? UTC\b/g,
      (all, h, m, h2, m2) => `${all} (${utcToLocal(h, m)}${h2 ? `–${utcToLocal(h2, m2)}` : ''} your time)`);
  }
  return out;
}

const pages = new Map();
const examples = new Map();
async function page(id) {
  if (!pages.has(id)) pages.set(id, fetch(`/lab/docs/${id}.html`).then((r) => { if (!r.ok) throw new Error('missing'); return r.text(); }));
  return pages.get(id);
}
async function example(key) {
  if (!examples.has(key)) examples.set(key, fetch(`/lab/docs/examples/${key}.json`).then((r) => r.json()));
  return examples.get(key);
}

export function renderLearn(host, { doc, catalog }) {
  let anchor = '';
  [doc, anchor = ''] = String(doc || '').split('#');     // "python#load": a section of a page
  const mine = catalog.strategies.filter((s) => s.origin === 'mine');
  const ids = new Set([...GUIDES.map((g) => g[0]), ...BUILTIN.map((b) => b[0]), ...mine.map((s) => `mine:${s.key}`)]);
  if (!ids.has(doc)) doc = doc && doc.startsWith('mine:') && !catalog.strategies.length ? doc : 'start';
  const link = (id, label) => `<button class="lab-doclink" data-lab="doc" data-doc="${esc(id)}" aria-current="${id === doc ? 'page' : 'false'}">${esc(label)}</button>`;
  host.innerHTML = `<div class="lab-learn">
    <nav class="card lab-docnav" aria-label="Lab guides">
      <div class="lab-docgroup">Getting started</div>${GUIDES.map(([id, l]) => link(id, l)).join('')}
      ${GROUPS.map(([g, title]) => `<div class="lab-docgroup">${esc(title)}</div>${BUILTIN.filter((b) => b[2] === g).map(([id, l]) => link(id, l)).join('')}`).join('')}
      ${mine.length ? `<div class="lab-docgroup">My strategies</div>${mine.map((s) => link(`mine:${s.key}`, s.label)).join('')}` : ''}
    </nav>
    <article class="card lab-doc" id="lab-doc"><p class="dim"><span class="spin"></span> Loading…</p></article>
  </div>`;
  const art = $('#lab-doc', host);
  if (doc.startsWith('mine:')) {
    const s = catalog.strategies.find((x) => `mine:${x.key}` === doc);
    art.innerHTML = s ? mineDoc(s) : '<p class="dim">Loading your strategies…</p>';
    return;
  }
  page(doc).then((html) => {
    art.innerHTML = localize(html);
    // wide tables scroll sideways on a phone instead of widening the page
    art.querySelectorAll('table').forEach((t) => {
      if (t.parentElement.classList.contains('lab-scroll')) return;
      const box = document.createElement('div');
      box.className = 'lab-scroll';
      t.replaceWith(box);
      box.append(t);
    });
    for (const fig of $$('figure[data-example]', art)) drawExample(fig);
    for (const pre of $$('pre.py', art)) pre.innerHTML = highlight(pre.textContent);
    art.scrollTop = 0;
    const target = anchor && art.querySelector(`#${CSS.escape(anchor)}`);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }).catch(() => { art.innerHTML = '<p class="dim">This page couldn’t be loaded. Check your connection and try again.</p>'; });
}

function mineDoc(s) {
  const doc = (s.doc || '').trim();
  const paras = doc ? doc.split(/\n\s*\n/).map((p) => `<p class="lab-pre-text">${esc(p)}</p>`).join('') : '<p class="dim">This file has no description yet. Put one in a string at the very top of the file (see the template) and it shows here.</p>';
  return `<h1>${esc(s.label)}</h1>
    <p class="lead">${esc(s.description || '')}</p>
    <p class="faint small">Your strategy · file ${esc(s.name)} · key <code>${esc(s.key.split(':').pop())}</code></p>
    ${paras}
    <h2>Settings</h2>
    <div class="lab-scroll"><table class="lab-table kv"><thead><tr><th>Setting</th><th>Default</th><th>Range</th></tr></thead><tbody>
    ${s.params.map((p) => `<tr><td>${esc(p.label)}${p.help ? `<br><span class="faint small">${esc(p.help)}</span>` : ''}</td><td>${esc(p.kind === 'choice' ? ((p.choices || []).find((c) => c[0] === p.default) || [0, p.default])[1] : String(p.default))}</td><td>${p.kind === 'choice' ? esc((p.choices || []).map((c) => c[1]).join(', ')) : p.kind === 'bool' ? 'on / off' : `${isNum(p.min) ? p.min : ''} – ${isNum(p.max) ? p.max : ''}`}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="row-btns" style="margin-top:16px"><button class="btn btn-green" data-lab="try" data-strategy="${esc(s.key)}">${icon('play')}Backtest it</button><button class="btn" data-lab="edit-strategy" data-id="${esc(s.id)}">${icon('edit')}Edit the code</button></div>`;
}

/* ---------- example charts ---------- */

async function drawExample(fig) {
  const key = fig.dataset.example, part = fig.dataset.part || 'main';
  fig.innerHTML = '<div class="doc-chart"><p class="faint small">Loading the example…</p></div>';
  let ex;
  try { ex = (await example(key))[part]; } catch { ex = null; }
  if (!ex) { fig.innerHTML = '<p class="faint small">Example not available.</p>'; return; }
  const legend = [...(ex.lines || []).map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`),
    ...(ex.bands ? [`<span><i class="band"></i>${esc(ex.bands.label)}</span>`] : []),
    ...(ex.panel ? ex.panel.lines.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`) : []),
    '<span><i class="tri-up"></i>long entry</span><span><i class="tri-down"></i>short entry</span><span><i class="dash red"></i>stop</span><span><i class="dash green"></i>target</span>'];
  fig.innerHTML = `<div class="doc-chart"><div class="doc-svg"></div><div class="lab-tip" hidden></div></div>
    <div class="legend doc-legend">${legend.join('')}</div>
    ${ex.caption ? `<figcaption class="dim small">${esc(localize(ex.caption))}</figcaption>` : ''}
    ${ex.marks && ex.marks.length ? `<ol class="doc-marks">${ex.marks.map((m) => `<li>${esc(localize(m.text))}</li>`).join('')}</ol>` : ''}
    ${ex.steps && ex.steps.length ? `<div class="lab-scroll"><table class="lab-table doc-steps"><thead><tr><th>Step</th><th>Numbers (USDT)</th></tr></thead><tbody>${ex.steps.map(([a, b]) => `<tr><td>${esc(localize(a))}</td><td>${esc(localize(b))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  const box = $('.doc-svg', fig), tip = $('.lab-tip', fig);
  const draw = () => { const { html, geo } = svg(ex, box.clientWidth || 640); box.innerHTML = html; $('svg', box).__geo = geo; };
  draw();
  let w = box.clientWidth;
  new ResizeObserver(() => { if (box.clientWidth !== w && box.clientWidth) { w = box.clientWidth; draw(); } }).observe(box);
  const move = (e) => {
    const s = $('svg', box);
    if (!s) return;
    const r = s.getBoundingClientRect();
    const g = s.__geo;
    const i = Math.round((e.clientX - r.left - g.l) / g.cw - 0.5);
    $$('.doc-cross', s).forEach((n) => n.remove());
    if (i < 0 || i >= ex.t.length) { tip.hidden = true; return; }
    const x = g.l + (i + 0.5) * g.cw;
    s.insertAdjacentHTML('beforeend', `<line class="doc-cross" x1="${x}" x2="${x}" y1="0" y2="${g.h}"/>`);
    const vals = [...(ex.lines || []).map((l) => [l.label, l.v[i], l.color]), ...(ex.panel ? ex.panel.lines.map((l) => [l.label, l.v[i], l.color]) : [])];
    tip.innerHTML = `<b>${dateLocal(ex.t[i], true)}</b>O ${price(ex.o[i])} · H ${price(ex.h[i])}<br>L ${price(ex.l[i])} · C ${price(ex.c[i])}${
      vals.filter((v) => isNum(v[1])).map(([l, v, c]) => `<br><span style="color:${c}">${esc(l)}</span> ${ex.panel && ex.panel.lines.some((p) => p.label === l) ? v.toFixed(2) : price(v)}`).join('')}`;
    tip.hidden = false;
    const bw = fig.clientWidth;
    tip.style.left = Math.max(4, Math.min(e.clientX - r.left + 14, bw - tip.offsetWidth - 4)) + 'px';
    tip.style.top = '8px';
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerdown', move);
  box.addEventListener('pointerleave', () => { tip.hidden = true; $$('.doc-cross', box).forEach((n) => n.remove()); });
}

function svg(ex, W) {
  const n = ex.t.length;
  const panelH = ex.panel ? 110 : 0;
  const H = 320 + panelH;
  const P = { l: 8, r: 66, t: 14, b: 24 };
  const mainH = 320 - P.t - 8;
  const cw = (W - P.l - P.r) / n;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, ex.l[i]); hi = Math.max(hi, ex.h[i]); }
  for (const l of ex.lines || []) for (const v of l.v) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (ex.bands) for (const v of [...ex.bands.upper, ...ex.bands.lower]) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const t of ex.trades || []) for (const v of [t.stop, t.tp]) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.07;
  lo -= pad; hi += pad;
  const X = (i) => P.l + (i + 0.5) * cw;
  const Y = (v) => P.t + ((hi - v) / (hi - lo)) * mainH;
  const out = [];
  // grid + price axis
  const fx = inrRate() || 1;                       // round prices in the currency shown
  const step = niceStep(((hi - lo) * fx) / 5) / fx;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    out.push(`<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${W - P.r + 6}" y="${Y(v) + 4}">${price(v)}</text>`);
  }
  // date labels
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 110))));
  for (let i = 0; i < n; i += every) out.push(`<text class="tick" x="${X(i) - 16}" y="${H - 6}">${ymd(ex.t[i]).slice(5)}</text>`);
  // bands
  if (ex.bands) {
    const up = ex.bands.upper.map((v, i) => (isNum(v) ? [X(i), Y(v)] : null)).filter(Boolean);
    const dn = ex.bands.lower.map((v, i) => (isNum(v) ? [X(i), Y(v)] : null)).filter(Boolean).reverse();
    if (up.length) out.push(`<path class="doc-band" d="M${[...up, ...dn].map((p) => p.join(',')).join('L')}Z"/>`);
  }
  // trade shading, stop and target
  for (const t of ex.trades || []) {
    const x0 = X(t.ei) - cw / 2, x1 = X(Math.min(n - 1, t.xi)) + cw / 2;
    out.push(`<rect class="doc-held ${t.pnl >= 0 ? 'win' : 'loss'}" x="${x0}" y="${P.t}" width="${Math.max(2, x1 - x0)}" height="${mainH}"/>`);
    if (isNum(t.stop)) out.push(`<line class="lv lv-sl" x1="${x0}" x2="${x1}" y1="${Y(t.stop)}" y2="${Y(t.stop)}"/><text class="doc-lvl red" x="${x1 + 3}" y="${Y(t.stop) + 4}">stop</text>`);
    if (isNum(t.tp)) out.push(`<line class="lv lv-tp" x1="${x0}" x2="${x1}" y1="${Y(t.tp)}" y2="${Y(t.tp)}"/><text class="doc-lvl green" x="${x1 + 3}" y="${Y(t.tp) + 4}">target</text>`);
  }
  // candles
  for (let i = 0; i < n; i++) {
    const up = ex.c[i] >= ex.o[i];
    const bw = Math.max(1, cw * 0.66);
    out.push(`<line class="doc-wick ${up ? 'up' : 'down'}" x1="${X(i)}" x2="${X(i)}" y1="${Y(ex.h[i])}" y2="${Y(ex.l[i])}"/><rect class="doc-body ${up ? 'up' : 'down'}" x="${X(i) - bw / 2}" y="${Math.min(Y(ex.o[i]), Y(ex.c[i]))}" width="${bw}" height="${Math.max(1, Math.abs(Y(ex.o[i]) - Y(ex.c[i])))}"/>`);
  }
  // indicator lines
  const path = (vals, Yf) => { let d = '', on = false; vals.forEach((v, i) => { if (isNum(v)) { d += (on ? 'L' : 'M') + X(i).toFixed(1) + ',' + Yf(v).toFixed(1); on = true; } else on = false; }); return d; };
  for (const l of ex.lines || []) out.push(`<path class="doc-line" d="${path(l.v, Y)}" stroke="${l.color}"${l.dash ? ' stroke-dasharray="5 4"' : ''}/>`);
  // entries and exits
  for (const t of ex.trades || []) {
    const ex0 = X(t.ei), ey = Y(t.ep);
    out.push(t.side > 0 ? `<path class="doc-tri up" d="M${ex0},${ey + 3}l-6,11h12z"/>` : `<path class="doc-tri down" d="M${ex0},${ey - 3}l-6,-11h12z"/>`);
    if (t.xi < n) out.push(`<circle class="doc-exit ${t.pnl >= 0 ? 'win' : 'loss'}" cx="${X(t.xi)}" cy="${Y(t.xp)}" r="4.5"/>`);
    out.push(`<line class="doc-path ${t.pnl >= 0 ? 'win' : 'loss'}" x1="${ex0}" y1="${ey}" x2="${X(Math.min(n - 1, t.xi))}" y2="${Y(t.xp)}"/>`);
  }
  // numbered marks
  (ex.marks || []).forEach((m, k) => {
    const i = Math.max(0, Math.min(n - 1, m.i));
    const above = m.pos !== 'below';
    const y = above ? Y(ex.h[i]) - 16 : Y(ex.l[i]) + 16;
    out.push(`<circle class="doc-mark" cx="${X(i)}" cy="${Math.max(P.t + 8, Math.min(P.t + mainH - 8, y))}" r="9"/><text class="doc-mark-n" x="${X(i)}" y="${Math.max(P.t + 8, Math.min(P.t + mainH - 8, y)) + 4}">${k + 1}</text>`);
  });
  // lower panel (RSI / MACD)
  if (ex.panel) {
    const p = ex.panel, top = 320 + 4, ph = panelH - 30;
    let plo = isNum(p.min) ? p.min : Infinity, phi = isNum(p.max) ? p.max : -Infinity;
    if (!isNum(p.min) || !isNum(p.max)) for (const l of p.lines) for (const v of l.v) if (isNum(v)) { plo = Math.min(plo, v); phi = Math.max(phi, v); }
    if (p.hist) for (const v of p.hist) if (isNum(v)) { plo = Math.min(plo, v); phi = Math.max(phi, v); }
    const span = phi - plo || 1;
    const PY = (v) => top + ((phi - v) / span) * ph;
    out.push(`<rect class="doc-panel" x="${P.l}" y="${top}" width="${W - P.l - P.r}" height="${ph}"/><text class="tick" x="${P.l + 4}" y="${top + 12}">${esc(p.label)}</text>`);
    for (const lv of p.levels || []) out.push(`<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${PY(lv)}" y2="${PY(lv)}" stroke-dasharray="3 3"/><text class="tick" x="${W - P.r + 6}" y="${PY(lv) + 4}">${lv}</text>`);
    if (p.hist) {
      const z = PY(0);
      p.hist.forEach((v, i) => { if (isNum(v)) out.push(`<rect class="${v >= 0 ? 'doc-hist up' : 'doc-hist down'}" x="${X(i) - cw * 0.33}" y="${Math.min(z, PY(v))}" width="${Math.max(1, cw * 0.66)}" height="${Math.abs(PY(v) - z)}"/>`); });
    }
    for (const l of p.lines) out.push(`<path class="doc-line" d="${path(l.v, PY)}" stroke="${l.color}"/>`);
  }
  const html = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(localize(ex.title || 'Example chart'))}">${out.join('')}</svg>`;
  return { html, geo: { l: P.l, cw, h: H } };
}

function niceStep(raw) {
  const m = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].find((f) => f * m >= raw) * m;
}
