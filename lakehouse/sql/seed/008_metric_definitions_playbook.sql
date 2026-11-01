-- 008_metric_definitions_playbook.sql
-- Version 1 of the definitions behind the playbook on the Markets page's Insights view (lakehouse step
-- 32.2): two shared steps (past moves by kind, from gold.move_outcomes, and each unusual market's own
-- past moves) and the table itself. Made from public/markets-metrics.js, where they were first written.
-- From now on the table is the master copy and a change adds a new version.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('past_kinds', 1, 'model', 'Past moves by kind',
     'Each kind of move on each type of market: how many moves there were, on how many days, and what they did next, over every year and from 2025 only (period held_back). The lakehouse calculates the percentiles once a day. With fewer than 20 days behind a number it stays empty, as in the verdicts.',
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
     NULL),
    ('past_own', 1, 'model', 'Each market\'s own past moves',
     'How many unusual moves each market that is unusual now has had, by direction and type, and what the middle one did over the hours chosen, from 5 moves on. The type is kept because a ticker can change hands.',
     'SELECT symbol,
       market_type,
       direction,
       COUNT(*) AS moves,
       CASE WHEN COUNT(*) >= 5 THEN ROUND(MEDIAN(over_hours), 2) END AS median_pct
FROM (SELECT symbol, market_type, direction,
             100 * CASE WHEN direction = \'up\' THEN 1 ELSE -1 END
                 * CASE :horizon WHEN 1 THEN fwd_return_1h WHEN 24 THEN fwd_return_24h ELSE fwd_return_4h END
               AS over_hours
      FROM market_events
      WHERE symbol IN (SELECT symbol FROM flagged)) e   -- only the markets unusual now: this runs every second
WHERE over_hours IS NOT NULL
GROUP BY symbol, market_type, direction',
     NULL),
    ('playbook', 1, 'metric', 'Playbook for the unusual markets',
     'Each market that is unusual right now, and what past moves of the same kind on the same type of market did next: the middle move over 1, 4 and 24 hours, how often they kept going, how far the worst 5% went either way, and the market\'s own past. Before costs. Live.',
     'SELECT f.symbol AS market,
       ROUND(f.z, 1) AS z,
       CONCAT(CASE f.direction WHEN \'up\' THEN \'Up \' ELSE \'Down \' END, f.z_band, \'σ, \', f.liquidity) AS kind_of_move,
       CASE WHEN f.tested = 0 THEN \'not tested\'
            ELSE CASE :horizon WHEN 1 THEN v.next_1h WHEN 24 THEN v.next_24h ELSE v.next_4h END
       END AS verdict,
       COALESCE(a.moves, 0) AS moves,               -- past moves of the same kind on the same type of market
       COALESCE(a.days, 0) AS days,
       a.next_1h,                                   -- the middle move, all years
       a.next_4h,
       a.next_24h,
       r.next_1h AS recent_1h,                      -- the same, from 2025 only
       r.next_4h AS recent_4h,
       r.next_24h AS recent_24h,
       a.kept_going_share,                          -- over the hours chosen, like the next four
       r.kept_going_share AS recent_kept_going,
       a.worst_kept_going,
       r.worst_kept_going AS recent_worst_kept_going,
       a.worst_turned_back,
       r.worst_turned_back AS recent_worst_turned_back,
       o.median_pct AS own_median,                  -- this market\'s own past moves in this direction
       COALESCE(o.moves, 0) AS own_moves,
       f.market_type,                               -- for the click
       f.direction,
       f.z_band,
       f.liquidity
FROM flagged f
LEFT JOIN past_kinds a ON a.period = \'all\' AND a.market_type = f.market_type AND a.direction = f.direction
                      AND a.z_band = f.z_band AND a.liquidity = f.liquidity
LEFT JOIN past_kinds r ON r.period = \'held_back\' AND r.market_type = f.market_type AND r.direction = f.direction
                      AND r.z_band = f.z_band AND r.liquidity = f.liquidity
LEFT JOIN past_own o ON o.symbol = f.symbol AND o.market_type = f.market_type AND o.direction = f.direction
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
WHERE :kind IN (\'all\', f.market_type)
  AND :direction IN (\'all\', f.direction)
ORDER BY ABS(f.z) DESC',
     '{"show":100,"columns":[{"name":"market","label":"Market","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"kind_of_move","label":"Kind of move","title":"Direction, size in usual daily moves, and liquidity: the same groups as the verdicts"},{"name":"moves","label":"Past moves","format":"int","under":{"col":"days","text":"on {} days","format":"int"},"title":"Past moves of this kind on this type of market, and the days they fell on"},{"name":"next_1h","label":"Next 1 h","format":"pct","under":{"col":"recent_1h","text":"from 2025 {}","format":"pct"},"title":"The middle past move 1 hour later: + kept going, − turned back"},{"name":"next_4h","label":"Next 4 h","format":"pct","under":{"col":"recent_4h","text":"from 2025 {}","format":"pct"},"title":"The middle past move 4 hours later: + kept going, − turned back"},{"name":"next_24h","label":"Next 24 h","format":"pct","under":{"col":"recent_24h","text":"from 2025 {}","format":"pct"},"title":"The middle past move 24 hours later: + kept going, − turned back"},{"name":"kept_going_share","label":"Kept going","format":"share","under":{"col":"recent_kept_going","text":"from 2025 {}","format":"share"},"title":"The share of past moves that kept going over the hours chosen"},{"name":"worst_kept_going","label":"Worst 5%: kept going","format":"pct","under":{"col":"recent_worst_kept_going","text":"from 2025 {}","format":"pct"},"title":"1 past move in 20 kept going at least this far by the end of the hours chosen: what a fade has to survive"},{"name":"worst_turned_back","label":"Worst 5%: turned back","format":"pct","under":{"col":"recent_worst_turned_back","text":"from 2025 {}","format":"pct"},"title":"1 past move in 20 turned back at least this far by the end of the hours chosen: what following a move has to survive"},{"name":"own_median","label":"Its own past","format":"pct","under":{"col":"own_moves","text":"{} moves","format":"int"},"title":"The middle of this market\'s own past moves in this direction, over the hours chosen, from 5 moves on. Click for them","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","symbol":"market"}}},{"name":"verdict","label":"Verdict","format":"verdict","title":"The tested verdict for this kind of move over the hours chosen"},{"name":"days","format":"hidden"},{"name":"recent_1h","format":"hidden"},{"name":"recent_4h","format":"hidden"},{"name":"recent_24h","format":"hidden"},{"name":"recent_kept_going","format":"hidden"},{"name":"recent_worst_kept_going","format":"hidden"},{"name":"recent_worst_turned_back","format":"hidden"},{"name":"own_moves","format":"hidden"},{"name":"market_type","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"}],"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"}}}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 32.2)')
