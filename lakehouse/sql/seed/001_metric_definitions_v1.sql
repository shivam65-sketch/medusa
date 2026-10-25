-- 001_metric_definitions_v1.sql
-- Version 1 of every definition behind MEDUSA's Markets page: the shared steps (models) and the
-- numbers and tables (metrics). Made from public/markets-metrics.js, where they were first written
-- (lakehouse step 26). From now on the table is the master copy and a change adds a new version.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('market_now', 1, 'model', 'Each market now',
     'One row per trading market: its live price, yesterday\'s close and its normal.',
     'SELECT b.symbol,
       m.market_type,                         -- crypto, stock, commodity or other (Binance\'s contract list)
       p.price,                               -- the live price (Binance\'s stream)
       p.quote_volume_24h,                    -- USDT traded in the last 24 hours (Binance\'s stream)
       CASE WHEN b.as_of_date < :yesterday    -- the lakehouse doesn\'t have yesterday yet:
            THEN m.yesterday_close            --   yesterday\'s close from Binance\'s daily candle
            ELSE b.last_close                 -- otherwise the lakehouse\'s own close
       END AS prev_close,
       b.avg_return_30d,                      -- the market\'s normal (lakehouse): its average daily return,
       b.sd_return_30d,                       --   σ, the spread of its daily returns: its usual daily move,
       b.history_days,                        --   the days of history behind them,
       b.avg_quote_volume_30d                 --   and the USDT it trades on an average day
FROM market_baseline b
LEFT JOIN live_prices p ON p.symbol = b.symbol
LEFT JOIN binance_markets m ON m.symbol = b.symbol
WHERE b.status <> \'not trading\'',
     NULL),
    ('today', 1, 'model', 'Today\'s moves',
     'Every market\'s move today, its z (the move in its usual daily moves) and its liquidity.',
     'SELECT symbol,
       market_type,
       price,
       price / prev_close - 1 AS move,                      -- the move since yesterday\'s close
       CASE WHEN history_days >= 20 AND sd_return_30d > 0   -- scored from 20 days of history
            THEN (price / prev_close - 1 - avg_return_30d) / sd_return_30d
       END AS z,                                            -- the move in usual daily moves (σ)
       sd_return_30d,
       quote_volume_24h / NULLIF(avg_quote_volume_30d, 0) AS volume_x,   -- the last 24 hours ÷ a usual day
       CASE WHEN avg_quote_volume_30d >= 100000000 THEN \'large\'
            WHEN avg_quote_volume_30d >= 10000000 THEN \'mid\'
            ELSE \'small\'
       END AS liquidity                                     -- by the USDT it trades on an average day
FROM market_now',
     NULL),
    ('flagged', 1, 'model', 'Unusual moves',
     'The markets that have moved 3 or more of their usual daily moves today, with their kind of move.',
     'SELECT *,
       CASE WHEN z > 0 THEN \'up\' ELSE \'down\' END AS direction,
       CASE WHEN ABS(z) < 4 THEN \'3-4\'
            WHEN ABS(z) < 6 THEN \'4-6\'
            ELSE \'6+\'
       END AS z_band                                        -- the size band
FROM today
WHERE ABS(z) >= 3                                           -- unusual: 3 or more usual daily moves',
     NULL),
    ('verdicts', 1, 'model', 'Verdicts in words',
     'What each kind of move did next, one row per kind of move with a column per horizon.',
     'SELECT direction,
       z_band,
       liquidity,
       MAX(CASE WHEN horizon_hours = 1 THEN verdict_text END) AS next_1h,
       MAX(CASE WHEN horizon_hours = 4 THEN verdict_text END) AS next_4h,
       MAX(CASE WHEN horizon_hours = 24 THEN verdict_text END) AS next_24h
FROM (SELECT direction, z_band, liquidity, horizon_hours,
             CASE WHEN verdict = \'held up\'           -- the side, and what it made a trade from 2025 after costs
                  THEN side || \' \' || ROUND(100 * held_back_net_after_cost, 2) || \'%\'
                  ELSE verdict                       -- no pattern, did not hold or too few
             END AS verdict_text
      FROM market_evidence) e
GROUP BY direction, z_band, liquidity',
     NULL),
    ('breadth', 1, 'metric', 'Breadth',
     'The share of markets that are up today.',
     'SELECT COUNT(CASE WHEN move > 0 THEN 1 END) AS up,
       COUNT(CASE WHEN move < 0 THEN 1 END) AS down,
       COUNT(*) AS markets,
       ROUND(100.0 * COUNT(CASE WHEN move > 0 THEN 1 END) / NULLIF(COUNT(*), 0)) AS breadth_pct
FROM today
WHERE move IS NOT NULL                       -- markets with a live price and yesterday\'s close
  AND :kind IN (\'all\', market_type)          -- the type chosen at the top of the page',
     '{"card":{"value":"{breadth_pct:share} up","sub":"{up:int} up · {down:int} down"}}'),
    ('median_move', 1, 'metric', 'Median move',
     'The middle of today\'s moves: half of the markets moved less, half more.',
     'SELECT ROUND(100 * AVG(move), 2) AS median_pct,    -- the middle move, or the average of the two middle ones
       MAX(n) AS markets
FROM (SELECT move,
             ROW_NUMBER() OVER (ORDER BY move) AS rn,  -- each move\'s place, smallest first
             COUNT(*) OVER () AS n                      -- how many moves there are
      FROM today
      WHERE move IS NOT NULL
        AND :kind IN (\'all\', market_type)) ranked
WHERE rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))',
     '{"card":{"value":"{median_pct:pct}","sub":"of {markets:int} markets"}}'),
    ('unusual_count', 1, 'metric', 'Unusual now',
     'How many markets have moved 3 or more of their usual daily moves today.',
     'SELECT COUNT(*) AS unusual,
       COUNT(CASE WHEN direction = \'up\' THEN 1 END) AS up,
       COUNT(CASE WHEN direction = \'down\' THEN 1 END) AS down
FROM flagged
WHERE :kind IN (\'all\', market_type)',
     '{"card":{"value":"{unusual:int}","sub":"{up:int_up} up · {down:int_down} down"}}'),
    ('bitcoin', 1, 'metric', 'Bitcoin',
     'The BTCUSDT perpetual (on TradingView: BINANCE:BTCUSDT.P), not the spot market. It shows whatever type is chosen.',
     'SELECT price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE symbol = \'BTCUSDT\'',
     '{"card":{"value":"{price:price}","sub":"{today_pct:pct} · {z:z}"}}'),
    ('unusual', 1, 'metric', 'Unusual right now',
     'Every unusual market, and what moves of the same kind (direction, size band, liquidity) did next. The small line under each verdict is every move in the same direction together.',
     'SELECT f.symbol AS market,
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
LEFT JOIN verdicts w ON w.direction = f.direction AND w.z_band = \'all\' AND w.liquidity = \'all\'
WHERE :kind IN (\'all\', f.market_type)
ORDER BY ABS(f.z) DESC',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z_tag","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"next_1h","label":"Next 1 h","format":"verdict","sub":"all_1h"},{"name":"all_1h","format":"hidden"},{"name":"next_4h","label":"Next 4 h","format":"verdict","sub":"all_4h"},{"name":"all_4h","format":"hidden"},{"name":"next_24h","label":"Next 24 h","format":"verdict","sub":"all_24h"},{"name":"all_24h","format":"hidden"}]}'),
    ('gainers', 1, 'metric', 'Up the most',
     'The eight biggest gains since yesterday\'s close.',
     'SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move > 0
  AND :kind IN (\'all\', market_type)
ORDER BY move DESC
LIMIT 8',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('losers', 1, 'metric', 'Down the most',
     'The eight biggest losses since yesterday\'s close.',
     'SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move < 0
  AND :kind IN (\'all\', market_type)
ORDER BY move ASC
LIMIT 8',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('markets', 1, 'metric', 'Every market',
     'Today against each market\'s normal. The table\'s search, sort buttons and pages work on this result.',
     'SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,  -- its usual daily move (σ)
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN 0 ELSE 1 END AS unusual   -- highlighted when unusual
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
WHERE :kind IN (\'all\', t.market_type)',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain","title":"The market\'s usual daily move (σ) over its last 30 days"},{"name":"volume_x","label":"Volume","format":"times","title":"USDT traded in the last 24 hours ÷ its usual day"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"unusual","format":"hidden"}]}'),
    ('market', 1, 'metric', 'One market',
     'Every number in one market\'s row, and its kind of move with the verdicts when it is unusual.',
     'SELECT t.symbol AS market,
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
WHERE t.symbol = :symbol',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain"},{"name":"volume_x","label":"Volume","format":"times"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"next_1h","label":"Next 1 h","format":"verdict"},{"name":"next_4h","label":"Next 4 h","format":"verdict"},{"name":"next_24h","label":"Next 24 h","format":"verdict"}]}'),
    ('unusual_all_types', 1, 'metric', 'Unusual markets by kind of move',
     'Every unusual market of any type with its kind of move: the Patterns view\'s Now, and when this page first saw each one unusual.',
     'SELECT direction,
       z_band,
       liquidity,
       symbol AS market,
       ROUND(z, 1) AS z
FROM flagged
ORDER BY ABS(z) DESC',
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"market","label":"Market","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."}]}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 26)')
