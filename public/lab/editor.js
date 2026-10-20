// MEDUSA Lab's code editor for the Python tab. It wraps the plain <textarea> (so typing, undo, selection and
// the browser's own keys stay native) with a coloured copy of the code behind it, line numbers, mistakes
// marked as you type, and suggestions for names: load() and a data file's .c .t …, backtest results,
// numpy, pandas, matplotlib and MEDUSA's indicators.
//
// Mistakes come from two checks: a quick one here on every key (brackets, quotes, colons, indentation,
// unknown attributes of a data file, load("name") of a file that isn't ticked), and Python's own compiler
// once Python has started in the tab's background thread (exact, but only the first error).
//
// Keys: Ctrl+/ (⌘/ on a Mac) comments the selected lines out or back in, Tab and Shift+Tab indent them
// (Esc then Tab leaves the editor, like any other field). Ctrl+Z undoes them like typing.

import { esc } from './util.js';

const KEYWORDS = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const CONSTS = new Set(['True', 'False', 'None']);
const BUILTINS = new Set(('abs all any bin bool bytearray bytes callable chr classmethod complex dict dir divmod enumerate eval exec filter float format frozenset '
  + 'getattr globals hasattr hash help hex id int isinstance issubclass iter len list locals map max min next object oct open ord pow print property range '
  + 'repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip Exception ValueError TypeError KeyError IndexError '
  + 'ZeroDivisionError RuntimeError StopIteration AttributeError NameError AssertionError ImportError NotImplementedError').split(' '));
const BLOCK = new Set(['if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', 'finally', 'with']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/* ---------- what MEDUSA's names are (suggestions, hints and the attribute check) ---------- */

const f = (sig, doc) => ({ kind: 'fn', sig, doc });
const a = (doc) => ({ kind: 'attr', doc });

export const MEDUSA = {
  load: f('load(name=None)', 'An attached data file as a Data object: .t .o .h .l .c .v arrays, .df() … With one file ticked, load() is enough.'),
  files: f('files()', 'The names of the attached files, e.g. ["BTCUSDT-futures-4h"].'),
  local_time: f('local_time(ms)', 'Milliseconds since 1970 (UTC), e.g. data.t, as numpy dates in your time zone.'),
  backtest: f('backtest(strategy, data=None, **settings)', 'Runs a built-in strategy ("turtle" …) or your Strategy class on the Dashboard’s engine. Returns a Result.'),
  Strategy: { kind: 'class', sig: 'class Name(Strategy)', doc: 'Base class for a strategy: prepare(self, d) and on_bar(self, i, pos, orders).' },
  Param: f('Param(key, label, default, lo, hi, step)', 'One setting of your strategy.'),
  np: { kind: 'module', doc: 'numpy (always loaded)' },
  indicators: { kind: 'module', doc: 'MEDUSA’s indicators: ema, sma, atr, rsi, macd, supertrend …' },
  engine: { kind: 'module', doc: 'MEDUSA’s backtest engine' },
  stats: { kind: 'module', doc: 'MEDUSA’s report statistics' },
};

export const DATA = {
  name: a('str · the name load() knows it by, e.g. "BTCUSDT-futures-4h"'),
  symbol: a('str · e.g. "BTCUSDT"'),
  market: a('str · "futures" or "spot"'),
  interval: a('str · the timeframe, e.g. "4h"'),
  t: a('numpy int64 · open time of each candle, ms since 1970 (UTC)'),
  o: a('numpy float64 · open prices'),
  h: a('numpy float64 · high prices'),
  l: a('numpy float64 · low prices'),
  c: a('numpy float64 · close prices'),
  v: a('numpy float64 · volume (in the coin)'),
  tbv: a('numpy float64 or None · taker-buy volume (Binance files have it)'),
  funding_t: a('numpy int64 or None · funding times, ms UTC (futures files with funding)'),
  funding_r: a('numpy float64 or None · funding rates (0.0001 = 0.01%)'),
  cols: a('dict · every column as a numpy array (t o h l c v, and tbv ft fr when present)'),
  df: f('df()', 'The candles as a pandas DataFrame indexed by time in your time zone (open high low close volume …).'),
};

export const RESULT = {
  title: a('str · strategy, coin and timeframe'),
  summary: a('dict · the report’s numbers after costs (return, cagr, max_dd, sharpe, trades …)'),
  gross: a('dict · the same before costs'),
  trades: a('list of dicts · one per trade (et, ep, xt, xp, side, pnl, r, why …)'),
  equity_t: a('numpy int64 · times of the account-value curve, ms UTC'),
  equity: a('numpy float64 · account value'),
  warnings: a('list of str · what the engine warned about'),
  report_json: a('dict · the full report, as saved'),
  report: f('report()', 'Prints the main numbers.'),
  df: f('df()', 'The trades as a pandas DataFrame.'),
  save: f('save()', 'Also keeps this result in the Results folder.'),
};

const words = (s, doc) => Object.fromEntries(s.split(' ').map((w) => [w, { kind: /^[A-Z]/.test(w) ? 'class' : 'fn', doc }]));
const MODULES = {
  numpy: words('array asarray zeros ones full arange linspace where nan isnan isfinite nanmean nanstd nanmax nanmin mean median std var sum cumsum cumprod '
    + 'diff log log1p exp sqrt abs sign maximum minimum fmax fmin clip round percentile quantile corrcoef cov argmax argmin argsort sort unique '
    + 'searchsorted concatenate stack vstack hstack roll full_like zeros_like ones_like isin intersect1d nan_to_num polyfit histogram datetime64 int64 float64 inf pi', 'numpy'),
  pandas: words('DataFrame Series to_datetime Timedelta Timestamp date_range concat merge read_csv isna notna cut qcut set_option', 'pandas'),
  'matplotlib.pyplot': words('figure subplots plot bar barh hist scatter fill_between axhline axvline title xlabel ylabel legend grid show tight_layout '
    + 'xlim ylim xticks yticks twinx subplot text annotate yscale xscale step stem boxplot pie close savefig suptitle colorbar imshow', 'matplotlib.pyplot'),
  math: words('sqrt log exp floor ceil isnan isfinite inf nan pi fabs pow', 'math'),
  statistics: words('mean median stdev pstdev variance quantiles correlation', 'statistics'),
};
let INDICATORS = null;   // name -> {kind, sig, doc}, read from py/indicators.py the first time it's needed
function indicators() {
  if (INDICATORS) return INDICATORS;
  INDICATORS = {};
  fetch('/lab/py/indicators.py').then((r) => r.text()).then((src) => {
    for (const m of src.matchAll(/^def ([a-z]\w*)\(([^)]*)\):\n(?:\s+"""([^\n]*?)(?:"""|\n))?/gm)) {
      INDICATORS[m[1]] = { kind: 'fn', sig: `${m[1]}(${m[2]})`, doc: (m[3] || '').trim() || 'MEDUSA indicator' };
    }
  }).catch(() => {});
  return INDICATORS;
}

/* ---------- reading the code ---------- */

const STR_START = /([rRbBuUfF]{0,2})('''|"""|'|")/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/y;
const OPS = /(?:\*\*=?|\/\/=?|<<=?|>>=?|->|\.\.\.|[-+*/%&|^@<>=!:]=|[-+*/%&|^~<>=!:.,;@()[\]{}\\])/y;
const IDENT = /[A-Za-z_À-￿][\wÀ-￿]*/y;

/** Tokens: {k: kind, s: start, e: end, v: text, bad?: why}. Kinds: id num str com op nl err. Spaces are skipped. */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const at = (re) => { re.lastIndex = i; const m = re.exec(src); return m && m.index === i ? m : null; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { out.push({ k: 'nl', s: i, e: i + 1, v: '\n' }); i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') { i++; continue; }
    if (ch === '#') { let e = src.indexOf('\n', i); if (e < 0) e = src.length; out.push({ k: 'com', s: i, e, v: src.slice(i, e) }); i = e; continue; }
    let m = at(STR_START);
    if (m && (m[1] === '' || /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/.test(m[1]))) {
      const q = m[2], s = i;
      let j = i + m[0].length, bad = null;
      if (q.length === 3) {
        for (;;) {
          const k = src.indexOf(q, j);
          if (k < 0) { j = src.length; bad = 'unterminated triple-quoted string literal'; break; }
          let bs = 0; for (let p = k - 1; p >= j && src[p] === '\\'; p--) bs++;
          if (bs % 2) { j = k + 1; continue; }
          j = k + 3; break;
        }
      } else {
        for (;;) {
          if (j >= src.length || src[j] === '\n') { bad = 'unterminated string literal'; break; }
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === q) { j++; break; }
          j++;
        }
      }
      out.push({ k: 'str', s, e: j, v: src.slice(s, j), bad, q });
      i = j;
      continue;
    }
    if ((m = at(IDENT))) { out.push({ k: 'id', s: i, e: i + m[0].length, v: m[0] }); i += m[0].length; continue; }
    if (/[\d.]/.test(ch) && (m = at(NUMBER)) && m[0] !== '.') { out.push({ k: 'num', s: i, e: i + m[0].length, v: m[0] }); i += m[0].length; continue; }
    if ((m = at(OPS))) { out.push({ k: 'op', s: i, e: i + m[0].length, v: m[0] }); i += m[0].length; continue; }
    out.push({ k: 'err', s: i, e: i + 1, v: ch });
    i++;
  }
  return out;
}

/** Where each line starts (offsets). */
function lineStarts(src) {
  const ls = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) ls.push(i + 1);
  return ls;
}
function lineOf(ls, pos) {
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

/** Variables and their types: [{name, pos, type}] with type 'data', 'result', a module name, or null. */
function assignments(src, toks) {
  const out = [];
  const add = (name, pos, type = null) => out.push({ name, pos, type });
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'id') continue;
    const prev = toks[i - 1], next = toks[i + 1];
    const lineStart = !prev || prev.k === 'nl' || (prev.k === 'op' && prev.v === ';');
    if (lineStart && next && next.k === 'op' && next.v === '=') {
      const r = toks[i + 2];
      let type = null;
      if (r && r.k === 'id' && toks[i + 3] && toks[i + 3].v === '(' && (r.v === 'load' || r.v === 'backtest')) {
        // only when the whole right side is that call: not load().df()
        let j = i + 3, depth = 0;
        for (; j < toks.length; j++) { if (OPEN[toks[j].v]) depth++; else if (CLOSE[toks[j].v] && --depth === 0) break; }
        const after = toks[j + 1];
        if (!after || after.k === 'nl' || after.k === 'com' || after.v === ';') type = r.v === 'load' ? 'data' : 'result';
      }
      add(t.v, t.s, type);
    }
    if (t.v === 'import' && t.k === 'id' && toks[i - 2] && toks[i - 2].v === 'from') {
      // from indicators import ema, atr as average_range
      for (let j = i + 1; toks[j] && toks[j].k !== 'nl'; j++) {
        if (toks[j].k !== 'id') continue;
        if (toks[j + 1] && toks[j + 1].v === 'as' && toks[j + 2] && toks[j + 2].k === 'id') { add(toks[j + 2].v, toks[j + 2].s); j += 2; } else add(toks[j].v, toks[j].s);
      }
    } else if (t.v === 'import' && t.k === 'id') {
      // import numpy as np / import matplotlib.pyplot as plt
      let j = i + 1, mod = '';
      while (toks[j] && (toks[j].k === 'id' || toks[j].v === '.') && toks[j].v !== 'as') { mod += toks[j].v; j++; }
      if (toks[j] && toks[j].v === 'as' && toks[j + 1] && toks[j + 1].k === 'id') add(toks[j + 1].v, toks[j + 1].s, MODULES[mod] ? mod : null);
      else if (mod && MODULES[mod.split('.')[0]] && !mod.includes('.')) add(mod, t.s, mod);
    }
    if ((t.v === 'for' || t.v === 'as' || t.v === 'def' || t.v === 'class') && next && next.k === 'id') add(next.v, next.s);
  }
  return out;
}
function typeAt(vars, name, pos) {
  let best = null;
  for (const v of vars) if (v.name === name && v.pos < pos && (!best || v.pos > best.pos)) best = v;
  return best ? best.type : null;
}
const membersOf = (type) => (type === 'data' ? DATA : type === 'result' ? RESULT : MODULES[type] || null);

/** Problems found without Python: [{line, c0, c1, msg, sev}] (lines and columns from 0). */
export function lint(src, toks, ctx = {}) {
  const ls = lineStarts(src);
  const probs = [];
  const at = (s, e, msg, sev = 'error') => {
    const line = lineOf(ls, s);
    const lineEnd = (ls[line + 1] ?? src.length + 1) - 1;
    probs.push({ line, c0: s - ls[line], c1: Math.max(s + 1, Math.min(e, lineEnd)) - ls[line], msg, sev });
  };
  // strings, odd characters and brackets
  const stack = [];
  const logical = [];         // [{toks, indent, line}]
  let cur = [];
  for (const t of toks) {
    if (t.k === 'str' && t.bad) at(t.s, t.q.length === 3 ? t.s + 3 : t.e, t.bad);
    if (t.k === 'err') at(t.s, t.e, `invalid character '${t.v}'`);
    if (t.k === 'op' && OPEN[t.v]) stack.push(t);
    if (t.k === 'op' && CLOSE[t.v]) {
      const o = stack.pop();
      if (!o) at(t.s, t.e, `unmatched '${t.v}'`);
      else if (o.v !== CLOSE[t.v]) { at(t.s, t.e, `closing parenthesis '${t.v}' does not match opening parenthesis '${o.v}'`); }
    }
    if (t.k === 'nl') {
      const last = cur[cur.length - 1];
      if (!stack.length && !(last && last.v === '\\')) { if (cur.length) logical.push(cur); cur = []; }
      continue;
    }
    if (t.k === 'com') continue;
    cur.push(t);
  }
  if (cur.length) logical.push(cur);
  for (const o of stack) at(o.s, o.e, `'${o.v}' was never closed`);

  // colons, '=' in a condition, print without brackets, indentation
  const indents = [0];
  let opener = null;           // the logical line ending with ':' before this one
  let mixed = false;
  for (const lt of logical) {
    const first = lt[0];
    const line = lineOf(ls, first.s);
    const lead = src.slice(ls[line], first.s);
    const width = lead.replace(/\t/g, '    ').length;
    if (!mixed && / /.test(lead) && /\t/.test(lead)) { mixed = true; at(ls[line], first.s, 'this indentation mixes tabs and spaces', 'warn'); }
    const top = indents[indents.length - 1];
    if (opener) {
      if (width > top) indents.push(width);
      else at(first.s, first.e, `expected an indented block after '${opener.v}' statement on line ${lineOf(ls, opener.s) + 1}`);
    } else if (width > top) {
      at(first.s, first.e, 'unexpected indent');
    } else if (width < top) {
      while (indents.length > 1 && indents[indents.length - 1] > width) indents.pop();
      if (indents[indents.length - 1] !== width) at(first.s, first.e, 'unindent does not match any outer indentation level');
    }
    const head = first.v === 'async' && lt[1] ? lt[1] : first;
    const isBlock = first.k === 'id' && BLOCK.has(head.v);
    let depth = 0, colon = null, eq = null;
    for (const t of lt) {
      if (t.k !== 'op') continue;
      if (OPEN[t.v]) depth++;
      else if (CLOSE[t.v]) depth--;
      else if (depth === 0 && t.v === ':' && !colon) colon = t;
      else if (depth === 0 && t.v === '=' && !eq) eq = t;
    }
    const last = lt[lt.length - 1];
    if (isBlock && !colon) {
      const lambdaColon = lt.some((t) => t.v === 'lambda');
      if (!lambdaColon) at(last.s, last.e, "expected ':'");
    }
    if (isBlock && eq && /^(if|elif|while)$/.test(head.v) && (!colon || eq.s < colon.s)) at(eq.s, eq.e, "invalid syntax: maybe you meant '==' instead of '='?");
    if (first.v === 'print' && lt[1] && (lt[1].k === 'str' || lt[1].k === 'num' || (lt[1].k === 'id' && !KEYWORDS.has(lt[1].v)))) {
      at(first.s, last.e, "missing parentheses in call to 'print': did you mean print(...)?");
    }
    opener = isBlock && last.k === 'op' && last.v === ':' ? head : null;
  }
  if (opener) at(opener.s, opener.e, `expected an indented block after '${opener.v}' statement on line ${lineOf(ls, opener.s) + 1}`);

  // MEDUSA names: attributes of a data file or a result, and load("name") of a file that isn't ticked
  const vars = assignments(src, toks);
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i], dot = toks[i - 1], obj = toks[i - 2];
    if (t.k === 'id' && dot.v === '.' && obj.k === 'id') {
      const type = typeAt(vars, obj.v, obj.s);
      const mem = type === 'data' ? DATA : type === 'result' ? RESULT : null;
      if (mem && !mem[t.v] && !t.v.startsWith('_')) {
        const near = Object.keys(mem).find((k) => k.toLowerCase() === t.v.toLowerCase());
        at(t.s, t.e, `${obj.v} (${type === 'data' ? 'from load()' : 'a backtest result'}) has no '${t.v}'${near ? `: did you mean '${near}'?` : `. It has: ${Object.keys(mem).join(', ')}`}`, 'warn');
      }
    }
  }
  if (ctx.attached) {
    for (let i = 0; i + 2 < toks.length; i++) {
      if (toks[i].v !== 'load' || toks[i].k !== 'id' || toks[i + 1].v !== '(' || toks[i + 2].k !== 'str' || toks[i + 2].bad) continue;
      if (toks[i - 1] && toks[i - 1].v === '.') continue;
      const s = toks[i + 2];
      const name = s.v.replace(/^[rRbBuU]*(['"])(.*)\1$/s, '$2');
      if (ctx.attached.includes(name)) continue;
      at(s.s, s.e, (ctx.available || []).includes(name) ? `"${name}" isn't ticked under Data files for Python: tick it so load() can find it`
        : `no data file is called "${name}"${ctx.attached.length ? `. Ticked: ${ctx.attached.join(', ')}` : ''}`, 'warn');
    }
    const bare = toks.findIndex((t, i) => t.v === 'load' && t.k === 'id' && toks[i + 1] && toks[i + 1].v === '(' && toks[i + 2] && toks[i + 2].v === ')' && !(toks[i - 1] && toks[i - 1].v === '.'));
    if (bare >= 0 && ctx.attached.length > 1) at(toks[bare].s, toks[bare + 2].e, `several files are ticked, so load() needs a name: ${ctx.attached.map((x) => `load("${x}")`).join(' or ')}`, 'warn');
    if (bare >= 0 && !ctx.attached.length) at(toks[bare].s, toks[bare + 2].e, 'no data file is ticked: tick one under Data files for Python', 'warn');
  }
  return probs;
}

/** Python's own findings ({line, col, end_line, end_col, msg, sev, whole}, from 1) as the editor's problems. */
function fromPython(src, list) {
  const lines = src.split('\n');
  return (list || []).map((p) => {
    const line = Math.min(Math.max(0, (p.line || 1) - 1), lines.length - 1);
    const text = lines[line];
    let c0 = Math.max(0, (p.col || 1) - 1), c1 = p.end_line === p.line && p.end_col > p.col ? p.end_col - 1 : c0 + 1;
    if (p.whole) { c0 = text.length - text.trimStart().length; c1 = Math.max(c0 + 1, text.length); }
    const msg = p.msg.replace(/^invalid syntax\. /, 'invalid syntax: ');
    return { line, c0, c1, msg: msg.charAt(0).toLowerCase() + msg.slice(1), sev: p.sev === 'warn' ? 'warn' : 'error', py: true };
  });
}

/* ---------- colours ---------- */

/** One colour class per character. */
function classes(src, toks) {
  const cls = new Array(src.length).fill('');
  const paint = (t, c) => { for (let i = t.s; i < t.e; i++) cls[i] = c; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
    if (t.k === 'com') paint(t, 'c-com');
    else if (t.k === 'str') paint(t, 'c-str');
    else if (t.k === 'num') paint(t, 'c-num');
    else if (t.k === 'err') paint(t, 'c-bad');
    else if (t.k === 'op' && t.v === '@' && next && next.k === 'id' && (!prev || prev.k === 'nl')) { paint(t, 'c-dec'); paint(next, 'c-dec'); i++; }
    else if (t.k === 'id') {
      const afterDot = prev && prev.v === '.';
      if (!afterDot && KEYWORDS.has(t.v)) paint(t, 'c-kw');
      else if (CONSTS.has(t.v)) paint(t, 'c-const');
      else if (prev && prev.v === 'def') paint(t, 'c-def');
      else if (prev && prev.v === 'class') paint(t, 'c-cls');
      else if (!afterDot && t.v === 'self') paint(t, 'c-self');
      else if (!afterDot && MEDUSA[t.v]) paint(t, 'c-md');
      else if (!afterDot && BUILTINS.has(t.v)) paint(t, 'c-bi');
      else if (next && next.v === '(') paint(t, 'c-call');
      else if (afterDot) paint(t, 'c-attr');
    }
  }
  return cls;
}

/* ---------- the editor ---------- */

/**
 * Turns a textarea into the Lab's editor. opts: {context() -> {attached, available} (data file names), check(code) ->
 * Promise<[findings of py/console.py's syntax()]> or null when Python isn't running}. Returns {refresh(), problems(), destroy()}.
 */
export function attachEditor(ta, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'lab-ed';
  ta.replaceWith(wrap);
  wrap.innerHTML = `<div class="lab-ed-gutter" aria-hidden="true"><div class="lab-ed-nums"></div></div>
    <pre class="lab-ed-hl" aria-hidden="true"><code></code></pre>
    <div class="lab-ed-pop" role="listbox" hidden></div><div class="lab-ed-tip" role="tooltip" hidden></div>`;
  wrap.append(ta);
  ta.classList.add('lab-ed-ta');
  const probsBox = document.createElement('div');
  probsBox.className = 'lab-ed-probs';
  probsBox.id = `${ta.id}-problems`;
  ta.setAttribute('aria-describedby', probsBox.id);
  probsBox.setAttribute('aria-live', 'polite');
  wrap.after(probsBox);
  const code = wrap.querySelector('.lab-ed-hl code');
  const hl = wrap.querySelector('.lab-ed-hl');
  const nums = wrap.querySelector('.lab-ed-nums');
  const pop = wrap.querySelector('.lab-ed-pop');
  const tip = wrap.querySelector('.lab-ed-tip');
  const ed = { probs: [], py: null, pyFor: null, timer: 0, menu: null, quiet: -1, quietTimer: 0, silent: false, tabOut: false };

  const metrics = () => {
    const cs = getComputedStyle(ta);
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(50);
    hl.append(probe);
    const cw = probe.getBoundingClientRect().width / 50;
    probe.remove();
    return { cw: cw || 7.8, lh: parseFloat(cs.lineHeight) || 20, pl: parseFloat(cs.paddingLeft), pt: parseFloat(cs.paddingTop) };
  };

  function render() {
    const src = ta.value;
    const toks = tokenize(src);
    const ctx = opts.context ? opts.context() : {};
    let probs = lint(src, toks, ctx);
    if (ed.pyFor === src) {
      // Python's compiler has the last word on syntax; the checks of MEDUSA names stay
      probs = [...fromPython(src, ed.py), ...probs.filter((p) => p.sev === 'warn')];
    }
    if (ed.quiet >= 0) probs = probs.filter((p) => p.line !== ed.quiet);   // the line being typed: marked once typing pauses
    ed.probs = probs;
    const cls = classes(src, toks);
    const mark = new Array(src.length + 1).fill('');
    const ls = lineStarts(src);
    const byLine = new Map();
    for (const p of probs) {
      if (!byLine.has(p.line)) byLine.set(p.line, []);
      byLine.get(p.line).push(p);
      for (let i = ls[p.line] + p.c0; i < ls[p.line] + p.c1 && i < src.length && src[i] !== '\n'; i++) if (mark[i] !== 'sq-error') mark[i] = `sq-${p.sev}`;
    }
    let html = '';
    for (let ln = 0; ln < ls.length; ln++) {
      const s = ls[ln], e = ln + 1 < ls.length ? ls[ln + 1] - 1 : src.length;
      let i = s;
      while (i < e) {
        let j = i + 1;
        while (j < e && cls[j] === cls[i] && mark[j] === mark[i]) j++;
        const c = [cls[i], mark[i]].filter(Boolean).join(' ');
        html += c ? `<span class="${c}">${esc(src.slice(i, j))}</span>` : esc(src.slice(i, j));
        i = j;
      }
      const ps = byLine.get(ln);
      if (ps) {
        if (ps.some((p) => p.c0 >= e - s)) html += `<span class="sq-${ps[0].sev}"> </span>`;
        html += `<span class="lab-ed-lens ${ps[0].sev}">${esc(ps[0].msg)}</span>`;
      }
      if (ln + 1 < ls.length) html += '\n';
    }
    code.innerHTML = html + '\n';
    nums.innerHTML = ls.map((_, k) => { const ps = byLine.get(k); return `<div${ps ? ` class="${ps.some((p) => p.sev === 'error') ? 'error' : 'warn'}"` : ''}>${k + 1}</div>`; }).join('');
    wrap.style.setProperty('--gutter', `${String(ls.length).length + 2.2}ch`);
    paintProblems();
    sync();
  }

  function paintProblems() {
    const ps = ed.probs;
    const errs = ps.filter((p) => p.sev === 'error').length;
    const by = ed.pyFor === ta.value ? ' <span class="faint">(checked by Python)</span>' : '';
    probsBox.innerHTML = ps.length
      ? `<span class="${errs ? 'error' : 'warn'}">${errs ? `${errs} problem${errs > 1 ? 's' : ''}` : `${ps.length} warning${ps.length > 1 ? 's' : ''}`}</span>${ps.slice(0, 6).map((p, k) => `<button type="button" class="lab-ed-prob ${p.sev}" data-k="${k}">Line ${p.line + 1}: ${esc(p.msg)}</button>`).join('')}${ps.length > 6 ? `<span class="faint">and ${ps.length - 6} more</span>` : ''}`
      : `<span class="ok">No syntax problems found${by}</span>`;
  }

  function sync() {
    const x = ta.scrollLeft, y = ta.scrollTop;
    code.style.transform = `translate(${-x}px, ${-y}px)`;
    nums.style.transform = `translateY(${-y}px)`;
  }

  /* Python's own check, a moment after typing stops */
  function schedulePython() {
    clearTimeout(ed.timer);
    if (!opts.check) return;
    ed.timer = setTimeout(async () => {
      const src = ta.value;
      const p = opts.check(src);
      if (!p) return;
      try {
        const r = await p;
        if (ta.value !== src) return;
        ed.py = r;
        ed.pyFor = src;
        render();
      } catch { /* Python not there: the quick check stays */ }
    }, 700);
  }

  /* ---------- suggestions ---------- */

  function context() {
    const src = ta.value, pos = ta.selectionStart;
    const before = src.slice(0, pos);
    const toks = tokenize(before);
    const last = toks[toks.length - 1];
    if (last && (last.k === 'com' || (last.k === 'str' && (last.bad || last.e === pos)))) return null;   // in a comment or a string
    const m = before.match(/(?:([A-Za-z_][\w.]*|\))\.)?([A-Za-z_]\w*)?$/);
    if (!m) return null;
    const word = m[2] || '';
    let items = null, objType = null;
    if (m[0].includes('.')) {
      const obj = m[1];
      if (obj === ')') {
        const call = before.slice(0, pos - word.length - 1);
        if (/(?:^|[^\w.])load\([^()]*\)$/.test(call)) objType = 'data';
        else if (/(?:^|[^\w.])backtest\((?:[^()]|\([^()]*\))*\)$/.test(call)) objType = 'result';
      } else if (obj === 'indicators') objType = 'indicators';
      else if (obj === 'np' || obj === 'numpy') objType = 'numpy';
      else if (obj === 'math' || obj === 'statistics') objType = obj;
      else if (!obj.includes('.')) objType = typeAt(assignments(src, tokenize(src)), obj, pos - word.length - obj.length - 1);
      else if (obj === 'matplotlib.pyplot') objType = 'matplotlib.pyplot';
      items = objType === 'indicators' ? indicators() : membersOf(objType);
      if (!items) return null;
    } else {
      const lineStart = before.slice(before.lastIndexOf('\n') + 1);
      if (/^\s*from\s+indicators\s+import\s+(?:[\w\s,]*,\s*)?\w*$/.test(lineStart)) items = indicators();
      else {
        if (word.length < 1) return null;
        items = { ...MEDUSA };
        for (const k of KEYWORDS) items[k] = { kind: 'kw' };
        for (const k of BUILTINS) items[k] = items[k] || { kind: 'fn', doc: 'Python built-in' };
        for (const k of CONSTS) items[k] = { kind: 'kw' };
        for (const v of assignments(src, tokenize(src))) if (!items[v.name]) items[v.name] = indicators()[v.name] || { kind: 'var', doc: v.type === 'data' ? 'a data file (load())' : v.type === 'result' ? 'a backtest result' : v.type ? v.type : 'in your code' };
      }
    }
    const lw = word.toLowerCase();
    const names = Object.keys(items).filter((k) => k !== word && (!lw || k.toLowerCase().includes(lw)) && (word.startsWith('_') || !k.startsWith('_')));
    if (lw) names.sort((x, y) => (y.toLowerCase().startsWith(lw) - x.toLowerCase().startsWith(lw)) || (items[x].kind === 'kw') - (items[y].kind === 'kw') || x.length - y.length || x.localeCompare(y));
    if (!names.length) return null;
    return { word, from: pos - word.length, list: names.slice(0, 40).map((k) => ({ k, ...items[k] })) };
  }

  const KIND = { fn: 'ƒ', attr: '·', kw: 'k', var: 'v', module: 'm', class: 'C' };
  function showMenu(c) {
    ed.menu = c ? { ...c, sel: 0 } : null;
    if (!c) { pop.hidden = true; return; }
    tip.hidden = true;
    paintMenu();
    pop.hidden = false;
    place(pop);
  }
  function paintMenu() {
    const m = ed.menu;
    const sel = m.list[m.sel];
    pop.innerHTML = `<div class="lab-ed-items">${m.list.map((it, k) => `<div class="lab-ed-item${k === m.sel ? ' sel' : ''}" role="option" aria-selected="${k === m.sel}" data-k="${k}"><span class="lab-ed-kind ${it.kind}">${KIND[it.kind] || '·'}</span><span>${esc(it.k)}</span></div>`).join('')}</div>
      ${sel && (sel.sig || sel.doc) ? `<div class="lab-ed-doc">${sel.sig ? `<code>${esc(sel.sig)}</code>` : ''}${sel.doc ? `<div>${esc(sel.doc)}</div>` : ''}</div>` : ''}`;
    const el = pop.querySelector('.lab-ed-item.sel'), box = pop.querySelector('.lab-ed-items');
    if (el && el.offsetTop + el.offsetHeight > box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 4;
  }
  function accept() {
    const m = ed.menu;
    const it = m.list[m.sel];
    const ins = it.k + (it.kind === 'fn' && /\(\)$/.test(it.sig || '') ? '()' : '');
    ta.setRangeText(ins, m.from, ta.selectionStart, 'end');
    showMenu(null);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  /** Puts a popup under the caret. */
  function place(el) {
    const { cw, lh, pl, pt } = metrics();
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length - 1;
    const col = before.slice(before.lastIndexOf('\n') + 1).replace(/\t/g, '    ').length;
    const x = ta.offsetLeft + pl + col * cw - ta.scrollLeft;
    const y = ta.offsetTop + pt + (line + 1) * lh - ta.scrollTop + 2;
    el.style.left = `${Math.max(4, Math.min(x, wrap.clientWidth - 300))}px`;
    el.style.top = `${y}px`;
  }

  /* the call you're typing the brackets of: its signature */
  function signature() {
    const before = ta.value.slice(0, ta.selectionStart);
    let depth = 0;
    for (let i = before.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
      const ch = before[i];
      if (ch === '\n' && depth === 0 && n > 120) break;
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          const m = before.slice(0, i).match(/([A-Za-z_]\w*)(\.)?([A-Za-z_]\w*)?$/);
          if (!m) return null;
          const info = m[3] ? (m[1] === 'indicators' ? indicators()[m[3]] : null) : MEDUSA[m[1]] || indicators()[m[1]];
          return info && info.sig ? info : null;
        }
        depth--;
      }
    }
    return null;
  }
  function showTip() {
    const s = !ed.menu && signature();
    if (!s) { tip.hidden = true; return; }
    tip.innerHTML = `<code>${esc(s.sig)}</code>${s.doc ? `<div>${esc(s.doc)}</div>` : ''}`;
    tip.hidden = false;
    place(tip);
  }

  /* ---------- editing keys: Ctrl+/ comments lines out or in, Tab and Shift+Tab indent them ---------- */

  /** Replaces from..to with text the way typing does (so Ctrl+Z undoes it), then selects s..e. */
  function edit(from, to, text, s, e) {
    ed.silent = true;
    ta.setSelectionRange(from, to);
    let typed = false;
    try { typed = document.execCommand('insertText', false, text); } catch { /* not supported: below */ }
    if (!typed) { ta.setRangeText(text, from, to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ed.silent = false;
    ta.setSelectionRange(s, e);
  }

  /** The whole lines the selection touches (a selection ending at the start of a line leaves that line out). */
  function selectedLines() {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const from = v.slice(0, s).lastIndexOf('\n') + 1;
    const nl = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    const to = nl < 0 ? v.length : nl;
    return { from, to, lines: v.slice(from, to).split('\n'), s, e };
  }

  /** Changes those lines: changes[k] is [column, characters removed, text put in] or null. The selection keeps
   *  covering the same text; a selection's start right where text goes in stays in front of it. */
  function changeLines({ from, to, lines, s, e }, changes) {
    const out = lines.map((l, k) => (changes[k] ? l.slice(0, changes[k][0]) + changes[k][2] + l.slice(changes[k][0] + changes[k][1]) : l));
    const text = out.join('\n');
    if (text === lines.join('\n')) return;
    const map = (p, stay) => {
      let start = from, shift = 0;
      for (let k = 0; k < lines.length; k++) {
        const end = start + lines[k].length, c = changes[k];
        if (p <= end) {
          const col = p - start;
          if (!c || col < c[0] || (stay && col === c[0])) return p + shift;
          return p + shift + c[2].length - Math.min(col - c[0], c[1]);
        }
        shift += out[k].length - lines[k].length;
        start = end + 1;
      }
      return p + shift;
    };
    edit(from, to, text, map(s, s !== e), map(e, false));
  }

  /** Ctrl+/: a "# " in front of the lines (at their common indent), or off again when all of them are comments. */
  function toggleComment() {
    const sel = selectedLines();
    const code = sel.lines.filter((l) => l.trim());
    if (!code.length) {                       // a blank line: start a comment on it
      if (sel.lines.length === 1) changeLines(sel, [[sel.lines[0].length, 0, '# ']]);
      return;
    }
    const off = code.every((l) => /^\s*#/.test(l));
    const ind = code.reduce((m, l) => Math.min(m, l.length - l.trimStart().length), Infinity);
    changeLines(sel, sel.lines.map((l) => {
      if (!l.trim()) return null;
      if (!off) return [ind, 0, '# '];
      const at = l.indexOf('#');
      return [at, l[at + 1] === ' ' ? 2 : 1, ''];
    }));
  }

  /** Tab: spaces to the next multiple of 4 at the caret, or 4 in front of each selected line. Shift+Tab: up to 4 fewer. */
  function indent(back) {
    const sel = selectedLines();
    if (!back && sel.s === sel.e) {
      const n = 4 - ((sel.s - sel.from) % 4);
      edit(sel.s, sel.s, ' '.repeat(n), sel.s + n, sel.s + n);
      return;
    }
    changeLines(sel, sel.lines.map((l) => {
      if (!back) return l.trim() || sel.lines.length === 1 ? [0, 0, '    '] : null;
      const m = /^(?:\t| {1,4})/.exec(l);
      return m ? [0, m[0].length, ''] : null;
    }));
  }

  /** Ctrl+/ (⌘/) and Tab / Shift+Tab; true when the key was used. */
  function editKey(ev, tabOut) {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.altKey && ev.key === '/') { toggleComment(); return true; }
    if (ev.key === 'Tab' && !mod && !ev.altKey && !tabOut) { indent(ev.shiftKey); return true; }
    return false;
  }

  /* ---------- events ---------- */

  ta.addEventListener('input', (ev) => {
    clearTimeout(ed.quietTimer);
    ed.quiet = ev.inputType && !ed.silent ? ta.value.slice(0, ta.selectionStart).split('\n').length - 1 : -1;
    if (ed.quiet >= 0) ed.quietTimer = setTimeout(() => { ed.quiet = -1; render(); }, 900);
    render();
    schedulePython();
    if (ed.silent) { showMenu(null); tip.hidden = true; return; }   // a key's edit (Ctrl+/, Tab): no suggestions
    const typed = ev.inputType === 'insertText' && ev.data && /^[\w.]$/.test(ev.data.slice(-1));
    const c = typed || (ed.menu && ev.inputType === 'deleteContentBackward') ? context() : null;
    showMenu(c && (c.word.length || (ev.data || '').endsWith('.') || ed.menu) ? c : null);
    showTip();
  });
  ta.addEventListener('scroll', () => { sync(); if (ed.menu) showMenu(null); tip.hidden = true; });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) { showMenu(null); tip.hidden = true; } }, 150));
  ta.addEventListener('click', () => { showMenu(null); showTip(); });
  ta.addEventListener('keydown', (ev) => {
    const tabOut = ed.tabOut;
    ed.tabOut = false;
    if (ev.ctrlKey && ev.key === ' ') { ev.preventDefault(); const c = context(); showMenu(c); if (!c) showTip(); return; }
    if (!ed.menu) {
      if (ev.key === 'Escape') {
        if (!tip.hidden) { tip.hidden = true; ev.preventDefault(); }   // used: the page's own Esc (full screen) waits
        else ed.tabOut = true;                                          // Esc, then Tab: on to the next field
      }
      if (/^Arrow(Left|Right)$|^(Home|End)$/.test(ev.key)) setTimeout(showTip);
      if (!ta.readOnly && !ev.isComposing && editKey(ev, tabOut)) ev.preventDefault();
      return;
    }
    const m = ed.menu;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      m.sel = (m.sel + (ev.key === 'ArrowDown' ? 1 : -1) + m.list.length) % m.list.length;
      paintMenu();
    } else if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      accept();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      showMenu(null);
    } else if (/^Arrow(Left|Right)$|^(Home|End|PageUp|PageDown)$/.test(ev.key)) showMenu(null);
  });
  pop.addEventListener('mousedown', (ev) => {
    const it = ev.target.closest('.lab-ed-item');
    ev.preventDefault();
    if (it && ed.menu) { ed.menu.sel = Number(it.dataset.k); accept(); }
  });
  probsBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('.lab-ed-prob');
    if (!b) return;
    const p = ed.probs[Number(b.dataset.k)];
    const ls = lineStarts(ta.value);
    const pos = ls[p.line] + p.c0;
    ta.focus();
    ta.setSelectionRange(pos, Math.min(ls[p.line] + p.c1, (ls[p.line + 1] ?? ta.value.length + 1) - 1));
    const { lh, pt } = metrics();
    ta.scrollTop = Math.max(0, pt + p.line * lh - ta.clientHeight / 3);
  });
  const ro = new ResizeObserver(sync);
  ro.observe(ta);

  render();
  schedulePython();
  return {
    refresh() { render(); schedulePython(); },
    problems: () => ed.probs,
    destroy() { ro.disconnect(); clearTimeout(ed.timer); },
  };
}

/** Colours for code that's only shown (the guide's examples). */
export function highlight(src) {
  const toks = tokenize(src);
  const cls = classes(src, toks);
  let html = '', i = 0;
  while (i < src.length) {
    let j = i + 1;
    while (j < src.length && cls[j] === cls[i]) j++;
    html += cls[i] ? `<span class="${cls[i]}">${esc(src.slice(i, j))}</span>` : esc(src.slice(i, j));
    i = j;
  }
  return html;
}
