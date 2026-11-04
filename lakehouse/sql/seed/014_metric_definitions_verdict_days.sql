-- 014_metric_definitions_verdict_days.sql
-- The next version of 1 definition (issue 46, ADR-040): the playbook's description now says a verdict needs
-- 30 days in each period, while its own numbers still need 20. The query is unchanged. It keeps its name and kind.
-- Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('past_kinds', 2,
     'Each kind of move on each type of market: how many moves there were, on how many days, and what they did next, over every year and from 2025 only (period held_back). The lakehouse calculates the percentiles once a day. With fewer than 20 days behind a number it stays empty. A verdict, which is a test, needs 30 days in each period.',
     'SELECT market_type,
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
GROUP BY market_type, direction, z_band, liquidity, period',
     NULL)
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
          'A verdict needs 30 days in each period')
