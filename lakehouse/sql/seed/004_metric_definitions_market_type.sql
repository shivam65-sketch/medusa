-- 004_metric_definitions_market_type.sql
-- Version 2 of seven definitions (lakehouse step 32.2): the type of market on each past move, and
-- stocks and commodities shown as not tested. Each definition keeps its name, meaning and kind; a
-- version's display comes from the one before it, with one tooltip's wording brought up to date.
-- Made from public/markets-metrics.js.
-- One MERGE closes version 1 and adds version 2, the way a save on the page does, so the two can't
-- half happen. Safe to run again: version 2 is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('flagged', 2,
     'SELECT *,
       CASE WHEN z > 0 THEN \'up\' ELSE \'down\' END AS direction,
       CASE WHEN ABS(z) < 4 THEN \'3-4\'
            WHEN ABS(z) < 6 THEN \'4-6\'
            ELSE \'6+\'
       END AS z_band,                                       -- the size band
       CASE WHEN market_type IN (\'crypto\', \'other\') THEN 1 ELSE 0 END AS tested   -- stocks and commodities have no 2020-2024 years to test
FROM today
WHERE ABS(z) >= 3                                           -- unusual: 3 or more usual daily moves',
     'Added tested: stocks and commodities have no 2020-2024 years, so they are not tested'),
    ('unusual', 2,
     'SELECT f.symbol AS market,
       f.price,
       ROUND(100 * f.move, 2) AS today_pct,
       ROUND(f.z, 1) AS z,
       f.liquidity,
       CASE WHEN f.tested = 1 THEN v.next_1h ELSE \'not tested\' END AS next_1h,    -- moves of the same kind
       CASE WHEN f.tested = 1 THEN v.next_4h ELSE \'not tested\' END AS next_4h,
       CASE WHEN f.tested = 1 THEN v.next_24h ELSE \'not tested\' END AS next_24h,
       CASE WHEN f.tested = 1 THEN w.next_1h ELSE \'not tested\' END AS all_1h,     -- every move in the same direction
       CASE WHEN f.tested = 1 THEN w.next_4h ELSE \'not tested\' END AS all_4h,
       CASE WHEN f.tested = 1 THEN w.next_24h ELSE \'not tested\' END AS all_24h
FROM flagged f
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
LEFT JOIN verdicts w ON w.direction = f.direction AND w.z_band = \'all\' AND w.liquidity = \'all\'
WHERE :kind IN (\'all\', f.market_type)
ORDER BY ABS(f.z) DESC',
     'Stocks and commodities show not tested instead of a verdict from other markets'),
    ('market', 2,
     'SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,
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
     'Stocks and commodities show not tested instead of a verdict from other markets'),
    ('patterns_held', 2,
     'SELECT e.direction,
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
       f.symbol AS market,                                  -- a tested market in this group right now
       ROUND(f.z, 1) AS z
FROM market_evidence e
LEFT JOIN flagged f ON f.tested = 1
                   AND f.direction = e.direction
                   AND (e.z_band = \'all\' OR (f.z_band = e.z_band AND f.liquidity = e.liquidity))
WHERE e.verdict = \'held up\'
ORDER BY e.held_back_net_after_cost DESC, e.direction, e.z_band, e.liquidity, e.horizon_hours, ABS(f.z) DESC',
     'Lists tested markets only'),
    ('patterns_grid', 2,
     'SELECT v.direction,
       v.z_band,
       v.liquidity,
       COUNT(f.symbol) AS now,                              -- tested markets in this group right now
       v.next_1h, v.next_4h, v.next_24h
FROM verdicts v
LEFT JOIN flagged f ON f.tested = 1
                   AND f.direction = v.direction
                   AND (v.z_band = \'all\' OR (f.z_band = v.z_band AND f.liquidity = v.liquidity))
GROUP BY v.direction, v.z_band, v.liquidity, v.next_1h, v.next_4h, v.next_24h
ORDER BY CASE v.direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE v.z_band WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 WHEN \'6+\' THEN 3 ELSE 4 END,
         CASE v.liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 WHEN \'small\' THEN 3 ELSE 4 END',
     'Counts tested markets only'),
    ('moves', 2,
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
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 4 THEN fwd_return_4h ELSE fwd_return_24h END
               AS kept_going_pct                    -- the price change over the next :horizon hours, in %
      FROM market_events
      WHERE direction = :direction
        AND :kind IN (\'all\', market_type)) e
WHERE kept_going_pct IS NOT NULL                    -- empty when the market stopped trading or the data ends',
     'Added market_type, and the type chosen at the top filters the moves'),
    ('insight_live_map', 2,
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
LEFT JOIN (SELECT DISTINCT direction, z_band, liquidity      -- kinds of move that held up at some horizon
           FROM market_evidence
           WHERE verdict = \'held up\') h
       ON h.direction = f.direction AND h.z_band = f.z_band AND h.liquidity = f.liquidity
WHERE t.z IS NOT NULL
  AND t.volume_x > 0
  AND :kind IN (\'all\', t.market_type)',
     'The type chosen at the top filters the graph, and untested markets can\'t be blue')
    AS v(metric_id, version, sql_text, change_note)
  )
  SELECT n.metric_id, n.version, 'add' AS step, d.kind, d.name, d.description, n.sql_text,
         REPLACE(d.display, 'Markets in this group right now (any type)', 'Tested markets in this group right now') AS display,
         n.change_note
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
