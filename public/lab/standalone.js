// MEDUSA Lab: the code behind a result, as ONE standalone Python file anyone can run with Python + numpy.
// It holds 1. the settings, 2.-3. how the data is fetched, 4. MEDUSA's engine files exactly as they ran in the
// browser (public/lab/py), the strategy file, and 5. the runner (py/export_runner.py). No DOM here, so it can
// be tested outside the browser.

export const ENGINE_FILES = ['indicators.py', 'strategy.py', 'engine.py', 'stats.py', 'backtest.py'];

/** A JSON value as a Python literal. */
export function pyLiteral(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'float("inf")' : v < 0 ? '-float("inf")' : 'float("nan")';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ')}}`;
}

/** Source code as a Python string: a raw triple-quoted string when possible (readable), else an escaped one. */
const pySource = (src) => (!src.includes("'''") && !/\\$/.test(src) ? `r'''${src}'''` : JSON.stringify(src));

const two = (n) => String(n).padStart(2, '0');
function localTime(ms, tzMin) {
  const d = new Date(ms + tzMin * 60_000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
const zone = (tzMin) => `UTC${tzMin >= 0 ? '+' : '-'}${two(Math.floor(Math.abs(tzMin) / 60))}:${two(Math.abs(tzMin) % 60)}`;
const pctText = (x) => (typeof x === 'number' ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%` : '-');

/** The file name for a result's code. */
export function scriptName(report) {
  const key = String(report.config.strategy || 'strategy').split(':').pop().replace(/[^\w]+/g, '_');
  return `medusa_${key}_${report.meta.symbol || 'data'}_${report.meta.interval}.py`.replace(/_+/g, '_');
}

/**
 * report: a saved result. files: {name: source} of ENGINE_FILES and 'export_runner.py'. strategySource: the
 * strategy's .py file (null if not available). Returns the Python file as text.
 */
export function standaloneScript({ report, files, strategySource, strategyNote = '', now = Date.now() }) {
  const m = report.meta, s = report.summary, cfg0 = report.config || {};
  const tz = Number.isFinite(m.tz_offset_min) ? m.tz_offset_min : 0;
  const key = String(cfg0.strategy || '');
  const classKey = key.split(':').pop();
  const ivMs = m.interval_ms || 0;
  const sliceFrom = Number.isFinite(m.slice_from) ? m.slice_from : m.from - (m.warmup || 0) * ivMs;
  const config = { ...cfg0, strategy: classKey, params: m.params || cfg0.params || {}, start_ms: m.from, tz_offset_min: tz };
  for (const k of ['start', 'end', 'end_ms', 'split', 'split_ms', 'param_units']) delete config[k];
  if (report.split_at) config.split_ms = report.split_at;
  const data = {
    source: m.source === 'binance' ? 'binance' : 'file', name: m.dataset_name || '', symbol: m.symbol, market: m.market, interval: m.interval,
    candles_from_ms: sliceFrom, candles_to_ms: m.to,
    funding_from_ms: m.funding_from ?? (m.market === 'futures' ? sliceFrom - 8 * 3_600_000 : null), funding_to_ms: m.funding_to ?? (m.market === 'futures' ? m.to + ivMs : null),
  };
  const meta = { symbol: m.symbol, market: m.market, interval: m.interval, source: m.source, name: m.dataset_name };
  const expected = { final: s.final, trades: (s.trades && s.trades.n) || 0 };
  const exact = Number.isFinite(m.slice_from) && m.params;
  const name = scriptName(report);
  const t = s.trades || {};
  const head = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MEDUSA Lab backtest: ${report.title}

${m.market === 'spot' ? 'Spot' : 'Futures (USD-M perpetual)'}, ${localTime(m.from, tz)} to ${localTime(m.to, tz)} (${zone(tz)}): ${(m.candles || 0).toLocaleString('en-US')} candles of ${m.interval},
plus ${(m.warmup || 0).toLocaleString('en-US')} candles before them that only warm up the indicators.
Result in MEDUSA: net ${pctText(s.return)}, ${(t.n || 0).toLocaleString('en-US')} trades, worst drawdown ${((s.max_dd || 0) * 100).toFixed(2)}%.

Running this file repeats that backtest on any computer: the same candles${data.source === 'binance' ? ' (downloaded again from Binance\'s public\nAPI; no account or key needed)' : ' (from the file you give it with --csv)'}, the same strategy code, the same settings and the same engine
as MEDUSA, so it prints the same numbers and says whether they match.

Needs Python 3.9 or newer and numpy:    pip install numpy
Run it:                                 python ${name}
Options:  --csv FILE     use a CSV/ZIP file (MEDUSA's "Download to this computer" export) instead of downloading
          --trades FILE  also write every trade to a CSV file
          --json FILE    also write the whole report as JSON

Inside: 1. the settings  2. the data  3. MEDUSA's engine files, unchanged  4. the strategy  5. the code that runs it.
Exported from MEDUSA on ${localTime(now, tz)} (${zone(tz)}).${exact ? '' : '\nNote: this result was made before exports existed, so the warm-up and data range are reconstructed and\nthe numbers may differ slightly.'}${strategyNote ? `\nNote: ${strategyNote}` : ''}
"""
import sys
import types

# =============================================================================
# 1. The settings of this backtest (change them to try something else)
# =============================================================================
STRATEGY_KEY = ${pyLiteral(classKey)}

# The strategy's settings (indicator lengths in candles of ${m.interval}), costs, sizing and dates. Times are in ms since
# 1970 (UTC); start_ms is the first candle of the test, ${localTime(m.from, tz)} ${zone(tz)}.
CONFIG = ${pyLiteral(config)}

META = ${pyLiteral(meta)}

# What MEDUSA got, to compare with.
EXPECTED = ${pyLiteral(expected)}

# =============================================================================
# 2. The data: which candles (and funding rates) to download
# =============================================================================
# From ${localTime(data.candles_from_ms, tz)} (the start of the warm-up) to ${localTime(data.candles_to_ms, tz)} ${zone(tz)}.
DATA = ${pyLiteral(data)}

# =============================================================================
# 3. MEDUSA's engine: the files that ran this backtest in your browser, unchanged
# =============================================================================
# indicators.py  every indicator (numpy only; value i uses candles up to i)
# strategy.py    what a strategy is: settings (Param), warm-up, trade direction
# engine.py      fills, stops, targets, fees, slippage, funding, sizing, liquidation, one candle at a time
# stats.py       the report's numbers
# backtest.py    warm-up, dates and both runs (with and without costs): the function this file calls
MEDUSA_FILES = {
${ENGINE_FILES.map((f) => `    ${JSON.stringify(f.replace(/\.py$/, ''))}: ${pySource(files[f])},`).join('\n')}
}


def _install(sources):
    """Makes the files above importable (import engine, from indicators import ema, ...)."""
    for mod_name, src in sources.items():
        mod = types.ModuleType(mod_name)
        mod.__file__ = mod_name + ".py"
        sys.modules[mod_name] = mod
        exec(compile(src, mod_name + ".py", "exec"), mod.__dict__)


_install(MEDUSA_FILES)

# =============================================================================
# 4. The strategy${key.startsWith('mine:') ? ' (your file, as it is saved in MEDUSA now)' : key.startsWith('console:') ? '' : ` (MEDUSA's built-in file ${key}.py)`}
# =============================================================================
`;
  const strategy = strategySource
    ? strategySource.replace(/\r\n?/g, '\n').replace(/\s*$/, '\n')
    : `# The strategy class for this result isn't available as a file (it was written in the Python tab).
# Paste the class here; its key must be ${JSON.stringify(classKey)}.
raise SystemExit("Paste the strategy class into part 4 of this file first.")
`;
  return `${head}${strategy}\n\n${files['export_runner.py'].replace(/\r\n?/g, '\n')}`;
}
