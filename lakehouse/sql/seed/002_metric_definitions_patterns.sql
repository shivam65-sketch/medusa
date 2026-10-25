-- 002_metric_definitions_patterns.sql
-- Version 1 of the definitions behind the Markets page's Patterns view (lakehouse step 29): the summary
-- of every verdict, the patterns that held up with the markets in them right now, and the table of every
-- kind of move. Made from public/markets-metrics.js, where they were first written; from now on the
-- table is the master copy and a change adds a new version.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('patterns_summary', 1, 'metric', 'What similar moves did next',
     'How many unusual moves the lakehouse recorded since 2020, and how many kinds of move and horizons got each verdict.',
     'SELECT SUM(CASE WHEN direction = \'up\' AND z_band = \'all\' AND horizon_hours = 1 THEN events ELSE 0 END) AS moves_up,     -- every up move, counted once
       SUM(CASE WHEN direction = \'down\' AND z_band = \'all\' AND horizon_hours = 1 THEN events ELSE 0 END) AS moves_down, -- every down move
       COUNT(CASE WHEN verdict = \'held up\' THEN 1 END) AS held_up,
       COUNT(CASE WHEN verdict = \'did not hold\' THEN 1 END) AS did_not_hold,
       COUNT(CASE WHEN verdict = \'no pattern\' THEN 1 END) AS no_pattern,
       COUNT(CASE WHEN verdict = \'too few\' THEN 1 END) AS too_few,
       COUNT(*) AS kinds,                                   -- kinds of move × horizons
       ROUND(100 * MAX(round_trip_cost), 2) AS cost_pct     -- the round-trip cost every verdict pays
FROM market_evidence',
     '{"card":{"value":"{held_up:int} held up","sub":"of {kinds:int} kinds of move and horizons · {moves_up:int} up and {moves_down:int} down moves since 2020"}}'),
    ('patterns_held', 1, 'metric', 'Patterns that held up',
     'Each kind of move whose side, chosen on 2020–2024, still made money after costs from 2025, with one row for each market in that group right now.',
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
       f.symbol AS market,                                  -- a market in this group right now (any type)
       ROUND(f.z, 1) AS z
FROM market_evidence e
LEFT JOIN flagged f ON f.direction = e.direction
                   AND (e.z_band = \'all\' OR (f.z_band = e.z_band AND f.liquidity = e.liquidity))
WHERE e.verdict = \'held up\'
ORDER BY e.held_back_net_after_cost DESC, e.direction, e.z_band, e.liquidity, e.horizon_hours, ABS(f.z) DESC',
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"horizon_hours","label":"Over (hours)"},{"name":"side","label":"Side"},{"name":"held_back_pct","label":"From 2025","format":"pct","title":"A trade from 2025 on, after the round-trip cost"},{"name":"held_back_t","label":"t from 2025"},{"name":"held_back_days","label":"Days from 2025"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"in_sample_days","label":"Days 2020–2024"},{"name":"events","label":"Moves"},{"name":"days","label":"Days"},{"name":"cost_pct","label":"Cost","format":"pct_plain"},{"name":"market","label":"Right now","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('patterns_grid', 1, 'metric', 'Every kind of move',
     'Each kind of move (direction, size band, liquidity, and every up or down move together), how many markets are in it right now, and its verdict over the next 1, 4 and 24 hours.',
     'SELECT v.direction,
       v.z_band,
       v.liquidity,
       COUNT(f.symbol) AS now,                              -- markets in this group right now (any type)
       v.next_1h, v.next_4h, v.next_24h
FROM verdicts v
LEFT JOIN flagged f ON f.direction = v.direction
                   AND (v.z_band = \'all\' OR (f.z_band = v.z_band AND f.liquidity = v.liquidity))
GROUP BY v.direction, v.z_band, v.liquidity, v.next_1h, v.next_4h, v.next_24h
ORDER BY CASE v.direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE v.z_band WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 WHEN \'6+\' THEN 3 ELSE 4 END,
         CASE v.liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 WHEN \'small\' THEN 3 ELSE 4 END',
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"now","label":"Now","format":"int","title":"Markets in this group right now (any type)"},{"name":"next_1h","label":"Next 1 h","format":"verdict"},{"name":"next_4h","label":"Next 4 h","format":"verdict"},{"name":"next_24h","label":"Next 24 h","format":"verdict"}]}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 29)')
