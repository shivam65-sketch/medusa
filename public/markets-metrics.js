// MEDUSA Markets: every number on the Today and Patterns views, defined as SQL.
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
// Parameters, filled in by the page:
//   :kind       the type chosen at the top of the page: all, crypto, stock, commodity or other
//   :yesterday  yesterday's date (UTC), the day today's move is measured from
//   :symbol     one market, for its details
//
// How a result is shown: `columns` gives each column's label and format (a column a query returns
// that isn't listed is shown as it comes); `card` is a summary card's text, where {column:format} is
// filled in from the first row.
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
];
