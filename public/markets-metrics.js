// MEDUSA Markets: every number and graph on the Today, Patterns and Insights views, defined as SQL.
//
// This is the built-in copy. The master copy, with every version, is the lakehouse's table
// market.semantic.metric_definitions (lakehouse step 27): it was first filled from this file, and the
// page uses the versions published from it (market_metrics), falling back to this file only until they
// arrive or for an id they don't have. Change a definition in the lakehouse, not here.
//
// The page doesn't calculate these numbers in JavaScript. It runs these queries in a SQLite database
// inside the browser (markets-sql.js) and shows what they return: change a query here and the number
// on the page changes with it. Each query is shown on the page under its number, exactly as it runs.
//
// Two kinds of definition:
//   model   a shared step that other queries read by name, like a view (FROM today). Before a query
//           runs, the models it reads are put in front of it as WITH ... AS (...), so the query on the
//           page is complete and runs as it is.
//   metric  a number, card or table on the page.
//
// The tables the queries read:
//   market_baseline   each market's normal: MEDUSA's daily copy of the lakehouse's gold.coin_baseline
//   market_evidence   what similar moves did next: MEDUSA's copy of gold.event_evidence
//   live_prices       Binance's live prices, kept up to date from the stream while the page is open
//   binance_markets   each market's type from Binance's contract list, and yesterday's close from
//                     Binance's daily candle until the lakehouse has published yesterday
//   market_events     every unusual move since 2020 and what followed (gold.intraday_events), and
//   market_hours      the whole market's move in each UTC hour by year (gold.hour_drift), and
//   market_outcomes   how past moves turned out, with the worst 5% each way (gold.move_outcomes): the
//                     Insights data, one gzip file loaded when Insights opens (lakehouse step 32)
// Parameters, filled in by the page:
//   :kind       the type chosen at the top of the page: all, crypto, stock, commodity or other. A query
//               filters by it with :kind IN ('all', market_type), or market_type = :kind on market_hours,
//               which keeps a row for 'all'.
//   :yesterday  yesterday's date (UTC), the day today's move is measured from
//   :symbol     one market, for its details (NULL in a graph's window: every market)
//   :direction  Insights: all, up or down moves
//   :horizon    Insights: the next 1, 4 or 24 hours, or 0 when none is chosen. Past moves need a number of
//               hours to measure, so they use 4 then; a filter written :horizon IN (0, column) shows all
//   :year, :hour, :bucket, :z_band, :liquidity, :period, :kept, :at_least, :at_most, :verdict
//               what a click on a graph or a number picked (NULL: no filter)
//
// How a result is shown: `columns` gives each column's label and format (a column a query returns
// that isn't listed is shown as it comes); `card` is a summary card's text, where {column:format} is
// filled in from the first row; `chart` draws the result as a graph (markets-charts.js). A column's `under`
// adds a small second line to its cells. Its `drill` makes its numbers open the moves behind them, only
// where a number can open exactly what it summarises; `fixed` is a choice the row doesn't hold, like the
// hours of a Next 1 h column.
// The same rule as the lakehouse's intraday_events.sql: a move is unusual at 3 or more of the market's
// usual daily moves (|z| >= 3), in size bands 3-4, 4-6 and 6+.

const Z_TIP = "How many times bigger today's move is than this market's usual daily move (σ). 3σ or more is unusual.";
const LIQ_TIP = 'Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below';

const COL = {
  market: { name: 'market', label: 'Market', format: 'market' },
  price: { name: 'price', label: 'Price', format: 'price' },
  today: { name: 'today_pct', label: 'Today', format: 'pct' },
  z: { name: 'z', label: 'z (σ)', format: 'z', title: Z_TIP },
  liquidity: { name: 'liquidity', label: 'Liquidity', format: 'liquidity', title: LIQ_TIP },
};
// A click on a number that summarises a kind of move opens exactly the moves behind it. `fixed` holds what the
// row doesn't (a column's hours, the years), and `set` adds what it does (a percentile to cut the list at).
const kindDrill = (fixed = {}, set = {}) => ({ panel: 'moves', set: { kind: 'market_type', direction: 'direction', z_band: 'z_band', liquidity: 'liquidity', ...set }, fixed });
const FROM_2025 = { period: 'held_back' };
const ownDrill = { panel: 'moves', set: { kind: 'market_type', direction: 'direction', symbol: 'market' }, fixed: {} };
const verdictCols = [1, 4, 24].flatMap((h) => [
  { name: `next_${h}h`, label: `Next ${h} h`, format: 'verdict', sub: `all_${h}h`, hours: h },
  { name: `all_${h}h`, format: 'hidden' },
]);

export const DEFINITIONS = [
  /* ---------- models: shared steps ---------- */
  {
    id: 'market_now',
    kind: 'model',
    name: 'Each market now',
    description: "One row per trading market: its live price, yesterday's close and its normal.",
    sql: `SELECT b.symbol,
       m.market_type,                         -- crypto, stock, commodity or other (Binance's contract list)
       p.price,                               -- the live price (Binance's stream)
       p.quote_volume_24h,                    -- USDT traded in the last 24 hours (Binance's stream)
       CASE WHEN b.as_of_date < :yesterday    -- the lakehouse doesn't have yesterday yet:
            THEN m.yesterday_close            --   yesterday's close from Binance's daily candle
            ELSE b.last_close                 -- otherwise the lakehouse's own close
       END AS prev_close,
       b.avg_return_30d,                      -- the market's normal (lakehouse): its average daily return,
       b.sd_return_30d,                       --   σ, the spread of its daily returns: its usual daily move,
       b.history_days,                        --   the days of history behind them,
       b.avg_quote_volume_30d                 --   and the USDT it trades on an average day
FROM market_baseline b
LEFT JOIN live_prices p ON p.symbol = b.symbol
LEFT JOIN binance_markets m ON m.symbol = b.symbol
WHERE b.status <> 'not trading'`,
  },
  {
    id: 'today',
    kind: 'model',
    name: "Today's moves",
    description: "Every market's move today, its z (the move in its usual daily moves) and its liquidity.",
    sql: `SELECT symbol,
       market_type,
       price,
       price / prev_close - 1 AS move,                      -- the move since yesterday's close
       CASE WHEN history_days >= 20 AND sd_return_30d > 0   -- scored from 20 days of history
            THEN (price / prev_close - 1 - avg_return_30d) / sd_return_30d
       END AS z,                                            -- the move in usual daily moves (σ)
       sd_return_30d,
       quote_volume_24h / NULLIF(avg_quote_volume_30d, 0) AS volume_x,   -- the last 24 hours ÷ a usual day
       CASE WHEN avg_quote_volume_30d >= 100000000 THEN 'large'
            WHEN avg_quote_volume_30d >= 10000000 THEN 'mid'
            ELSE 'small'
       END AS liquidity                                     -- by the USDT it trades on an average day
FROM market_now`,
  },
  {
    id: 'flagged',
    kind: 'model',
    name: 'Unusual moves',
    description: 'The markets that have moved 3 or more of their usual daily moves today, with their kind of move.',
    sql: `SELECT *,
       CASE WHEN z > 0 THEN 'up' ELSE 'down' END AS direction,
       CASE WHEN ABS(z) < 4 THEN '3-4'
            WHEN ABS(z) < 6 THEN '4-6'
            ELSE '6+'
       END AS z_band,                                       -- the size band
       CASE WHEN market_type IN ('crypto', 'other') THEN 1 ELSE 0 END AS tested   -- stocks and commodities have no 2020-2024 years to test
FROM today
WHERE ABS(z) >= 3                                           -- unusual: 3 or more usual daily moves`,
  },
  {
    id: 'verdicts',
    kind: 'model',
    name: 'Verdicts in words',
    description: 'What each kind of move did next, one row per kind of move with a column per horizon.',
    sql: `SELECT direction,
       z_band,
       liquidity,
       MAX(CASE WHEN horizon_hours = 1 THEN verdict_text END) AS next_1h,
       MAX(CASE WHEN horizon_hours = 4 THEN verdict_text END) AS next_4h,
       MAX(CASE WHEN horizon_hours = 24 THEN verdict_text END) AS next_24h
FROM (SELECT direction, z_band, liquidity, horizon_hours,
             CASE WHEN verdict = 'held up'           -- the side, and what it made a trade from 2025 after costs
                  THEN side || ' ' || ROUND(100 * held_back_net_after_cost, 2) || '%'
                  ELSE verdict                       -- no pattern, did not hold or too few
             END AS verdict_text
      FROM market_evidence) e
GROUP BY direction, z_band, liquidity`,
  },

  /* ---------- metrics: the summary cards ---------- */
  {
    id: 'breadth',
    kind: 'metric',
    name: 'Breadth',
    description: 'The share of markets that are up today.',
    card: { value: '{breadth_pct:share} up', sub: '{up:int} up · {down:int} down' },
    sql: `SELECT COUNT(CASE WHEN move > 0 THEN 1 END) AS up,
       COUNT(CASE WHEN move < 0 THEN 1 END) AS down,
       COUNT(*) AS markets,
       ROUND(100.0 * COUNT(CASE WHEN move > 0 THEN 1 END) / NULLIF(COUNT(*), 0)) AS breadth_pct
FROM today
WHERE move IS NOT NULL                       -- markets with a live price and yesterday's close
  AND :kind IN ('all', market_type)          -- the type chosen at the top of the page`,
  },
  {
    id: 'median_move',
    kind: 'metric',
    name: 'Median move',
    description: "The middle of today's moves: half of the markets moved less, half more.",
    card: { value: '{median_pct:pct}', sub: 'of {markets:int} markets' },
    sql: `SELECT ROUND(100 * AVG(move), 2) AS median_pct,    -- the middle move, or the average of the two middle ones
       MAX(n) AS markets
FROM (SELECT move,
             ROW_NUMBER() OVER (ORDER BY move) AS rn,  -- each move's place, smallest first
             COUNT(*) OVER () AS n                      -- how many moves there are
      FROM today
      WHERE move IS NOT NULL
        AND :kind IN ('all', market_type)) ranked
WHERE rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))`,
  },
  {
    id: 'unusual_count',
    kind: 'metric',
    name: 'Unusual now',
    description: 'How many markets have moved 3 or more of their usual daily moves today.',
    card: { value: '{unusual:int}', sub: '{up:int_up} up · {down:int_down} down' },
    sql: `SELECT COUNT(*) AS unusual,
       COUNT(CASE WHEN direction = 'up' THEN 1 END) AS up,
       COUNT(CASE WHEN direction = 'down' THEN 1 END) AS down
FROM flagged
WHERE :kind IN ('all', market_type)`,
  },
  {
    id: 'bitcoin',
    kind: 'metric',
    name: 'Bitcoin',
    description: 'The BTCUSDT perpetual (on TradingView: BINANCE:BTCUSDT.P), not the spot market. It shows whatever type is chosen.',
    card: { value: '{price:price}', sub: '{today_pct:pct} · {z:z}' },
    sql: `SELECT price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE symbol = 'BTCUSDT'`,
  },

  /* ---------- metrics: the tables ---------- */
  {
    id: 'unusual',
    kind: 'metric',
    name: 'Unusual right now',
    description: 'Every unusual market, and what moves of the same kind (direction, size band, liquidity) did next. The small line under each verdict is every move in the same direction together.',
    columns: [COL.market, COL.price, COL.today, { ...COL.z, format: 'z_tag' }, COL.liquidity,
      ...verdictCols.map((c) => (c.format === 'verdict' ? { ...c, drill: kindDrill({ horizon: c.hours }) } : c)),
      ...['market_type', 'direction', 'z_band'].map((name) => ({ name, format: 'hidden' }))],
    sql: `SELECT f.symbol AS market,
       f.price,
       ROUND(100 * f.move, 2) AS today_pct,
       ROUND(f.z, 1) AS z,
       f.liquidity,
       CASE WHEN f.tested = 1 THEN v.next_1h ELSE 'not tested' END AS next_1h,    -- moves of the same kind
       CASE WHEN f.tested = 1 THEN v.next_4h ELSE 'not tested' END AS next_4h,
       CASE WHEN f.tested = 1 THEN v.next_24h ELSE 'not tested' END AS next_24h,
       CASE WHEN f.tested = 1 THEN w.next_1h ELSE 'not tested' END AS all_1h,     -- every move in the same direction
       CASE WHEN f.tested = 1 THEN w.next_4h ELSE 'not tested' END AS all_4h,
       CASE WHEN f.tested = 1 THEN w.next_24h ELSE 'not tested' END AS all_24h,
       f.market_type,                               -- for a click on a verdict
       f.direction,
       f.z_band
FROM flagged f
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
LEFT JOIN verdicts w ON w.direction = f.direction AND w.z_band = 'all' AND w.liquidity = 'all'
WHERE :kind IN ('all', f.market_type)
ORDER BY ABS(f.z) DESC`,
  },
  {
    id: 'gainers',
    kind: 'metric',
    name: 'Up the most',
    description: 'The eight biggest gains since yesterday\'s close.',
    columns: [COL.market, COL.price, COL.today, COL.z],
    sql: `SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move > 0
  AND :kind IN ('all', market_type)
ORDER BY move DESC
LIMIT 8`,
  },
  {
    id: 'losers',
    kind: 'metric',
    name: 'Down the most',
    description: 'The eight biggest losses since yesterday\'s close.',
    columns: [COL.market, COL.price, COL.today, COL.z],
    sql: `SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move < 0
  AND :kind IN ('all', market_type)
ORDER BY move ASC
LIMIT 8`,
  },
  {
    id: 'markets',
    kind: 'metric',
    name: 'Every market',
    description: 'Today against each market\'s normal. The table\'s search, sort buttons and pages work on this result.',
    columns: [COL.market, COL.price, COL.today, COL.z,
      { name: 'usual_day_pct', label: 'Usual day', format: 'pct_plain', title: "The market's usual daily move (σ) over its last 30 days" },
      { name: 'volume_x', label: 'Volume', format: 'times', title: 'USDT traded in the last 24 hours ÷ its usual day' },
      COL.liquidity, { name: 'unusual', format: 'hidden' }],
    sql: `SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,  -- its usual daily move (σ)
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN 0 ELSE 1 END AS unusual   -- highlighted when unusual
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
WHERE :kind IN ('all', t.market_type)`,
  },
  {
    id: 'market',
    kind: 'metric',
    name: 'One market',
    description: 'Every number in one market\'s row, and its kind of move with the verdicts when it is unusual.',
    columns: [COL.market, COL.price, COL.today, COL.z,
      { name: 'usual_day_pct', label: 'Usual day', format: 'pct_plain' }, { name: 'volume_x', label: 'Volume', format: 'times' },
      COL.liquidity, { name: 'direction', label: 'Direction' }, { name: 'z_band', label: 'Size band' },
      ...verdictCols.filter((c) => c.format === 'verdict').map(({ sub, ...c }) => ({ ...c, drill: kindDrill({ horizon: c.hours }) }))],
    sql: `SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       f.direction,                                  -- its kind of move, when unusual
       f.z_band,
       CASE WHEN f.tested = 0 THEN 'not tested' ELSE v.next_1h END AS next_1h,    -- what moves of that kind did next
       CASE WHEN f.tested = 0 THEN 'not tested' ELSE v.next_4h END AS next_4h,
       CASE WHEN f.tested = 0 THEN 'not tested' ELSE v.next_24h END AS next_24h
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
WHERE t.symbol = :symbol`,
  },
  {
    id: 'unusual_all_types',
    kind: 'metric',
    name: 'Unusual markets by kind of move',
    description: 'Every unusual market of any type with its kind of move: the Patterns view\'s Now, and when this page first saw each one unusual.',
    columns: [{ name: 'direction', label: 'Direction' }, { name: 'z_band', label: 'Size band' }, COL.liquidity, COL.market, { ...COL.z, format: 'z_tag' }],
    sql: `SELECT direction,
       z_band,
       liquidity,
       symbol AS market,
       ROUND(z, 1) AS z
FROM flagged
ORDER BY ABS(z) DESC`,
  },

  /* ---------- metrics: the Patterns view ---------- */
  {
    id: 'patterns_summary',
    kind: 'metric',
    name: 'What similar moves did next',
    description: 'How many unusual moves the lakehouse recorded since 2020, and how many kinds of move and horizons got each verdict.',
    card: { value: '{held_up:int} held up', sub: 'of {kinds:int} kinds of move and horizons · {moves_up:int} up and {moves_down:int} down moves since 2020' },
    sql: `SELECT SUM(CASE WHEN direction = 'up' AND z_band = 'all' AND horizon_hours = 1 THEN events ELSE 0 END) AS moves_up,     -- every up move, counted once
       SUM(CASE WHEN direction = 'down' AND z_band = 'all' AND horizon_hours = 1 THEN events ELSE 0 END) AS moves_down, -- every down move
       COUNT(CASE WHEN verdict = 'held up' THEN 1 END) AS held_up,
       COUNT(CASE WHEN verdict = 'did not hold' THEN 1 END) AS did_not_hold,
       COUNT(CASE WHEN verdict = 'no pattern' THEN 1 END) AS no_pattern,
       COUNT(CASE WHEN verdict = 'too few' THEN 1 END) AS too_few,
       COUNT(*) AS kinds,                                   -- kinds of move × horizons
       ROUND(100 * MAX(round_trip_cost), 2) AS cost_pct     -- the round-trip cost every verdict pays
FROM market_evidence`,
  },
  {
    id: 'patterns_held',
    kind: 'metric',
    name: 'Patterns that held up',
    description: 'Each kind of move whose side, chosen on 2020–2024, still made money after costs from 2025, with one row for each market in that group right now.',
    columns: [{ name: 'direction', label: 'Direction' }, { name: 'z_band', label: 'Size band' }, COL.liquidity,
      { name: 'horizon_hours', label: 'Over (hours)' }, { name: 'side', label: 'Side' },
      { name: 'held_back_pct', label: 'From 2025', format: 'pct', title: 'A trade from 2025 on, after the round-trip cost' },
      { name: 'held_back_t', label: 't from 2025' }, { name: 'held_back_days', label: 'Days from 2025' },
      { name: 'in_sample_t', label: 't 2020–2024' }, { name: 'in_sample_days', label: 'Days 2020–2024' },
      { name: 'events', label: 'Moves' }, { name: 'days', label: 'Days' }, { name: 'cost_pct', label: 'Cost', format: 'pct_plain' },
      { ...COL.market, label: 'Right now' }, { ...COL.z, format: 'z_tag' }],
    each: { panel: 'moves', set: { direction: 'direction', z_band: 'z_band', liquidity: 'liquidity', horizon: 'horizon_hours' } },
    sql: `SELECT e.direction,
       e.z_band,
       e.liquidity,
       e.horizon_hours,
       e.side,                                              -- fade (bet it reverses) or follow
       ROUND(100 * e.held_back_net_after_cost, 2) AS held_back_pct,   -- a trade from 2025, after costs
       ROUND(e.held_back_t, 1) AS held_back_t,
       e.held_back_days,
       ROUND(e.in_sample_t, 1) AS in_sample_t,              -- 2020-2024, where the side was chosen
       e.in_sample_days,
       e.events,
       e.days,
       ROUND(100 * e.round_trip_cost, 2) AS cost_pct,
       f.symbol AS market,                                  -- a tested market of the type chosen, in this group right now
       ROUND(f.z, 1) AS z
FROM market_evidence e
LEFT JOIN flagged f ON f.tested = 1
                   AND :kind IN ('all', f.market_type)
                   AND f.direction = e.direction
                   AND (e.z_band = 'all' OR (f.z_band = e.z_band AND f.liquidity = e.liquidity))
WHERE e.verdict = 'held up'
ORDER BY e.held_back_net_after_cost DESC, e.direction, e.z_band, e.liquidity, e.horizon_hours, ABS(f.z) DESC`,
  },
  {
    id: 'patterns_grid',
    kind: 'metric',
    name: 'Every kind of move',
    description: 'Each kind of move (direction, size band, liquidity, and every up or down move together), how many markets are in it right now, and its verdict over the next 1, 4 and 24 hours.',
    columns: [{ name: 'direction', label: 'Direction' }, { name: 'z_band', label: 'Size band' }, COL.liquidity,
      { name: 'now', label: 'Now', format: 'int', title: 'Tested markets of the type chosen in this group right now' },
      ...verdictCols.filter((c) => c.format === 'verdict').map(({ sub, ...c }) => ({ ...c, drill: kindDrill({ horizon: c.hours }) }))],
    sql: `SELECT v.direction,
       v.z_band,
       v.liquidity,
       COUNT(f.symbol) AS now,                              -- tested markets of the type chosen, in this group right now
       v.next_1h, v.next_4h, v.next_24h
FROM verdicts v
LEFT JOIN flagged f ON f.tested = 1
                   AND :kind IN ('all', f.market_type)
                   AND f.direction = v.direction
                   AND (v.z_band = 'all' OR (f.z_band = v.z_band AND f.liquidity = v.liquidity))
GROUP BY v.direction, v.z_band, v.liquidity, v.next_1h, v.next_4h, v.next_24h
ORDER BY CASE v.direction WHEN 'up' THEN 1 ELSE 2 END,
         CASE v.z_band WHEN '3-4' THEN 1 WHEN '4-6' THEN 2 WHEN '6+' THEN 3 ELSE 4 END,
         CASE v.liquidity WHEN 'large' THEN 1 WHEN 'mid' THEN 2 WHEN 'small' THEN 3 ELSE 4 END`,
  },

  /* ---------- the Insights view: graphs (lakehouse step 32) ---------- */
  // These read the Insights tables (market_events, market_hours), loaded when the view opens, and the
  // page's two choices: :direction (up or down moves) and :horizon (the next 1, 4 or 24 hours). A click
  // on a graph opens the moves behind it, filtered by :year, :hour, :bucket, :z_band, :liquidity or
  // :symbol (NULL means no filter). The SQL is written to run in Databricks too (MEDIAN, CONCAT, SUBSTR).
  {
    id: 'moves',
    kind: 'model',
    name: 'Past moves',
    description: 'Every unusual move since 2020 in the direction chosen, with what the price did over the hours chosen: + continued, − reversed.',
    sql: `SELECT symbol,
       market_type,                                 -- crypto, stock, commodity or other
       event_date,
       event_hour,                                  -- the first hour whose close was unusual (UTC)
       SUBSTR(CAST(event_date AS STRING), 1, 4) AS year,
       hour_of_day,                                 -- 0-23, the UTC hour of event_hour
       z,
       z_band,
       liquidity,
       period,                                      -- in_sample (2020-2024) or held_back (2025 on)
       kept_going_pct,
       CASE WHEN kept_going_pct < -10 THEN -11      -- 1% steps: -3 holds -3% to -2%,
            WHEN kept_going_pct >= 10 THEN 10       --   the ends everything beyond 10% either way
            ELSE CAST(FLOOR(kept_going_pct) AS INTEGER)
       END AS bucket
FROM (SELECT *,
             100 * CASE WHEN direction = 'up' THEN 1 ELSE -1 END     -- + continued, - reversed
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END
               AS kept_going_pct                    -- the price change over the hours chosen, in %
      FROM market_events
      WHERE :direction IN ('all', direction)
        AND :kind IN ('all', market_type)) e
WHERE kept_going_pct IS NOT NULL                    -- empty when the market stopped trading or the data ends`,
  },
  {
    id: 'moves_picked',
    kind: 'model',
    name: 'The moves picked',
    description: 'The past moves behind what was clicked: a year, an hour, a 1% step of the outcome, a size band, a liquidity group, one market, a period, those that continued or reversed, or a worst 5%. A parameter that is NULL doesn\'t filter.',
    sql: `SELECT *
FROM moves
WHERE (:year IS NULL OR year = :year)
  AND (:hour IS NULL OR hour_of_day = :hour)
  AND (:bucket IS NULL OR bucket = :bucket)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
  AND (:symbol IS NULL OR symbol = :symbol)
  AND (:period IS NULL OR period = :period)
  AND (:kept IS NULL OR CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END = :kept)  -- 1 continued, 0 reversed
  AND (:at_least IS NULL OR kept_going_pct >= :at_least)   -- the worst 5% that kept going
  AND (:at_most IS NULL OR kept_going_pct <= :at_most)     -- the worst 5% that turned back`,
  },
  {
    id: 'hour_stats',
    kind: 'model',
    name: 'The market by hour',
    description: 'The market\'s move in each UTC hour, pooled over the years of each period (the lakehouse keeps sums, so the years add up exactly).',
    sql: `SELECT utc_hour,
       liquidity,                                   -- large, mid, small, or all
       period,                                      -- in_sample (2020-2024) or held_back (2025 on)
       SUM(days) AS days,
       SUM(sum_return) / SUM(days) AS avg_return,   -- the average day's move in this hour
       SQRT((SUM(sum_sq_return) - SUM(sum_return) * SUM(sum_return) / SUM(days))
            / (SUM(days) - 1)) AS sd_return,        -- how much the days vary
       SUM(up_days) AS up_days
FROM market_hours
WHERE market_type = :kind                           -- the type chosen at the top ('all': every market)
GROUP BY utc_hour, liquidity, period`,
  },
  {
    id: 'past_kinds',
    kind: 'model',
    name: 'Past moves by kind',
    description: 'Each kind of move on each type of market: how many moves there were, on how many days, and what they did next, over every year and from 2025 only (period held_back). The lakehouse calculates the percentiles once a day. With fewer than 20 days behind a number it stays empty, as in the verdicts.',
    sql: `SELECT market_type,
       direction,
       z_band,
       liquidity,
       period,                                      -- all, or held_back (from 2025)
       MAX(CASE WHEN horizon_hours = hours THEN moves END) AS moves,
       MAX(CASE WHEN horizon_hours = hours THEN days END) AS days,
       ROUND(100 * MAX(CASE WHEN horizon_hours = 1 AND days >= 20 THEN median_continuation END), 2) AS next_1h,
       ROUND(100 * MAX(CASE WHEN horizon_hours = 4 AND days >= 20 THEN median_continuation END), 2) AS next_4h,
       ROUND(100 * MAX(CASE WHEN horizon_hours = 24 AND days >= 20 THEN median_continuation END), 2) AS next_24h,
       ROUND(100 * MAX(CASE WHEN horizon_hours = hours AND days >= 20 THEN hit_rate END), 0) AS kept_going_share,
       ROUND(100 * MAX(CASE WHEN horizon_hours = hours AND days >= 20 THEN p95_continuation END), 2) AS worst_kept_going,
       ROUND(100 * MAX(CASE WHEN horizon_hours = hours AND days >= 20 THEN p05_continuation END), 2) AS worst_turned_back
FROM (SELECT *,
             CASE :horizon WHEN 1 THEN 1 WHEN 24 THEN 24 ELSE 4 END AS hours   -- the hours chosen
      FROM market_outcomes) o
GROUP BY market_type, direction, z_band, liquidity, period`,
  },
  {
    id: 'past_own',
    kind: 'model',
    name: 'Each market\'s own past moves',
    description: 'How many unusual moves each market that is unusual now has had, by direction and type, and what the middle one did over the hours chosen, from 5 moves on. The type is kept because a ticker can change hands.',
    sql: `SELECT symbol,
       market_type,
       direction,
       COUNT(*) AS moves,
       CASE WHEN COUNT(*) >= 5 THEN ROUND(MEDIAN(over_hours), 2) END AS median_pct
FROM (SELECT symbol, market_type, direction,
             100 * CASE WHEN direction = 'up' THEN 1 ELSE -1 END
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END
               AS over_hours
      FROM market_events
      WHERE symbol IN (SELECT symbol FROM flagged)) e   -- only the markets unusual now: this runs every second
WHERE over_hours IS NOT NULL
GROUP BY symbol, market_type, direction`,
  },
  {
    id: 'insight_live_map',
    kind: 'metric',
    name: 'Every market right now',
    description: 'Each market\'s move today in its usual daily moves (z, across) against the volume of its last 24 hours compared with a usual day (up), coloured by whether it is unusual and whether its kind of move has a tested pattern. Live.',
    columns: [COL.market, { name: 'z_axis', label: 'z (σ), at most ±12 on the graph', format: 'z' }, { name: 'volume_x', label: 'Volume against a usual day', format: 'times' },
      COL.today, COL.z, COL.liquidity, { name: 'state', label: 'State' }],
    chart: { type: 'scatter', x: 'z_axis', y: 'volume_x', ylog: true, label: 'market', color: 'state', xunit: '',
      colors: { 'Unusual, a pattern held up': 0, 'Unusual, no tested edge': 1, Normal: 'muted' },
      tip: ['today_pct', 'z', 'liquidity', 'state'], drill: { panel: 'market', set: { symbol: 'market' } } },
    sql: `SELECT t.symbol AS market,
       CASE WHEN t.z > 12 THEN 12 WHEN t.z < -12 THEN -12 ELSE ROUND(t.z, 2) END AS z_axis,   -- kept on the graph
       ROUND(t.volume_x, 2) AS volume_x,            -- the last 24 hours ÷ a usual day
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN 'Normal'
            WHEN f.tested = 1 AND h.direction IS NOT NULL THEN 'Unusual, a pattern held up'
            ELSE 'Unusual, no tested edge'
       END AS state
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN (SELECT DISTINCT direction, z_band, liquidity      -- kinds of move that held up over the hours chosen
           FROM market_evidence
           WHERE verdict = 'held up'
             AND :horizon IN (0, horizon_hours)) h
       ON h.direction = f.direction AND h.z_band = f.z_band AND h.liquidity = f.liquidity
WHERE t.z IS NOT NULL
  AND t.volume_x > 0
  AND :kind IN ('all', t.market_type)
  AND :direction IN ('all', CASE WHEN t.z > 0 THEN 'up' ELSE 'down' END)`,
  },
  {
    id: 'playbook',
    kind: 'metric',
    name: 'Playbook for the unusual markets',
    description: 'Each market that is unusual right now, and what similar past moves did next. Before costs. Live.',
    show: 100,
    columns: [{ ...COL.market, drill: ownDrill }, { ...COL.z, format: 'z_tag' },
      { name: 'kind_of_move', label: 'Kind of move', title: 'The group of past moves this one is compared with: direction, size, and how much the market trades', drill: kindDrill() },
      { name: 'verdict', label: 'Verdict', format: 'verdict', title: 'Whether this group passed the test, over the hours chosen. The only column that has', drill: kindDrill() },
      { name: 'moves', label: 'Past moves', format: 'int', under: { col: 'days', text: 'on {} days', format: 'int', drill: kindDrill() }, title: 'How many times any market of this type made a move in this group, and on how many days', drill: kindDrill() },
      ...[1, 4, 24].map((h) => ({ name: `next_${h}h`, label: `Next ${h} h`, format: 'pct', under: { col: `recent_${h}h`, text: 'from 2025 {}', format: 'pct', drill: kindDrill({ horizon: h, ...FROM_2025 }) }, title: `The middle result ${h} ${h === 1 ? 'hour' : 'hours'} later: + continued, − reversed`, drill: kindDrill({ horizon: h }) })),
      { name: 'kept_going_share', label: 'Kept going', format: 'share', under: { col: 'recent_kept_going', text: 'from 2025 {}', format: 'share', drill: kindDrill({ kept: 1, ...FROM_2025 }) }, title: 'How often the move continued over the hours chosen', drill: kindDrill({ kept: 1 }) },
      { name: 'worst_kept_going', label: 'Worst 5%: kept going', format: 'pct', under: { col: 'recent_worst_kept_going', text: 'from 2025 {}', format: 'pct', drill: kindDrill(FROM_2025, { at_least: 'recent_worst_kept_going' }) }, title: 'If you bet the move would reverse: 1 time in 20 it continued at least this far by the end of the hours chosen', drill: kindDrill({}, { at_least: 'worst_kept_going' }) },
      { name: 'worst_turned_back', label: 'Worst 5%: turned back', format: 'pct', under: { col: 'recent_worst_turned_back', text: 'from 2025 {}', format: 'pct', drill: kindDrill(FROM_2025, { at_most: 'recent_worst_turned_back' }) }, title: 'If you joined the move: 1 time in 20 it reversed at least this far by the end of the hours chosen', drill: kindDrill({}, { at_most: 'worst_turned_back' }) },
      { name: 'own_median', label: 'Its own past', format: 'pct', under: { col: 'own_moves', text: '{} moves', format: 'int', drill: ownDrill }, title: 'The middle result of this market\'s own past moves in this direction, over the hours chosen, from 5 moves on', drill: ownDrill },
      ...['days', 'recent_1h', 'recent_4h', 'recent_24h', 'recent_kept_going', 'recent_worst_kept_going', 'recent_worst_turned_back', 'own_moves', 'market_type', 'direction', 'z_band', 'liquidity'].map((name) => ({ name, format: 'hidden' }))],
    sql: `SELECT f.symbol AS market,
       ROUND(f.z, 1) AS z,
       CONCAT(CASE f.direction WHEN 'up' THEN 'Up ' ELSE 'Down ' END, f.z_band, 'σ, ', f.liquidity) AS kind_of_move,
       CASE WHEN f.tested = 0 THEN 'not tested'
            ELSE CASE :horizon WHEN 1 THEN v.next_1h WHEN 24 THEN v.next_24h ELSE v.next_4h END
       END AS verdict,
       COALESCE(a.moves, 0) AS moves,               -- past moves of the same kind on the same type of market
       COALESCE(a.days, 0) AS days,
       a.next_1h,                                   -- the middle move, all years
       a.next_4h,
       a.next_24h,
       r.next_1h AS recent_1h,                      -- the same, from 2025 only
       r.next_4h AS recent_4h,
       r.next_24h AS recent_24h,
       a.kept_going_share,                          -- over the hours chosen, like the next four
       r.kept_going_share AS recent_kept_going,
       a.worst_kept_going,
       r.worst_kept_going AS recent_worst_kept_going,
       a.worst_turned_back,
       r.worst_turned_back AS recent_worst_turned_back,
       o.median_pct AS own_median,                  -- this market's own past moves in this direction
       COALESCE(o.moves, 0) AS own_moves,
       f.market_type,                               -- for the click
       f.direction,
       f.z_band,
       f.liquidity
FROM flagged f
LEFT JOIN past_kinds a ON a.period = 'all' AND a.market_type = f.market_type AND a.direction = f.direction
                      AND a.z_band = f.z_band AND a.liquidity = f.liquidity
LEFT JOIN past_kinds r ON r.period = 'held_back' AND r.market_type = f.market_type AND r.direction = f.direction
                      AND r.z_band = f.z_band AND r.liquidity = f.liquidity
LEFT JOIN past_own o ON o.symbol = f.symbol AND o.market_type = f.market_type AND o.direction = f.direction
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
WHERE :kind IN ('all', f.market_type)
  AND :direction IN ('all', f.direction)
ORDER BY ABS(f.z) DESC`,
  },
  {
    id: 'insight_patterns_map',
    kind: 'metric',
    name: 'Every kind of move at a glance',
    description: 'What each kind of move did next on the markets chosen, on average over days since 2020 (blue continued, red reversed, grey where there are too few days to judge), and its verdict: the side and its result from 2025 when the pattern held up. Stocks and commodities are not tested.',
    columns: [{ name: 'kind_of_move', label: 'Kind of move' }, { name: 'horizon', label: 'Over' },
      { name: 'avg_pct', label: 'Average next move, all years', format: 'pct' }, { name: 'verdict_text', label: 'Verdict' },
      { name: 'events', label: 'Moves', format: 'int' }, { name: 'days', label: 'Days', format: 'int' },
      { name: 'in_sample_t', label: 't 2020–2024' }, { name: 'held_back_t', label: 't from 2025' },
      { name: 'too_few', format: 'hidden' }, { name: 'direction', format: 'hidden' }, { name: 'horizon_hours', format: 'hidden' },
      { name: 'pick_band', format: 'hidden' }, { name: 'pick_liquidity', format: 'hidden' }],
    chart: { type: 'heatmap', x: 'horizon', y: 'kind_of_move', value: 'avg_pct', text: 'verdict_text', unit: '%', scale: 'x', faint: 'too_few',
      tip: ['verdict_text', 'events', 'days', 'in_sample_t', 'held_back_t'],
      drill: { panel: 'moves', set: { direction: 'direction', horizon: 'horizon_hours', z_band: 'pick_band', liquidity: 'pick_liquidity' } } },
    sql: `WITH moved AS (                                     -- the moves chosen: + continued, - reversed
  SELECT direction, z_band, liquidity, event_date,
         CASE WHEN direction = 'up' THEN 1 ELSE -1 END
           * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END AS c
  FROM market_events
  WHERE :direction IN ('all', direction)
    AND :kind IN ('all', market_type)
),
by_day AS (                                         -- days, not moves, as in the evidence
  SELECT direction, z_band, liquidity, event_date, AVG(c) AS day_c, COUNT(*) AS n
  FROM moved
  WHERE c IS NOT NULL
  GROUP BY direction, z_band, liquidity, event_date
  UNION ALL                                         -- each move also counts in every move of its direction
  SELECT direction, 'all', 'all', event_date, AVG(c), COUNT(*)
  FROM moved
  WHERE c IS NOT NULL
  GROUP BY direction, event_date
),
kinds AS (
  SELECT direction, z_band, liquidity,
         AVG(day_c) AS avg_continuation, SUM(n) AS events, COUNT(*) AS days
  FROM by_day
  GROUP BY direction, z_band, liquidity
)
SELECT CASE WHEN e.z_band = 'all' THEN CONCAT('Every ', e.direction, ' move')
            ELSE CONCAT(CASE e.direction WHEN 'up' THEN 'Up ' ELSE 'Down ' END, e.z_band, 'σ, ', e.liquidity)
       END AS kind_of_move,
       CONCAT('Next ', e.horizon_hours, ' h') AS horizon,
       ROUND(100 * k.avg_continuation, 2) AS avg_pct,  -- + continued, - reversed
       CASE WHEN :kind IN ('stock', 'commodity') THEN 'not tested'  -- no 2020-2024 years
            WHEN e.verdict = 'held up'                 -- the side, and a trade from 2025 after costs
            THEN CONCAT(e.side, ' ', ROUND(100 * e.held_back_net_after_cost, 2), '%')
            ELSE e.verdict
       END AS verdict_text,
       COALESCE(k.events, 0) AS events,
       COALESCE(k.days, 0) AS days,
       CASE WHEN :kind IN ('stock', 'commodity') THEN NULL ELSE ROUND(e.in_sample_t, 1) END AS in_sample_t,
       CASE WHEN :kind IN ('stock', 'commodity') THEN NULL ELSE ROUND(e.held_back_t, 1) END AS held_back_t,
       CASE WHEN COALESCE(k.days, 0) < 20                                         -- drawn grey: too thin to judge
              OR (e.verdict = 'too few' AND :kind NOT IN ('stock', 'commodity')) THEN 1 ELSE 0
       END AS too_few,
       e.direction,
       e.horizon_hours,
       CASE WHEN e.z_band = 'all' THEN NULL ELSE e.z_band END AS pick_band,       -- for the click
       CASE WHEN e.liquidity = 'all' THEN NULL ELSE e.liquidity END AS pick_liquidity
FROM market_evidence e
LEFT JOIN kinds k ON k.direction = e.direction AND k.z_band = e.z_band AND k.liquidity = e.liquidity
WHERE :direction IN ('all', e.direction)            -- the moves and hours chosen at the top
  AND :horizon IN (0, e.horizon_hours)
ORDER BY CASE e.direction WHEN 'up' THEN 1 ELSE 2 END,
         CASE e.z_band WHEN 'all' THEN 0 WHEN '3-4' THEN 1 WHEN '4-6' THEN 2 ELSE 3 END,
         CASE e.liquidity WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END,
         e.horizon_hours`,
  },
  {
    id: 'insight_by_year',
    kind: 'metric',
    name: 'Year by year',
    description: 'What the moves did next, year by year: the median (the middle move) and the average (pulled by a few big ones). A pattern worth trusting shows up every year, not in one.',
    columns: [{ name: 'year', label: 'Year' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'median_pct', label: 'Median', format: 'pct' }, { name: 'average_pct', label: 'Average', format: 'pct' },
      { name: 'kept_going_share', label: 'Kept going', format: 'share' }],
    chart: { type: 'bar', x: 'year', y: ['median_pct', 'average_pct'], unit: '%', tip: ['moves', 'kept_going_share'],
      drill: { panel: 'moves', set: { year: 'year' } } },
    sql: `SELECT year,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,   -- half the moves did better, half worse
       ROUND(AVG(kept_going_pct), 2) AS average_pct,     -- moved by a few big ones
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves
GROUP BY year
ORDER BY year`,
  },
  {
    id: 'insight_spread',
    kind: 'metric',
    name: 'Spread of outcomes',
    description: 'How many moves ended in each 1% step over the hours chosen: how often a move reversed, continued, or ran far either way. The tails are the risk of taking a side.',
    columns: [{ name: 'from_pct', label: 'From (%)' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'share_pct', label: 'Share of moves', format: 'pct_plain' }, { name: 'range_text', label: 'Outcome' }, { name: 'bucket', format: 'hidden' }],
    chart: { type: 'bar', x: 'from_pct', y: 'moves', sign: 'bucket', unit: '', pos_label: 'Continued', neg_label: 'Reversed',
      tip: ['range_text', 'share_pct'], drill: { panel: 'moves', set: { bucket: 'bucket' } } },
    sql: `SELECT CASE WHEN bucket = -11 THEN '<-10' WHEN bucket = 10 THEN '10+' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN 'reversed more than 10%'
            WHEN bucket = 10 THEN 'continued 10% or more'
            ELSE CONCAT(bucket, '% to ', bucket + 1, '%')
       END AS range_text,
       bucket
FROM moves
GROUP BY bucket
ORDER BY bucket`,
  },
  {
    id: 'insight_by_hour',
    kind: 'metric',
    name: 'By the hour of the move',
    description: 'What the moves did next by the UTC hour they became unusual (the median move). India is UTC + 5:30.',
    columns: [{ name: 'hour', label: 'Hour (UTC)' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'median_pct', label: 'Median', format: 'pct' }, { name: 'average_pct', label: 'Average', format: 'pct' },
      { name: 'kept_going_share', label: 'Kept going', format: 'share' }],
    chart: { type: 'bar', x: 'hour', y: 'median_pct', sign: true, unit: '%', pos_label: 'Continued (median)', neg_label: 'Reversed (median)',
      tip: ['average_pct', 'moves', 'kept_going_share'], drill: { panel: 'moves', set: { hour: 'hour' } } },
    sql: `SELECT hour_of_day AS hour,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves
GROUP BY hour_of_day
ORDER BY hour_of_day`,
  },
  {
    id: 'insight_by_group',
    kind: 'metric',
    name: 'By size and liquidity',
    description: 'The median next move for each size of move (in usual daily moves) and each liquidity group (average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below).',
    columns: [{ name: 'size', label: 'Size' }, { name: 'markets', label: 'Markets' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'median_pct', label: 'Median', format: 'pct' }, { name: 'average_pct', label: 'Average', format: 'pct' },
      { name: 'kept_going_share', label: 'Kept going', format: 'share' }, { name: 'z_band', format: 'hidden' }, { name: 'liquidity', format: 'hidden' }],
    chart: { type: 'heatmap', x: 'markets', y: 'size', value: 'median_pct', unit: '%', tip: ['average_pct', 'moves', 'kept_going_share'],
      drill: { panel: 'moves', set: { z_band: 'z_band', liquidity: 'liquidity' } } },
    sql: `SELECT CASE z_band WHEN '3-4' THEN '3 to 4σ' WHEN '4-6' THEN '4 to 6σ' ELSE '6σ or more' END AS size,
       CASE liquidity WHEN 'large' THEN 'Large markets' WHEN 'mid' THEN 'Mid' ELSE 'Small' END AS markets,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       z_band,
       liquidity
FROM moves
GROUP BY z_band, liquidity
ORDER BY z_band, CASE liquidity WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END`,
  },
  {
    id: 'insight_hour_drift',
    kind: 'metric',
    name: 'The market by hour of the day',
    description: 'The average move of the markets chosen in each UTC hour, in basis points (0.01%), in 2020–2024 and again from 2025, before costs. An hour that leaned one way in 2020–2024 only counts if it kept leaning that way from 2025.',
    columns: [{ name: 'hour', label: 'Hour (UTC)' }, { name: 'in_sample_bp', label: '2020–2024 (bp)' }, { name: 'held_back_bp', label: 'From 2025 (bp)' },
      { name: 'in_sample_t', label: 't 2020–2024' }, { name: 'held_back_t', label: 't from 2025' }, { name: 'verdict', label: 'Verdict' },
      { name: 'in_sample_days', label: 'Days 2020–2024', format: 'int' }, { name: 'held_back_days', label: 'Days from 2025', format: 'int' }],
    chart: { type: 'bar', x: 'hour', y: ['in_sample_bp', 'held_back_bp'], unit: 'bp', tip: ['in_sample_t', 'held_back_t', 'verdict'],
      drill: { panel: 'drift', set: { hour: 'hour' } } },
    sql: `SELECT hour,
       in_sample_bp,
       held_back_bp,
       in_sample_t,
       held_back_t,
       CASE WHEN in_sample_t IS NULL THEN 'not tested'                         -- no 2020-2024 years: stocks and commodities
            WHEN ABS(in_sample_t) < 2 THEN 'no pattern'                        -- nothing to choose in 2020-2024
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN 'held up'
            ELSE 'did not hold'
       END AS verdict,
       in_sample_days,
       held_back_days
FROM (SELECT h.utc_hour AS hour,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,                   -- 1 bp = 0.01%
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t,
             i.days AS in_sample_days,
             h.days AS held_back_days
      FROM hour_stats h
      LEFT JOIN hour_stats i ON i.utc_hour = h.utc_hour AND i.liquidity = h.liquidity AND i.period = 'in_sample'
      WHERE h.period = 'held_back'
        AND h.liquidity = 'all') s
ORDER BY hour`,
  },

  /* ---------- the windows a graph or a number opens ---------- */
  {
    id: 'now_in_group',
    kind: 'metric',
    name: 'Markets in this group right now',
    description: 'The tested markets of the type chosen that are in this kind of move right now.',
    columns: [COL.market, COL.price, COL.today, { ...COL.z, format: 'z_tag' }, COL.liquidity],
    sql: `SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z,
       liquidity
FROM flagged
WHERE tested = 1
  AND :kind IN ('all', market_type)
  AND :direction IN ('all', direction)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
ORDER BY ABS(z) DESC`,
  },
  {
    id: 'kinds_with_verdict',
    kind: 'metric',
    name: 'Kinds of move with this verdict',
    description: 'Every kind of move and horizon with the verdict clicked, and how many moves stand behind each. Click one for its moves.',
    columns: [{ name: 'kind_of_move', label: 'Kind of move' }, { name: 'horizon', label: 'Over' }, { name: 'verdict_text', label: 'Verdict' },
      { name: 'events', label: 'Moves', format: 'int' }, { name: 'days', label: 'Days', format: 'int' },
      { name: 'direction', format: 'hidden' }, { name: 'z_band', format: 'hidden' }, { name: 'liquidity', format: 'hidden' }, { name: 'horizon_hours', format: 'hidden' }],
    each: { panel: 'moves', set: { direction: 'direction', z_band: 'z_band', liquidity: 'liquidity', horizon: 'horizon_hours' } },
    sql: `SELECT CASE WHEN z_band = 'all' THEN CONCAT('Every ', direction, ' move')
            ELSE CONCAT(CASE direction WHEN 'up' THEN 'Up ' ELSE 'Down ' END, z_band, 'σ, ', liquidity)
       END AS kind_of_move,
       CONCAT('Next ', horizon_hours, ' h') AS horizon,
       CASE WHEN verdict = 'held up' THEN CONCAT(side, ' ', ROUND(100 * held_back_net_after_cost, 2), '%')
            ELSE verdict
       END AS verdict_text,
       events,
       days,
       direction,
       z_band,
       liquidity,
       horizon_hours
FROM market_evidence
WHERE verdict = :verdict
ORDER BY CASE direction WHEN 'up' THEN 1 ELSE 2 END,
         CASE z_band WHEN 'all' THEN 0 WHEN '3-4' THEN 1 WHEN '4-6' THEN 2 ELSE 3 END,
         CASE liquidity WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END,
         horizon_hours`,
  },
  {
    id: 'moves_summary',
    kind: 'metric',
    name: 'The middle move',
    description: 'The moves picked: how many, and what the middle one (the median), the average and the share that continued did over the hours chosen.',
    card: { value: '{median_pct:pct}', sub: '{moves:int} moves on {days:int} days · average {average_pct:pct} · {kept_going_share:share} continued' },
    sql: `SELECT COUNT(*) AS moves,
       COUNT(DISTINCT event_date) AS days,
       COUNT(DISTINCT symbol) AS markets,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       CASE :horizon WHEN 0 THEN 4 ELSE :horizon END AS hours
FROM moves_picked`,
  },
  {
    id: 'moves_spread',
    kind: 'metric',
    name: 'Spread of outcomes',
    description: 'How many of the moves picked ended in each 1% step over the hours chosen.',
    columns: [{ name: 'from_pct', label: 'From (%)' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'share_pct', label: 'Share of moves', format: 'pct_plain' }, { name: 'range_text', label: 'Outcome' }, { name: 'bucket', format: 'hidden' }],
    chart: { type: 'bar', x: 'from_pct', y: 'moves', sign: 'bucket', unit: '', pos_label: 'Continued', neg_label: 'Reversed',
      tip: ['range_text', 'share_pct'], drill: { panel: 'moves', set: { bucket: 'bucket' } } },
    sql: `SELECT CASE WHEN bucket = -11 THEN '<-10' WHEN bucket = 10 THEN '10+' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN 'reversed more than 10%'
            WHEN bucket = 10 THEN 'continued 10% or more'
            ELSE CONCAT(bucket, '% to ', bucket + 1, '%')
       END AS range_text,
       bucket
FROM moves_picked
GROUP BY bucket
ORDER BY bucket`,
  },
  {
    id: 'moves_by_year',
    kind: 'metric',
    name: 'Year by year',
    description: 'The moves picked, year by year: the median and the average next move.',
    columns: [{ name: 'year', label: 'Year' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'median_pct', label: 'Median', format: 'pct' }, { name: 'average_pct', label: 'Average', format: 'pct' },
      { name: 'kept_going_share', label: 'Kept going', format: 'share' }],
    chart: { type: 'bar', x: 'year', y: ['median_pct', 'average_pct'], unit: '%', tip: ['moves', 'kept_going_share'],
      drill: { panel: 'moves', set: { year: 'year' } } },
    sql: `SELECT year,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves_picked
GROUP BY year
ORDER BY year`,
  },
  {
    id: 'moves_list',
    kind: 'metric',
    name: 'The moves themselves',
    description: 'The newest 300 of the moves picked, each with what it did over the hours chosen. Click a market for only its moves.',
    show: 100,
    columns: [{ ...COL.market, drill: { panel: 'moves', set: { symbol: 'market' } } }, { name: 'event_hour', label: 'When (UTC)' }, { ...COL.z, format: 'z_tag' },
      { name: 'z_band', label: 'Size band' }, COL.liquidity, { name: 'kept_going_pct', label: 'Then', format: 'pct', title: '+ continued, − reversed, over the hours chosen' },
      { name: 'period', label: 'Period', format: 'period' }],
    sql: `SELECT symbol AS market,
       event_hour,
       ROUND(z, 1) AS z,
       z_band,
       liquidity,
       ROUND(kept_going_pct, 2) AS kept_going_pct,
       period
FROM moves_picked
ORDER BY event_hour DESC
LIMIT 300`,
  },
  {
    id: 'drift_by_year',
    kind: 'metric',
    name: 'This hour, year by year',
    description: 'The average move of the markets chosen in the hour picked, each year, in basis points (0.01%), before costs.',
    columns: [{ name: 'year', label: 'Year' }, { name: 'avg_bp', label: 'Average (bp)' }, { name: 't', label: 't' },
      { name: 'days', label: 'Days', format: 'int' }, { name: 'up_share', label: 'Days up', format: 'share' }],
    chart: { type: 'bar', x: 'year', y: 'avg_bp', sign: true, unit: 'bp', pos_label: 'Rose on average', neg_label: 'Fell on average', tip: ['t', 'days', 'up_share'] },
    sql: `SELECT year,
       ROUND(10000 * s / n, 2) AS avg_bp,
       ROUND((s / n) / (SQRT((sq - s * s / n) / (n - 1)) / SQRT(n)), 1) AS t,
       n AS days,
       ROUND(100.0 * up / n, 0) AS up_share
FROM (SELECT year, SUM(sum_return) AS s, SUM(sum_sq_return) AS sq, SUM(days) AS n, SUM(up_days) AS up
      FROM market_hours
      WHERE utc_hour = :hour
        AND liquidity = 'all'
        AND market_type = :kind
      GROUP BY year) y
ORDER BY year`,
  },
  {
    id: 'drift_by_liquidity',
    kind: 'metric',
    name: 'This hour, by liquidity',
    description: 'The hour picked for each liquidity group: its average move in 2020–2024 and from 2025, with t (beyond ±2 is unlikely to be chance), before costs.',
    columns: [{ name: 'liquidity', label: 'Markets', format: 'liquidity' }, { name: 'in_sample_bp', label: '2020–2024 (bp)' }, { name: 'in_sample_t', label: 't 2020–2024' },
      { name: 'held_back_bp', label: 'From 2025 (bp)' }, { name: 'held_back_t', label: 't from 2025' }, { name: 'verdict', label: 'Verdict' }],
    sql: `SELECT liquidity,
       in_sample_bp,
       in_sample_t,
       held_back_bp,
       held_back_t,
       CASE WHEN in_sample_t IS NULL THEN 'not tested'
            WHEN ABS(in_sample_t) < 2 THEN 'no pattern'
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN 'held up'
            ELSE 'did not hold'
       END AS verdict
FROM (SELECT h.liquidity,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t
      FROM hour_stats h
      LEFT JOIN hour_stats i ON i.utc_hour = h.utc_hour AND i.liquidity = h.liquidity AND i.period = 'in_sample'
      WHERE h.period = 'held_back'
        AND h.utc_hour = :hour) s
ORDER BY CASE liquidity WHEN 'all' THEN 0 WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END`,
  },
];
