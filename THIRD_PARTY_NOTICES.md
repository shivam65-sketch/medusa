# Third-party software in MEDUSA

MEDUSA bundles these open-source projects, unmodified, so the app can load them from its own address.
Each stays under its own licence.

| What | Where | Licence | Source |
|---|---|---|---|
| TradingView Lightweight Charts™ 5.2.1 (the Lab's Chart tab) | `public/lab/vendor/lightweight-charts.mjs` | Apache License 2.0, full text in `public/lab/vendor/lightweight-charts-LICENSE.txt` | https://github.com/tradingview/lightweight-charts |
| Pyodide (Python in the browser: `pyodide.mjs`, `pyodide.asm.*`, `python_stdlib.zip`, `pyodide-lock.json`) | `public/lab/pyodide/v314.0.7/` | Mozilla Public License 2.0, https://www.mozilla.org/MPL/2.0/ ; the Python standard library inside it is under the Python Software Foundation License | https://github.com/pyodide/pyodide |
| sql.js 1.14.2 (SQLite compiled to WebAssembly, for the Markets page's SQL engine: `sql-wasm.js`, `sql-wasm.wasm`) | `public/vendor/sqljs-1.14.2/` | MIT License, full text in `public/vendor/sqljs-1.14.2/LICENSE`; SQLite itself is in the public domain | https://github.com/sql-js/sql.js |
| Python packages for the Lab (numpy, pandas, matplotlib, scipy, statsmodels and the packages they need: contourpy, cycler, fonttools, kiwisolver, packaging, patsy, pillow, pyparsing, python-dateutil, pytz, six) | `public/lab/pyodide/v314.0.7/*.whl` | Each package's own licence, included inside its `.whl` file (in its `.dist-info` folder) | https://pypi.org |

TradingView asks apps that use Lightweight Charts to credit it with a link to https://www.tradingview.com; the Chart tab does this under the chart.
