-- 011_metric_definitions_value_windows.sql
-- Version 1 of the two windows a value on Patterns opens (lakehouse step 32.2): the markets in a group right now, and the
-- kinds of move with a verdict. Made from public/markets-metrics.js, where they were first written.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('now_in_group', 1, 'metric', 'Markets in this group right now',
     'The tested markets of the type chosen that are in this kind of move right now.',
     'SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z,
       liquidity
FROM flagged
WHERE tested = 1
  AND :kind IN (\'all\', market_type)
  AND :direction IN (\'all\', direction)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
ORDER BY ABS(z) DESC',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"}]}'),
    ('kinds_with_verdict', 1, 'metric', 'Kinds of move with this verdict',
     'Every kind of move and horizon with the verdict clicked, and how many moves stand behind each. Click one for its moves.',
     'SELECT CASE WHEN z_band = \'all\' THEN CONCAT(\'Every \', direction, \' move\')
            ELSE CONCAT(CASE direction WHEN \'up\' THEN \'Up \' ELSE \'Down \' END, z_band, \'σ, \', liquidity)
       END AS kind_of_move,
       CONCAT(\'Next \', horizon_hours, \' h\') AS horizon,
       CASE WHEN verdict = \'held up\' THEN CONCAT(side, \' \', ROUND(100 * held_back_net_after_cost, 2), \'%\')
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
ORDER BY CASE direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE z_band WHEN \'all\' THEN 0 WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 ELSE 3 END,
         CASE liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END,
         horizon_hours',
     '{"columns":[{"name":"kind_of_move","label":"Kind of move"},{"name":"horizon","label":"Over"},{"name":"verdict_text","label":"Verdict"},{"name":"events","label":"Moves","format":"int"},{"name":"days","label":"Days","format":"int"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"},{"name":"horizon_hours","format":"hidden"}],"each":{"panel":"moves","set":{"direction":"direction","z_band":"z_band","liquidity":"liquidity","horizon":"horizon_hours"}}}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 32.2)')
