-- 005_metric_definitions_market_filter.sql
-- The next version of seven definitions (lakehouse step 32.2): the type chosen at the top of the Markets
-- page now reaches the market by hour, Every kind of move at a glance and the Patterns view's live
-- counts. Each keeps its name and kind, and its display from the version before. A description is
-- replaced only where one is given. Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('hour_stats', 2,
     NULL,
     'SELECT utc_hour,
       liquidity,                                   -- large, mid, small, or all
       period,                                      -- in_sample (2020-2024) or held_back (2025 on)
       SUM(days) AS days,
       SUM(sum_return) / SUM(days) AS avg_return,   -- the average day\'s move in this hour
       SQRT((SUM(sum_sq_return) - SUM(sum_return) * SUM(sum_return) / SUM(days))
            / (SUM(days) - 1)) AS sd_return,        -- how much the days vary
       SUM(up_days) AS up_days
FROM market_hours
WHERE market_type = :kind                           -- the type chosen at the top (\'all\': every market)
GROUP BY utc_hour, liquidity, period',
     'Reads the rows of the type chosen at the top'),
    ('insight_hour_drift', 2,
     'The average move of the markets chosen in each UTC hour, in basis points (0.01%), in 2020–2024 and again from 2025, before costs. An hour that leaned one way in 2020–2024 only counts if it kept leaning that way from 2025.',
     'SELECT hour,
       in_sample_bp,
       held_back_bp,
       in_sample_t,
       held_back_t,
       CASE WHEN in_sample_t IS NULL THEN \'not tested\'                         -- no 2020-2024 years: stocks and commodities
            WHEN ABS(in_sample_t) < 2 THEN \'no pattern\'                        -- nothing to choose in 2020-2024
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN \'held up\'
            ELSE \'did not hold\'
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
      LEFT JOIN hour_stats i ON i.utc_hour = h.utc_hour AND i.liquidity = h.liquidity AND i.period = \'in_sample\'
      WHERE h.period = \'held_back\'
        AND h.liquidity = \'all\') s
ORDER BY hour',
     'Follows the type chosen; a type with no 2020-2024 years shows as not tested'),
    ('drift_by_year', 2,
     'The average move of the markets chosen in the hour picked, each year, in basis points (0.01%), before costs.',
     'SELECT year,
       ROUND(10000 * s / n, 2) AS avg_bp,
       ROUND((s / n) / (SQRT((sq - s * s / n) / (n - 1)) / SQRT(n)), 1) AS t,
       n AS days,
       ROUND(100.0 * up / n, 0) AS up_share
FROM (SELECT year, SUM(sum_return) AS s, SUM(sum_sq_return) AS sq, SUM(days) AS n, SUM(up_days) AS up
      FROM market_hours
      WHERE utc_hour = :hour
        AND liquidity = \'all\'
        AND market_type = :kind
      GROUP BY year) y
ORDER BY year',
     'Follows the type chosen'),
    ('drift_by_liquidity', 2,
     NULL,
     'SELECT liquidity,
       in_sample_bp,
       in_sample_t,
       held_back_bp,
       held_back_t,
       CASE WHEN in_sample_t IS NULL THEN \'not tested\'
            WHEN ABS(in_sample_t) < 2 THEN \'no pattern\'
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN \'held up\'
            ELSE \'did not hold\'
       END AS verdict
FROM (SELECT h.liquidity,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t
      FROM hour_stats h
      LEFT JOIN hour_stats i ON i.utc_hour = h.utc_hour AND i.liquidity = h.liquidity AND i.period = \'in_sample\'
      WHERE h.period = \'held_back\'
        AND h.utc_hour = :hour) s
ORDER BY CASE liquidity WHEN \'all\' THEN 0 WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END',
     'Follows the type chosen; a type with no 2020-2024 years shows as not tested'),
    ('insight_patterns_map', 2,
     'What each kind of move did next on the markets chosen, on average over days since 2020 (blue kept going, red turned back, grey where there are too few days to judge), and its verdict: the side and its result from 2025 when the pattern held up. Stocks and commodities are not tested.',
     'WITH moved AS (                                     -- the moves of the type chosen, one row per horizon
  SELECT direction, z_band, liquidity, event_date, 1 AS horizon_hours, fwd_return_1h AS r
  FROM market_events
  WHERE :kind IN (\'all\', market_type)
  UNION ALL
  SELECT direction, z_band, liquidity, event_date, 4, fwd_return_4h
  FROM market_events
  WHERE :kind IN (\'all\', market_type)
  UNION ALL
  SELECT direction, z_band, liquidity, event_date, 24, fwd_return_24h
  FROM market_events
  WHERE :kind IN (\'all\', market_type)
),
kept AS (                                           -- + kept going, - turned back
  SELECT direction, z_band, liquidity, horizon_hours, event_date,
         CASE WHEN direction = \'up\' THEN r ELSE -r END AS c
  FROM moved
  WHERE r IS NOT NULL
  UNION ALL                                         -- each move also counts in every move of its direction
  SELECT direction, \'all\', \'all\', horizon_hours, event_date,
         CASE WHEN direction = \'up\' THEN r ELSE -r END
  FROM moved
  WHERE r IS NOT NULL
),
by_day AS (                                         -- days, not moves, as in the evidence
  SELECT direction, z_band, liquidity, horizon_hours, event_date, AVG(c) AS day_c, COUNT(*) AS n
  FROM kept
  GROUP BY direction, z_band, liquidity, horizon_hours, event_date
),
kinds AS (
  SELECT direction, z_band, liquidity, horizon_hours,
         AVG(day_c) AS avg_continuation, SUM(n) AS events, COUNT(*) AS days
  FROM by_day
  GROUP BY direction, z_band, liquidity, horizon_hours
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
       CASE WHEN COALESCE(k.days, 0) < 20 THEN 1 ELSE 0 END AS too_few,           -- drawn grey: too thin to judge
       e.direction,
       e.horizon_hours,
       CASE WHEN e.z_band = \'all\' THEN NULL ELSE e.z_band END AS pick_band,       -- for the click
       CASE WHEN e.liquidity = \'all\' THEN NULL ELSE e.liquidity END AS pick_liquidity
FROM market_evidence e
LEFT JOIN kinds k ON k.direction = e.direction AND k.z_band = e.z_band
                 AND k.liquidity = e.liquidity AND k.horizon_hours = e.horizon_hours
ORDER BY CASE e.direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE e.z_band WHEN \'all\' THEN 0 WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 ELSE 3 END,
         CASE e.liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END,
         e.horizon_hours',
     'Built from the moves of the type chosen; stocks and commodities show not tested'),
    ('patterns_held', 3,
     NULL,
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
       f.symbol AS market,                                  -- a tested market of the type chosen, in this group right now
       ROUND(f.z, 1) AS z
FROM market_evidence e
LEFT JOIN flagged f ON f.tested = 1
                   AND :kind IN (\'all\', f.market_type)
                   AND f.direction = e.direction
                   AND (e.z_band = \'all\' OR (f.z_band = e.z_band AND f.liquidity = e.liquidity))
WHERE e.verdict = \'held up\'
ORDER BY e.held_back_net_after_cost DESC, e.direction, e.z_band, e.liquidity, e.horizon_hours, ABS(f.z) DESC',
     'Lists markets of the type chosen'),
    ('patterns_grid', 3,
     NULL,
     'SELECT v.direction,
       v.z_band,
       v.liquidity,
       COUNT(f.symbol) AS now,                              -- tested markets of the type chosen, in this group right now
       v.next_1h, v.next_4h, v.next_24h
FROM verdicts v
LEFT JOIN flagged f ON f.tested = 1
                   AND :kind IN (\'all\', f.market_type)
                   AND f.direction = v.direction
                   AND (v.z_band = \'all\' OR (f.z_band = v.z_band AND f.liquidity = v.liquidity))
GROUP BY v.direction, v.z_band, v.liquidity, v.next_1h, v.next_4h, v.next_24h
ORDER BY CASE v.direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE v.z_band WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 WHEN \'6+\' THEN 3 ELSE 4 END,
         CASE v.liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 WHEN \'small\' THEN 3 ELSE 4 END',
     'Counts markets of the type chosen')
    AS v(metric_id, version, description, sql_text, change_note)
  )
  SELECT n.metric_id, n.version, 'add' AS step, d.kind, d.name, COALESCE(n.description, d.description) AS description,
         n.sql_text,
         REPLACE(d.display, 'Tested markets in this group right now', 'Tested markets of the type chosen in this group right now') AS display,
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
