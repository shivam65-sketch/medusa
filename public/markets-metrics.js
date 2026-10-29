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
//   market_hours      the whole market's move in each UTC hour by year (gold.hour_drift): the
//                     Insights data, one gzip file loaded when Insights opens (lakehouse step 32)
// Parameters, filled in by the page:
//   :kind       the type chosen at the top of the page: all, crypto, stock, commodity or other
//   :yesterday  yesterday's date (UTC), the day today's move is measured from
//   :symbol     one market, for its details (NULL in a graph's window: every market)
//   :direction  Insights: up or down moves;  :horizon  Insights: the next 1, 4 or 24 hours
//   :year, :hour, :bucket, :z_band, :liquidity   what a click on a graph picked (NULL: no filter)
//
// How a result is shown: `columns` gives each column's label and format (a column a query returns
// that isn't listed is shown as it comes); `card` is a summary card's text, where {column:format} is
// filled in from the first row; `chart` draws the result as a graph (markets-charts.js), and `drill`
// is what a click on a table's row opens.
// The same rule as the lakehouse's intraday_events.sql: a move is unusual at 3 or more of the market's
// usual daily moves (|z| >= 3), in size bands 3-4, 4-6 and 6+.

const Z_TIP = "Today's move ÷ the market's usual daily move (σ). 3σ or more is unusual.";
const LIQ_TIP = 'Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below';

const COL = {
  market: { name: 'market', label: 'Market', format: 'market' },
  price: { name: 'price', label: 'Price', format: 'price' },
  today: { name: 'today_pct', label: 'Today', format: 'pct' },
  z: { name: 'z', label: 'z (σ)', format: 'z', title: Z_TIP },
  liquidity: { name: 'liquidity', label: 'Liquidity', format: 'liquidity', title: LIQ_TIP },
};
const verdictCols = [1, 4, 24].flatMap((h) => [
  { name: `next_${h}h`, label: `Next ${h} h`, format: 'verdict', sub: `all_${h}h` },
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
       END AS z_band                                        -- the size band
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
    columns: [COL.market, COL.price, COL.today, { ...COL.z, format: 'z_tag' }, COL.liquidity, ...verdictCols],
    sql: `SELECT f.symbol AS market,
       f.price,
       ROUND(100 * f.move, 2) AS today_pct,
       ROUND(f.z, 1) AS z,
       f.liquidity,
       v.next_1h, v.next_4h, v.next_24h,             -- moves of the same kind
       w.next_1h AS all_1h,                          -- every move in the same direction
       w.next_4h AS all_4h,
       w.next_24h AS all_24h
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
      ...verdictCols.filter((c) => c.format === 'verdict').map(({ sub, ...c }) => c)],
    sql: `SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       f.direction,                                  -- its kind of move, when unusual
       f.z_band,
       v.next_1h, v.next_4h, v.next_24h              -- what moves of that kind did next
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
    sql: `SELECT e.direction,
       e.z_band,
       e.liquidity,
       e.horizon_hours,
       e.side,                                              -- fade (bet it turns back) or follow
       ROUND(100 * e.held_back_net_after_cost, 2) AS held_back_pct,   -- a trade from 2025, after costs
       ROUND(e.held_back_t, 1) AS held_back_t,
       e.held_back_days,
       ROUND(e.in_sample_t, 1) AS in_sample_t,              -- 2020-2024, where the side was chosen
       e.in_sample_days,
       e.events,
       e.days,
       ROUND(100 * e.round_trip_cost, 2) AS cost_pct,
       f.symbol AS market,                                  -- a market in this group right now (any type)
       ROUND(f.z, 1) AS z
FROM market_evidence e
LEFT JOIN flagged f ON f.direction = e.direction
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
      { name: 'now', label: 'Now', format: 'int', title: 'Markets in this group right now (any type)' },
      ...verdictCols.filter((c) => c.format === 'verdict').map(({ sub, ...c }) => c)],
    sql: `SELECT v.direction,
       v.z_band,
       v.liquidity,
       COUNT(f.symbol) AS now,                              -- markets in this group right now (any type)
       v.next_1h, v.next_4h, v.next_24h
FROM verdicts v
LEFT JOIN flagged f ON f.direction = v.direction
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
    description: 'Every unusual move since 2020 in the direction chosen, with what the price did over the hours chosen: + kept going, − turned back.',
    sql: `SELECT symbol,
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
             100 * CASE WHEN direction = 'up' THEN 1 ELSE -1 END     -- + kept going, - turned back
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 4 THEN fwd_return_4h ELSE fwd_return_24h END
               AS kept_going_pct                    -- the price change over the next :horizon hours, in %
      FROM market_events
      WHERE direction = :direction) e
WHERE kept_going_pct IS NOT NULL                    -- empty when the market stopped trading or the data ends`,
  },
  {
    id: 'moves_picked',
    kind: 'model',
    name: 'The moves picked',
    description: 'The past moves behind what was clicked: a year, an hour, a 1% step of the outcome, a size band, a liquidity group or one market. A parameter that is NULL doesn\'t filter.',
    sql: `SELECT *
FROM moves
WHERE (:year IS NULL OR year = :year)
  AND (:hour IS NULL OR hour_of_day = :hour)
  AND (:bucket IS NULL OR bucket = :bucket)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
  AND (:symbol IS NULL OR symbol = :symbol)`,
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
GROUP BY utc_hour, liquidity, period`,
  },
  {
    id: 'insight_live_map',
    kind: 'metric',
    name: 'Every market right now',
    description: 'Each market\'s move today in its usual daily moves (z, across) against the volume of its last 24 hours compared with a usual day (up), coloured by whether it is unusual and whether its kind of move has a tested pattern. Live.',
    columns: [COL.market, { name: 'z_axis', label: 'z (σ), at most ±12 on the graph', format: 'z' }, { name: 'volume_x', label: 'Volume against a usual day', format: 'times' },
      COL.today, { ...COL.z, label: 'z (σ)' }, COL.liquidity, { name: 'state', label: 'State' }],
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
            WHEN h.direction IS NOT NULL THEN 'Unusual, a pattern held up'
            ELSE 'Unusual, no tested edge'
       END AS state
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN (SELECT DISTINCT direction, z_band, liquidity      -- kinds of move that held up at some horizon
           FROM market_evidence
           WHERE verdict = 'held up') h
       ON h.direction = f.direction AND h.z_band = f.z_band AND h.liquidity = f.liquidity
WHERE t.z IS NOT NULL
  AND t.volume_x > 0`,
  },
  {
    id: 'insight_patterns_map',
    kind: 'metric',
    name: 'Every kind of move at a glance',
    description: 'What each kind of move did next, on average over days since 2020 (blue kept going, red turned back, grey where there are too few days to judge), and its verdict: the side and its result from 2025 when the pattern held up.',
    columns: [{ name: 'kind_of_move', label: 'Kind of move' }, { name: 'horizon', label: 'Over' },
      { name: 'avg_pct', label: 'Average next move, all years', format: 'pct' }, { name: 'verdict_text', label: 'Verdict' },
      { name: 'events', label: 'Moves', format: 'int' }, { name: 'days', label: 'Days', format: 'int' },
      { name: 'in_sample_t', label: 't 2020–2024' }, { name: 'held_back_t', label: 't from 2025' },
      { name: 'too_few', format: 'hidden' }, { name: 'direction', format: 'hidden' }, { name: 'horizon_hours', format: 'hidden' },
      { name: 'pick_band', format: 'hidden' }, { name: 'pick_liquidity', format: 'hidden' }],
    chart: { type: 'heatmap', x: 'horizon', y: 'kind_of_move', value: 'avg_pct', text: 'verdict_text', unit: '%', scale: 'x', faint: 'too_few',
      tip: ['verdict_text', 'events', 'days', 'in_sample_t', 'held_back_t'],
      drill: { panel: 'moves', set: { direction: 'direction', horizon: 'horizon_hours', z_band: 'pick_band', liquidity: 'pick_liquidity' } } },
    sql: `SELECT CASE WHEN z_band = 'all' THEN CONCAT('Every ', direction, ' move')
            ELSE CONCAT(CASE direction WHEN 'up' THEN 'Up ' ELSE 'Down ' END, z_band, 'σ, ', liquidity)
       END AS kind_of_move,
       CONCAT('Next ', horizon_hours, ' h') AS horizon,
       ROUND(100 * avg_continuation, 2) AS avg_pct,  -- + kept going, - turned back
       CASE WHEN verdict = 'held up'                 -- the side, and a trade from 2025 after costs
            THEN CONCAT(side, ' ', ROUND(100 * held_back_net_after_cost, 2), '%')
            ELSE verdict
       END AS verdict_text,
       events,
       days,
       ROUND(in_sample_t, 1) AS in_sample_t,
       ROUND(held_back_t, 1) AS held_back_t,
       CASE WHEN verdict = 'too few' THEN 1 ELSE 0 END AS too_few,                -- drawn grey: too thin to judge
       direction,
       horizon_hours,
       CASE WHEN z_band = 'all' THEN NULL ELSE z_band END AS pick_band,         -- for the click
       CASE WHEN liquidity = 'all' THEN NULL ELSE liquidity END AS pick_liquidity
FROM market_evidence
ORDER BY CASE direction WHEN 'up' THEN 1 ELSE 2 END,
         CASE z_band WHEN 'all' THEN 0 WHEN '3-4' THEN 1 WHEN '4-6' THEN 2 ELSE 3 END,
         CASE liquidity WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END,
         horizon_hours`,
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
    description: 'How many moves ended in each 1% step over the hours chosen: how often a move turned back, kept going, or ran far either way. The tails are the risk of taking a side.',
    columns: [{ name: 'from_pct', label: 'From (%)' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'share_pct', label: 'Share of moves', format: 'pct_plain' }, { name: 'range_text', label: 'Outcome' }, { name: 'bucket', format: 'hidden' }],
    chart: { type: 'bar', x: 'from_pct', y: 'moves', sign: 'bucket', unit: '', pos_label: 'Kept going', neg_label: 'Turned back',
      tip: ['range_text', 'share_pct'], drill: { panel: 'moves', set: { bucket: 'bucket' } } },
    sql: `SELECT CASE WHEN bucket = -11 THEN '<-10' WHEN bucket = 10 THEN '10+' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN 'turned back more than 10%'
            WHEN bucket = 10 THEN 'kept going 10% or more'
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
    chart: { type: 'bar', x: 'hour', y: 'median_pct', sign: true, unit: '%', pos_label: 'Kept going (median)', neg_label: 'Turned back (median)',
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
    description: 'The whole market\'s average move in each UTC hour, in basis points (0.01%), in 2020–2024 and again from 2025, before costs. An hour that leaned one way in 2020–2024 only counts if it kept leaning that way from 2025.',
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
       CASE WHEN ABS(in_sample_t) < 2 THEN 'no pattern'                        -- nothing to choose in 2020-2024
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN 'held up'
            ELSE 'did not hold'
       END AS verdict,
       in_sample_days,
       held_back_days
FROM (SELECT i.utc_hour AS hour,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,                   -- 1 bp = 0.01%
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t,
             i.days AS in_sample_days,
             h.days AS held_back_days
      FROM hour_stats i
      JOIN hour_stats h ON h.utc_hour = i.utc_hour AND h.liquidity = i.liquidity AND h.period = 'held_back'
      WHERE i.period = 'in_sample'
        AND i.liquidity = 'all') s
ORDER BY hour`,
  },

  /* ---------- the windows a graph opens: the moves behind a bar or a cell ---------- */
  {
    id: 'moves_summary',
    kind: 'metric',
    name: 'The middle move',
    description: 'The moves picked: how many, and what the middle one (the median), the average and the share that kept going did over the hours chosen.',
    card: { value: '{median_pct:pct}', sub: '{moves:int} moves on {days:int} days · average {average_pct:pct} · {kept_going_share:share} kept going' },
    sql: `SELECT COUNT(*) AS moves,
       COUNT(DISTINCT event_date) AS days,
       COUNT(DISTINCT symbol) AS markets,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       :horizon AS hours
FROM moves_picked`,
  },
  {
    id: 'moves_spread',
    kind: 'metric',
    name: 'Spread of outcomes',
    description: 'How many of the moves picked ended in each 1% step over the hours chosen.',
    columns: [{ name: 'from_pct', label: 'From (%)' }, { name: 'moves', label: 'Moves', format: 'int' },
      { name: 'share_pct', label: 'Share of moves', format: 'pct_plain' }, { name: 'range_text', label: 'Outcome' }, { name: 'bucket', format: 'hidden' }],
    chart: { type: 'bar', x: 'from_pct', y: 'moves', sign: 'bucket', unit: '', pos_label: 'Kept going', neg_label: 'Turned back',
      tip: ['range_text', 'share_pct'], drill: { panel: 'moves', set: { bucket: 'bucket' } } },
    sql: `SELECT CASE WHEN bucket = -11 THEN '<-10' WHEN bucket = 10 THEN '10+' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN 'turned back more than 10%'
            WHEN bucket = 10 THEN 'kept going 10% or more'
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
    description: 'The newest 300 of the moves picked, each with what it did over the hours chosen. Click a row for every past move of that market.',
    show: 100,
    columns: [COL.market, { name: 'event_hour', label: 'When (UTC)' }, { ...COL.z, format: 'z_tag' },
      { name: 'z_band', label: 'Size band' }, COL.liquidity, { name: 'kept_going_pct', label: 'Then', format: 'pct', title: '+ kept going, − turned back, over the hours chosen' },
      { name: 'period', label: 'Period' }],
    drill: { panel: 'moves', set: { symbol: 'market' } },
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
    description: 'The whole market\'s average move in the hour picked, each year, in basis points (0.01%), before costs.',
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
       CASE WHEN ABS(in_sample_t) < 2 THEN 'no pattern'
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN 'held up'
            ELSE 'did not hold'
       END AS verdict
FROM (SELECT i.liquidity,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t
      FROM hour_stats i
      JOIN hour_stats h ON h.utc_hour = i.utc_hour AND h.liquidity = i.liquidity AND h.period = 'held_back'
      WHERE i.period = 'in_sample'
        AND i.utc_hour = :hour) s
ORDER BY CASE liquidity WHEN 'all' THEN 0 WHEN 'large' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END`,
  },
];
