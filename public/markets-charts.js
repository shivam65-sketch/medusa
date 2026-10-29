// MEDUSA Markets: graphs drawn from a query's result (the Insights view, lakehouse step 32).
//
// A graph is a definition like any number on the Markets page: SQL that runs in the browser's SQL
// engine, and a display that says how to show its result. The display's `chart` names the columns:
//
//   type   bar      x: a category column; y: one column, or several (one series each)
//          line     x: an ordered column (a day, a year); y: one column or several
//          scatter  x and y: number columns; color: a category column; label: the point's name
//          heatmap  x and y: category columns; value: the number that colours the cell; text: what the
//                   cell says (optional); scale: 'x' gives each column its own colour scale (when the
//                   columns differ in size, like the next 1 hour against the next 24); faint: a
//                   column that is 1 where a cell is too thin to judge, which is then drawn grey
//   unit   how y (or a heatmap's value) is written: '%' (the query returns percent, so 1.5 is 1.5%),
//          'bp' (basis points) or '' (a plain number)
//   sign   bar with one series: colour each bar by its sign (blue above zero, red below); or a
//          column's name, to colour by that column's sign instead (a histogram's bucket)
//   pos_label, neg_label  what the two colours mean, for the legend
//   ylog   scatter: a logarithmic y axis (for ratios such as volume against a usual day)
//   colors scatter: {category value: slot}, slot 0-2 for the series colours or 'muted'
//   tip    more columns for the details shown on hover
//   drill  {panel, set: {parameter: column}}: a click opens that window with the parameters taken from
//          the row clicked (the graph's year, hour, size band ...), each a new page of its own
//
// Everything is drawn as SVG text here, from the result only, so a graph changes whenever its query's
// result does (a new price, a new day from the lakehouse, an edited query). Hover (or keyboard focus)
// shows a mark's details; every graph can also be read as a table under it.

// The series colours, checked for colour blindness and contrast on MEDUSA's dark cards: blue, orange,
// aqua. Above zero blue, below zero red (two hues that read as opposite).
const SERIES = ['#3987e5', '#d95926', '#199e70'];
const MUTED = '#6b6b70';
const POS = '#3987e5', NEG = '#e66767', MID = [56, 56, 53];
const INK = { text: '#b4b4b8', faint: '#8b8b91', grid: '#333333', base: '#4a4a4a', surface: '#252525' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const objects = (res) => res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** A number as an axis or a hover writes it, in the graph's unit. */
export function fmtUnit(v, unit, digits = null) {
  if (v == null) return '–';
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (unit === '%') return `${s}${a.toFixed(digits ?? (a >= 10 ? 1 : 2))}%`;
  if (unit === 'bp') return `${s}${a.toFixed(digits ?? 1)} bp`;
  return `${v < 0 ? '−' : ''}${a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toLocaleString('en-US', { maximumFractionDigits: digits ?? 2 })}`;
}

/** Round tick values covering [lo, hi]: steps of 1, 2 or 5 times a power of ten. */
function ticks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return { list: out, lo: Math.min(lo, out[0]), hi: Math.max(hi, out[out.length - 1]) };
}

/** A bar with a rounded end where its value is and a square end on the baseline. */
function barPath(x, w, base, end) {
  const r = Math.min(4, w / 2, Math.abs(end - base));
  const d = end < base ? 1 : -1;   // up: the rounded end is at the top
  return `M${x},${base}V${end + d * r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + d * r}V${base}Z`;
}

/** A row's details for hover: the values first, then what they are. */
function tipHtml(title, lines) {
  return `<b>${esc(title)}</b>${lines.map(([value, label, color]) => `<div>${color ? `<i style="background:${color}"></i>` : ''}<span class="v">${value}</span> <span class="l">${esc(label)}</span></div>`).join('')}`;
}

/** A mark's details as plain words, for screen readers (and the same as its hover). */
const plain = (html) => html.replace(/<\/(b|div)>/g, '. ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const hitAttrs = (tip, spec) => `tabindex="0" role="${spec.drill ? 'button' : 'img'}" aria-label="${esc(plain(tip))}" data-tip="${esc(tip)}"`;

/** What a click on a mark opens: data attributes, or nothing when the graph has no drill. */
export function drillAttrs(spec, row) {
  const d = spec.drill;
  if (!d || !d.panel) return '';
  const set = {};
  for (const [param, col] of Object.entries(d.set || {})) set[param] = row[col] ?? null;
  return ` data-mkt="drill" data-panel="${esc(d.panel)}" data-p="${esc(JSON.stringify(set))}"`;
}

/** A diverging colour for a heatmap value: grey at zero, blue above, red below, stronger further out. */
function diverge(v, max) {
  if (v == null) return { fill: '#2c2c2c', ink: INK.faint };
  const t = Math.min(1, Math.abs(v) / (max || 1)) ** 0.8;
  const pole = (v >= 0 ? POS : NEG).match(/\w\w/g).map((h) => parseInt(h, 16));
  const c = MID.map((m, i) => Math.round(m + (pole[i] - m) * t));
  return { fill: `rgb(${c.join(',')})`, ink: t > 0.55 ? '#ffffff' : '#e4e4e7' };
}

/* ---------- the kinds of graph ---------- */

function bars(res, spec, ctx) {
  const rows = objects(res), ys = list(spec.y), unit = spec.unit ?? '';
  const W = ctx.width, H = 240, m = { l: 52, r: 8, t: 12, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const vals = rows.flatMap((r) => ys.map((y) => num(r[y]))).filter((v) => v != null);
  const t = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
  const Y = (v) => m.t + ph - ((v - t.lo) / (t.hi - t.lo)) * ph;
  const band = pw / Math.max(1, rows.length);
  const bw = Math.max(2, Math.min(24, (band * 0.72 - 2 * (ys.length - 1)) / ys.length));
  const group = bw * ys.length + 2 * (ys.length - 1);
  const every = Math.max(1, Math.ceil(30 / band));   // x labels that would touch are thinned out
  const colorOf = (y, v, r) => {
    if (ys.length > 1 || !spec.sign) return SERIES[ys.indexOf(y) % SERIES.length];
    const by = typeof spec.sign === 'string' ? num(r[spec.sign]) : v;
    return by < 0 ? NEG : POS;
  };
  let out = t.list.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? INK.base : INK.grid}" stroke-width="1"/>
    <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tk">${esc(fmtUnit(v, unit, Math.abs(t.list[1] - t.list[0]) < 1 && unit !== 'bp' ? 1 : 0))}</text>`).join('');
  rows.forEach((r, i) => {
    const x0 = m.l + i * band + (band - group) / 2;
    ys.forEach((y, j) => {
      const v = num(r[y]);
      if (v == null) return;
      out += `<path d="${barPath(x0 + j * (bw + 2), bw, Y(0), Y(v))}" fill="${colorOf(y, v, r)}"/>`;
    });
    // Every few labels, always the last, and none so close to the last that they would touch.
    const last = i === rows.length - 1, spaced = i % every === 0 && rows.length - 1 - i >= every;
    if (last || spaced) out += `<text x="${m.l + i * band + band / 2}" y="${H - 10}" text-anchor="middle" class="tk">${esc(r[spec.x])}</text>`;
    const tip = tipHtml(`${ctx.label(spec.x)}: ${r[spec.x]}`, [
      ...ys.map((y) => [esc(fmtUnit(num(r[y]), unit)), ctx.label(y), colorOf(y, num(r[y]), r)]),
      ...list(spec.tip).map((c) => [ctx.cell(c, r), ctx.label(c)]),
    ]);
    out += `<rect class="hit" x="${m.l + i * band}" y="${m.t}" width="${band}" height="${ph}" ${hitAttrs(tip, spec)}${drillAttrs(spec, r)}/>`;
  });
  return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(ctx.name)}">${out}</svg>`, legend: ys.length > 1 || spec.sign ? legend(ys.length > 1 ? ys.map((y, j) => [SERIES[j % SERIES.length], ctx.label(y)]) : [[POS, spec.pos_label || 'Above zero'], [NEG, spec.neg_label || 'Below zero']]) : '' };
}

function lines(res, spec, ctx) {
  const rows = objects(res), ys = list(spec.y), unit = spec.unit ?? '';
  const W = ctx.width, H = 240, m = { l: 52, r: 12, t: 12, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const vals = rows.flatMap((r) => ys.map((y) => num(r[y]))).filter((v) => v != null);
  const t = ticks(Math.min(...vals, spec.zero ? 0 : Infinity), Math.max(...vals, spec.zero ? 0 : -Infinity));
  const Y = (v) => m.t + ph - ((v - t.lo) / (t.hi - t.lo)) * ph;
  const X = (i) => m.l + (rows.length < 2 ? pw / 2 : (i / (rows.length - 1)) * pw);
  let out = t.list.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? INK.base : INK.grid}" stroke-width="1"/>
    <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tk">${esc(fmtUnit(v, unit, 0))}</text>`).join('');
  ys.forEach((y, j) => {
    const pts = rows.map((r, i) => (num(r[y]) == null ? null : `${X(i).toFixed(1)},${Y(num(r[y])).toFixed(1)}`)).filter(Boolean);
    out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${SERIES[j % SERIES.length]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(pw / 70))));
  rows.forEach((r, i) => {
    if (i % every === 0 || i === rows.length - 1) out += `<text x="${X(i)}" y="${H - 10}" text-anchor="middle" class="tk">${esc(r[spec.x])}</text>`;
    const w = rows.length < 2 ? pw : pw / (rows.length - 1);
    const tip = tipHtml(String(r[spec.x]), [...ys.map((y, j) => [esc(fmtUnit(num(r[y]), unit)), ctx.label(y), SERIES[j % SERIES.length]]), ...list(spec.tip).map((c) => [ctx.cell(c, r), ctx.label(c)])]);
    out += `<rect class="hit" x="${X(i) - w / 2}" y="${m.t}" width="${w}" height="${ph}" ${hitAttrs(tip, spec)}${drillAttrs(spec, r)}/>`;
  });
  return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(ctx.name)}">${out}</svg>`, legend: ys.length > 1 ? legend(ys.map((y, j) => [SERIES[j % SERIES.length], ctx.label(y)], 'line')) : '' };
}

function scatter(res, spec, ctx) {
  const rows = objects(res).filter((r) => num(r[spec.x]) != null && num(r[spec.y]) != null && (!spec.ylog || num(r[spec.y]) > 0));
  const W = ctx.width, H = 300, m = { l: 52, r: 12, t: 12, b: 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xs = rows.map((r) => num(r[spec.x])), yv = rows.map((r) => num(r[spec.y]));
  const tx = ticks(Math.min(0, ...xs), Math.max(0, ...xs), 8);
  const X = (v) => m.l + ((v - tx.lo) / (tx.hi - tx.lo)) * pw;
  let Y, ytk;
  if (spec.ylog) {
    const lo = Math.log10(Math.max(0.1, Math.min(...yv, 0.5))), hi = Math.log10(Math.max(...yv, 2));
    Y = (v) => m.t + ph - ((Math.log10(v) - lo) / (hi - lo)) * ph;
    ytk = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].filter((v) => Math.log10(v) >= lo - 1e-9 && Math.log10(v) <= hi + 1e-9);
  } else {
    const ty = ticks(Math.min(...yv), Math.max(...yv));
    Y = (v) => m.t + ph - ((v - ty.lo) / (ty.hi - ty.lo)) * ph;
    ytk = ty.list;
  }
  const slot = (r) => { const s = (spec.colors || {})[r[spec.color]]; return s === 'muted' || s == null ? MUTED : SERIES[s % SERIES.length]; };
  let out = ytk.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${spec.ylog && v === 1 ? INK.base : INK.grid}" stroke-width="1"/>
    <text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end" class="tk">${esc(spec.ylog ? `×${v}` : fmtUnit(v, spec.unit ?? '', 0))}</text>`).join('');
  out += tx.list.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ph}" stroke="${v === 0 ? INK.base : INK.grid}" stroke-width="1"/>
    <text x="${X(v)}" y="${H - 16}" text-anchor="middle" class="tk">${esc(fmtUnit(v, spec.xunit ?? '', 0))}</text>`).join('');
  out += `<text x="${m.l + pw / 2}" y="${H - 2}" text-anchor="middle" class="ax">${esc(ctx.label(spec.x))}</text>`;
  // The muted points first, so the coloured ones are drawn over them.
  const order = [...rows].sort((a, b) => (slot(a) === MUTED ? 0 : 1) - (slot(b) === MUTED ? 0 : 1));
  for (const r of order) {
    const cx = X(num(r[spec.x])).toFixed(1), cy = Y(num(r[spec.y])).toFixed(1);
    const tip = tipHtml(String(r[spec.label] ?? ''), [[ctx.cell(spec.x, r), ctx.label(spec.x)], [ctx.cell(spec.y, r), ctx.label(spec.y)], ...list(spec.tip).map((c) => [ctx.cell(c, r), ctx.label(c)])]);
    out += `<g${drillAttrs(spec, r)}><circle cx="${cx}" cy="${cy}" r="4.5" fill="${slot(r)}" stroke="${INK.surface}" stroke-width="2"/><circle class="hit" cx="${cx}" cy="${cy}" r="11" ${hitAttrs(tip, spec)}/></g>`;
  }
  const keys = Object.entries(spec.colors || {}).map(([k, s]) => [s === 'muted' ? MUTED : SERIES[s % SERIES.length], k]);
  return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(ctx.name)}">${out}</svg>`, legend: keys.length ? legend(keys, 'dot') : '' };
}

function heatmap(res, spec, ctx) {
  const rows = objects(res), unit = spec.unit ?? '';
  const xs = [...new Set(rows.map((r) => r[spec.x]))], ys = [...new Set(rows.map((r) => r[spec.y]))];
  const at = new Map(rows.map((r) => [`${r[spec.x]}\u0000${r[spec.y]}`, r]));
  const longest = Math.max(...ys.map((y) => String(y).length));
  const W = ctx.width, m = { l: Math.min(190, 14 + longest * 7), r: 4, t: 26, b: 4 };
  const cw = (W - m.l - m.r) / Math.max(1, xs.length), ch = 30, H = m.t + ys.length * ch + m.b;
  // The colour scale reaches its strongest at the 90th percentile of the sizes, so one or two extreme
  // cells don't wash the rest out to grey; beyond it a cell is as strong as it gets. With scale 'x',
  // each column has its own.
  const faint = (r) => Boolean(spec.faint) && Number(r[spec.faint]) === 1;
  const top = (list) => {
    const sizes = list.filter((r) => !faint(r)).map((r) => Math.abs(num(r[spec.value]) ?? 0)).sort((a, b) => a - b);
    return Math.max(sizes[Math.floor(0.9 * (sizes.length - 1))] || sizes[sizes.length - 1] || 0, 1e-9);
  };
  const max = top(rows);
  const maxOf = new Map(xs.map((x) => [x, spec.scale === 'x' ? top(rows.filter((r) => r[spec.x] === x)) : max]));
  let out = xs.map((x, i) => `<text x="${m.l + i * cw + cw / 2}" y="16" text-anchor="middle" class="tk">${esc(x)}</text>`).join('');
  ys.forEach((y, j) => {
    out += `<text x="${m.l - 8}" y="${m.t + j * ch + ch / 2 + 4}" text-anchor="end" class="tk">${esc(y)}</text>`;
    xs.forEach((x, i) => {
      const r = at.get(`${x}\u0000${y}`);
      if (!r) return;
      const v = num(r[spec.value]), c = faint(r) ? diverge(null) : diverge(v, maxOf.get(x));
      const label = spec.text ? r[spec.text] : fmtUnit(v, unit);
      const fits = String(label ?? '').length * 6.6 + 10 < cw;
      out += `<rect x="${m.l + i * cw + 1}" y="${m.t + j * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${c.fill}"/>`;
      if (fits && label != null) out += `<text x="${m.l + i * cw + cw / 2}" y="${m.t + j * ch + ch / 2 + 4}" text-anchor="middle" class="cv" fill="${c.ink}">${esc(label)}</text>`;
      const tip = tipHtml(`${y} · ${x}`, [[esc(fmtUnit(v, unit)), ctx.label(spec.value)], ...list(spec.tip).map((col) => [ctx.cell(col, r), ctx.label(col)])]);
      out += `<rect class="hit" x="${m.l + i * cw}" y="${m.t + j * ch}" width="${cw}" height="${ch}" ${hitAttrs(tip, spec)}${drillAttrs(spec, r)}/>`;
    });
  });
  const bar = `<i style="background:linear-gradient(90deg, ${NEG}, rgb(${MID.join(',')}), ${POS})"></i>`;
  const scale = spec.scale === 'x'
    ? `<span class="mkt-scale"><span>below zero</span>${bar}<span>above zero</span> <span class="faint">${esc(ctx.label(spec.value))}; stronger is further from zero within each column</span></span>`
    : `<span class="mkt-scale"><span>${esc(fmtUnit(-max, unit))} or less</span>${bar}<span>${esc(fmtUnit(max, unit))} or more</span> <span class="faint">${esc(ctx.label(spec.value))}</span></span>`;
  return { svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(ctx.name)}">${out}</svg>`, legend: `<div class="mkt-legend-row">${scale}</div>` };
}

function legend(keys, mark = 'bar') {
  return `<div class="mkt-legend-row">${keys.map(([c, l]) => `<span><i class="${mark}" style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`;
}

const KINDS = { bar: bars, line: lines, scatter, heatmap };

/** What a graph's display needs from its query: the columns its chart names. */
export function chartColumns(spec) {
  return [...new Set([spec.x, ...list(spec.y), spec.value, spec.text, spec.color, spec.label, spec.faint,
    typeof spec.sign === 'string' ? spec.sign : null, ...list(spec.tip),
    ...Object.values((spec.drill && spec.drill.set) || {})].filter(Boolean))];
}

/** A graph from a query's result. `ctx`: {width, name, label(column), cell(column, row)}. */
export function chartHtml(res, spec, ctx) {
  const draw = KINDS[spec.type];
  if (!draw) return `<div class="mkt-empty">This graph's type (${esc(spec.type)}) isn't one the page draws: bar, line, scatter or heatmap.</div>`;
  const missing = chartColumns(spec).filter((c) => !res.columns.includes(c));
  if (missing.length) return `<div class="mkt-empty">The query doesn't return ${missing.map((c) => `<code>${esc(c)}</code>`).join(', ')}, which this graph draws.</div>`;
  if (!res.rows.length) return '<div class="mkt-empty">The query returned no rows, so there is nothing to draw.</div>';
  const { svg, legend: key } = draw(res, spec, ctx);
  return `<div class="mkt-chart${spec.drill ? ' drill' : ''}">${svg}</div>${key}`;
}
