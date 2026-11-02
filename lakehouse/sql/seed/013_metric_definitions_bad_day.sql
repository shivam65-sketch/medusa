-- 013_metric_definitions_bad_day.sql
-- The next version of 3 definitions (lakehouse step 32.2): each market's bad day, how far it fell on 1 day in 20,
-- judged by its last 30 days. today works it out, and markets and market show it. Each keeps its name and kind.
-- Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('today', 2,
     'Every market\'s move today, its z (the move in its usual daily moves), its bad day and its liquidity.',
     'SELECT symbol,
       market_type,
       price,
       price / prev_close - 1 AS move,                      -- the move since yesterday\'s close
       CASE WHEN history_days >= 20 AND sd_return_30d > 0   -- scored from 20 days of history
            THEN (price / prev_close - 1 - avg_return_30d) / sd_return_30d
       END AS z,                                            -- the move in usual daily moves (σ)
       sd_return_30d,
       CASE WHEN history_days >= 20 AND sd_return_30d > 0
            THEN avg_return_30d - 1.645 * sd_return_30d
       END AS bad_day,                                      -- 1 day in 20 fell further than this
       quote_volume_24h / NULLIF(avg_quote_volume_30d, 0) AS volume_x,   -- the last 24 hours ÷ a usual day
       CASE WHEN avg_quote_volume_30d >= 100000000 THEN \'large\'
            WHEN avg_quote_volume_30d >= 10000000 THEN \'mid\'
            ELSE \'small\'
       END AS liquidity                                     -- by the USDT it trades on an average day
FROM market_now',
     NULL),
    ('markets', 4,
     'Today against each market\'s normal. The table\'s search, sort buttons and pages work on this result.',
     'SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,  -- its usual daily move (σ)
       ROUND(100 * t.bad_day, 2) AS bad_day_pct,          -- 1 day in 20 fell further than this
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN 0 ELSE 1 END AS unusual   -- highlighted when unusual
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
WHERE :kind IN (\'all\', t.market_type)',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain","title":"The market\'s usual daily move (σ) over its last 30 days"},{"name":"bad_day_pct","label":"Bad day","format":"pct","title":"How far this market fell on 1 day in 20, judged by its last 30 days. A guide for sizing a position, not a limit: days past it typically went 1.3 times as far."},{"name":"volume_x","label":"Volume","format":"times","title":"USDT traded in the last 24 hours ÷ its usual day"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"unusual","format":"hidden"}]}'),
    ('market', 6,
     'Every number in one market\'s row, and its kind of move with the verdicts when it is unusual.',
     'SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,
       ROUND(100 * t.bad_day, 2) AS bad_day_pct,
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       f.direction,                                  -- its kind of move, when unusual
       f.z_band,
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_1h END AS next_1h,    -- what moves of that kind did next
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_4h END AS next_4h,
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_24h END AS next_24h
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
WHERE t.symbol = :symbol',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain"},{"name":"bad_day_pct","label":"Bad day","format":"pct","title":"How far this market fell on 1 day in 20, judged by its last 30 days. A guide for sizing a position, not a limit: days past it typically went 1.3 times as far."},{"name":"volume_x","label":"Volume","format":"times"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"next_1h","label":"Next 1 h","format":"verdict","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1,"focus":"verdict"}}},{"name":"next_4h","label":"Next 4 h","format":"verdict","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4,"focus":"verdict"}}},{"name":"next_24h","label":"Next 24 h","format":"verdict","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24,"focus":"verdict"}}}]}')
    AS v(metric_id, version, description, sql_text, display)
  )
  SELECT n.metric_id, n.version, 'add' AS step, d.kind, d.name, n.description, n.sql_text, n.display
  FROM new_versions n
  JOIN market.semantic.metric_definitions d ON d.metric_id = n.metric_id AND d.version = n.version - 1
  UNION ALL
  SELECT n.metric_id, n.version - 1, 'close', NULL, NULL, NULL, NULL, NULL
  FROM new_versions n
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN MATCHED AND s.step = 'close' AND t.is_current THEN UPDATE SET valid_to = current_timestamp(), is_current = false
WHEN NOT MATCHED AND s.step = 'add' THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
  VALUES (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true, 'Shivam',
          'The bad day of each market, from its last 30 days')
