-- 007_metric_definitions_no_hours.sql
-- The next version of four definitions (lakehouse step 32.2): a second click on a choice at the top of
-- the Markets page removes it, so a query can now run with no hours chosen (:horizon is 0). Each keeps
-- its name, meaning, kind and display. Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('moves', 4,
     'SELECT symbol,
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
             100 * CASE WHEN direction = \'up\' THEN 1 ELSE -1 END     -- + kept going, - turned back
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END
               AS kept_going_pct                    -- the price change over the hours chosen, in %
      FROM market_events
      WHERE :direction IN (\'all\', direction)
        AND :kind IN (\'all\', market_type)) e
WHERE kept_going_pct IS NOT NULL                    -- empty when the market stopped trading or the data ends',
     'With no hours chosen, past moves are measured over 4 hours'),
    ('moves_summary', 2,
     'SELECT COUNT(*) AS moves,
       COUNT(DISTINCT event_date) AS days,
       COUNT(DISTINCT symbol) AS markets,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       CASE :horizon WHEN 0 THEN 4 ELSE :horizon END AS hours
FROM moves_picked',
     'Says 4 hours when no hours are chosen'),
    ('insight_live_map', 4,
     'SELECT t.symbol AS market,
       CASE WHEN t.z > 12 THEN 12 WHEN t.z < -12 THEN -12 ELSE ROUND(t.z, 2) END AS z_axis,   -- kept on the graph
       ROUND(t.volume_x, 2) AS volume_x,            -- the last 24 hours ÷ a usual day
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN \'Normal\'
            WHEN f.tested = 1 AND h.direction IS NOT NULL THEN \'Unusual, a pattern held up\'
            ELSE \'Unusual, no tested edge\'
       END AS state
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN (SELECT DISTINCT direction, z_band, liquidity      -- kinds of move that held up over the hours chosen
           FROM market_evidence
           WHERE verdict = \'held up\'
             AND :horizon IN (0, horizon_hours)) h
       ON h.direction = f.direction AND h.z_band = f.z_band AND h.liquidity = f.liquidity
WHERE t.z IS NOT NULL
  AND t.volume_x > 0
  AND :kind IN (\'all\', t.market_type)
  AND :direction IN (\'all\', CASE WHEN t.z > 0 THEN \'up\' ELSE \'down\' END)',
     'With no hours chosen, blue means held up over any of them'),
    ('insight_patterns_map', 4,
     'WITH moved AS (                                     -- the moves chosen: + kept going, - turned back
  SELECT direction, z_band, liquidity, event_date,
         CASE WHEN direction = \'up\' THEN 1 ELSE -1 END
           * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END AS c
  FROM market_events
  WHERE :direction IN (\'all\', direction)
    AND :kind IN (\'all\', market_type)
),
by_day AS (                                         -- days, not moves, as in the evidence
  SELECT direction, z_band, liquidity, event_date, AVG(c) AS day_c, COUNT(*) AS n
  FROM moved
  WHERE c IS NOT NULL
  GROUP BY direction, z_band, liquidity, event_date
  UNION ALL                                         -- each move also counts in every move of its direction
  SELECT direction, \'all\', \'all\', event_date, AVG(c), COUNT(*)
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
SELECT CASE WHEN e.z_band = \'all\' THEN CONCAT(\'Every \', e.direction, \' move\')
            ELSE CONCAT(CASE e.direction WHEN \'up\' THEN \'Up \' ELSE \'Down \' END, e.z_band, \'σ, \', e.liquidity)
       END AS kind_of_move,
       CONCAT(\'Next \', e.horizon_hours, \' h\') AS horizon,
       ROUND(100 * k.avg_continuation, 2) AS avg_pct,  -- + kept going, - turned back
       CASE WHEN :kind IN (\'stock\', \'commodity\') THEN \'not tested\'  -- no 2020-2024 years
            WHEN e.verdict = \'held up\'                 -- the side, and a trade from 2025 after costs
            THEN CONCAT(e.side, \' \', ROUND(100 * e.held_back_net_after_cost, 2), \'%\')
            ELSE e.verdict
       END AS verdict_text,
       COALESCE(k.events, 0) AS events,
       COALESCE(k.days, 0) AS days,
       CASE WHEN :kind IN (\'stock\', \'commodity\') THEN NULL ELSE ROUND(e.in_sample_t, 1) END AS in_sample_t,
       CASE WHEN :kind IN (\'stock\', \'commodity\') THEN NULL ELSE ROUND(e.held_back_t, 1) END AS held_back_t,
       CASE WHEN COALESCE(k.days, 0) < 20                                         -- drawn grey: too thin to judge
              OR (e.verdict = \'too few\' AND :kind NOT IN (\'stock\', \'commodity\')) THEN 1 ELSE 0
       END AS too_few,
       e.direction,
       e.horizon_hours,
       CASE WHEN e.z_band = \'all\' THEN NULL ELSE e.z_band END AS pick_band,       -- for the click
       CASE WHEN e.liquidity = \'all\' THEN NULL ELSE e.liquidity END AS pick_liquidity
FROM market_evidence e
LEFT JOIN kinds k ON k.direction = e.direction AND k.z_band = e.z_band AND k.liquidity = e.liquidity
WHERE :direction IN (\'all\', e.direction)            -- the moves and hours chosen at the top
  AND :horizon IN (0, e.horizon_hours)
ORDER BY CASE e.direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE e.z_band WHEN \'all\' THEN 0 WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 ELSE 3 END,
         CASE e.liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END,
         e.horizon_hours',
     'With no hours chosen, shows all three')
    AS v(metric_id, version, sql_text, change_note)
  )
  SELECT n.metric_id, n.version, 'add' AS step, d.kind, d.name, d.description, n.sql_text, d.display, n.change_note
  FROM new_versions n
  JOIN market.semantic.metric_definitions d ON d.metric_id = n.metric_id AND d.version = n.version - 1
  UNION ALL
  SELECT n.metric_id, n.version - 1, 'close', NULL, NULL, NULL, NULL, NULL, NULL
  FROM new_versions n
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN MATCHED AND s.step = 'close' AND t.is_current THEN UPDATE SET valid_to = current_timestamp(), is_current = false
WHEN NOT MATCHED AND s.step = 'add' THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
  VALUES (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true, 'Shivam', s.change_note)
