-- 003_metric_definitions_insights.sql
-- Version 1 of the definitions behind the Markets page's Insights view (lakehouse step 32): three shared
-- steps (the past moves in the direction and over the hours chosen, the moves a click picked, and the
-- market by hour), seven graphs, and the six numbers, graphs and tables of the windows a click opens.
-- A graph is a metric whose display has a chart: the columns it draws, and what a click on it opens.
-- They read market_events and market_hours, MEDUSA's copies of gold.intraday_events and gold.hour_drift.
-- Made from public/markets-metrics.js, where they were first written. From now on the table is the
-- master copy and a change adds a new version.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('moves', 1, 'model', 'Past moves',
     'Every unusual move since 2020 in the direction chosen, with what the price did over the hours chosen: + kept going, − turned back.',
     'SELECT symbol,
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
      WHERE direction = :direction) e
WHERE kept_going_pct IS NOT NULL                    -- empty when the market stopped trading or the data ends',
     NULL),
    ('moves_picked', 1, 'model', 'The moves picked',
     'The past moves behind what was clicked: a year, an hour, a 1% step of the outcome, a size band, a liquidity group or one market. A parameter that is NULL doesn\'t filter.',
     'SELECT *
FROM moves
WHERE (:year IS NULL OR year = :year)
  AND (:hour IS NULL OR hour_of_day = :hour)
  AND (:bucket IS NULL OR bucket = :bucket)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
  AND (:symbol IS NULL OR symbol = :symbol)',
     NULL),
    ('hour_stats', 1, 'model', 'The market by hour',
     'The market\'s move in each UTC hour, pooled over the years of each period (the lakehouse keeps sums, so the years add up exactly).',
     'SELECT utc_hour,
       liquidity,                                   -- large, mid, small, or all
       period,                                      -- in_sample (2020-2024) or held_back (2025 on)
       SUM(days) AS days,
       SUM(sum_return) / SUM(days) AS avg_return,   -- the average day\'s move in this hour
       SQRT((SUM(sum_sq_return) - SUM(sum_return) * SUM(sum_return) / SUM(days))
            / (SUM(days) - 1)) AS sd_return,        -- how much the days vary
       SUM(up_days) AS up_days
FROM market_hours
GROUP BY utc_hour, liquidity, period',
     NULL),
    ('insight_live_map', 1, 'metric', 'Every market right now',
     'Each market\'s move today in its usual daily moves (z, across) against the volume of its last 24 hours compared with a usual day (up), coloured by whether it is unusual and whether its kind of move has a tested pattern. Live.',
     'SELECT t.symbol AS market,
       CASE WHEN t.z > 12 THEN 12 WHEN t.z < -12 THEN -12 ELSE ROUND(t.z, 2) END AS z_axis,   -- kept on the graph
       ROUND(t.volume_x, 2) AS volume_x,            -- the last 24 hours ÷ a usual day
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN \'Normal\'
            WHEN h.direction IS NOT NULL THEN \'Unusual, a pattern held up\'
            ELSE \'Unusual, no tested edge\'
       END AS state
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN (SELECT DISTINCT direction, z_band, liquidity      -- kinds of move that held up at some horizon
           FROM market_evidence
           WHERE verdict = \'held up\') h
       ON h.direction = f.direction AND h.z_band = f.z_band AND h.liquidity = f.liquidity
WHERE t.z IS NOT NULL
  AND t.volume_x > 0',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"z_axis","label":"z (σ), at most ±12 on the graph","format":"z"},{"name":"volume_x","label":"Volume against a usual day","format":"times"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"state","label":"State"}],"chart":{"type":"scatter","x":"z_axis","y":"volume_x","ylog":true,"label":"market","color":"state","xunit":"","colors":{"Unusual, a pattern held up":0,"Unusual, no tested edge":1,"Normal":"muted"},"tip":["today_pct","z","liquidity","state"],"drill":{"panel":"market","set":{"symbol":"market"}}}}'),
    ('insight_patterns_map', 1, 'metric', 'Every kind of move at a glance',
     'What each kind of move did next, on average over days since 2020 (blue kept going, red turned back, grey where there are too few days to judge), and its verdict: the side and its result from 2025 when the pattern held up.',
     'SELECT CASE WHEN z_band = \'all\' THEN CONCAT(\'Every \', direction, \' move\')
            ELSE CONCAT(CASE direction WHEN \'up\' THEN \'Up \' ELSE \'Down \' END, z_band, \'σ, \', liquidity)
       END AS kind_of_move,
       CONCAT(\'Next \', horizon_hours, \' h\') AS horizon,
       ROUND(100 * avg_continuation, 2) AS avg_pct,  -- + kept going, - turned back
       CASE WHEN verdict = \'held up\'                 -- the side, and a trade from 2025 after costs
            THEN CONCAT(side, \' \', ROUND(100 * held_back_net_after_cost, 2), \'%\')
            ELSE verdict
       END AS verdict_text,
       events,
       days,
       ROUND(in_sample_t, 1) AS in_sample_t,
       ROUND(held_back_t, 1) AS held_back_t,
       CASE WHEN verdict = \'too few\' THEN 1 ELSE 0 END AS too_few,                -- drawn grey: too thin to judge
       direction,
       horizon_hours,
       CASE WHEN z_band = \'all\' THEN NULL ELSE z_band END AS pick_band,         -- for the click
       CASE WHEN liquidity = \'all\' THEN NULL ELSE liquidity END AS pick_liquidity
FROM market_evidence
ORDER BY CASE direction WHEN \'up\' THEN 1 ELSE 2 END,
         CASE z_band WHEN \'all\' THEN 0 WHEN \'3-4\' THEN 1 WHEN \'4-6\' THEN 2 ELSE 3 END,
         CASE liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END,
         horizon_hours',
     '{"columns":[{"name":"kind_of_move","label":"Kind of move"},{"name":"horizon","label":"Over"},{"name":"avg_pct","label":"Average next move, all years","format":"pct"},{"name":"verdict_text","label":"Verdict"},{"name":"events","label":"Moves","format":"int"},{"name":"days","label":"Days","format":"int"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_t","label":"t from 2025"},{"name":"too_few","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"horizon_hours","format":"hidden"},{"name":"pick_band","format":"hidden"},{"name":"pick_liquidity","format":"hidden"}],"chart":{"type":"heatmap","x":"horizon","y":"kind_of_move","value":"avg_pct","text":"verdict_text","unit":"%","scale":"x","faint":"too_few","tip":["verdict_text","events","days","in_sample_t","held_back_t"],"drill":{"panel":"moves","set":{"direction":"direction","horizon":"horizon_hours","z_band":"pick_band","liquidity":"pick_liquidity"}}}}'),
    ('insight_by_year', 1, 'metric', 'Year by year',
     'What the moves did next, year by year: the median (the middle move) and the average (pulled by a few big ones). A pattern worth trusting shows up every year, not in one.',
     'SELECT year,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,   -- half the moves did better, half worse
       ROUND(AVG(kept_going_pct), 2) AS average_pct,     -- moved by a few big ones
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves
GROUP BY year
ORDER BY year',
     '{"columns":[{"name":"year","label":"Year"},{"name":"moves","label":"Moves","format":"int"},{"name":"median_pct","label":"Median","format":"pct"},{"name":"average_pct","label":"Average","format":"pct"},{"name":"kept_going_share","label":"Kept going","format":"share"}],"chart":{"type":"bar","x":"year","y":["median_pct","average_pct"],"unit":"%","tip":["moves","kept_going_share"],"drill":{"panel":"moves","set":{"year":"year"}}}}'),
    ('insight_spread', 1, 'metric', 'Spread of outcomes',
     'How many moves ended in each 1% step over the hours chosen: how often a move turned back, kept going, or ran far either way. The tails are the risk of taking a side.',
     'SELECT CASE WHEN bucket = -11 THEN \'<-10\' WHEN bucket = 10 THEN \'10+\' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN \'turned back more than 10%\'
            WHEN bucket = 10 THEN \'kept going 10% or more\'
            ELSE CONCAT(bucket, \'% to \', bucket + 1, \'%\')
       END AS range_text,
       bucket
FROM moves
GROUP BY bucket
ORDER BY bucket',
     '{"columns":[{"name":"from_pct","label":"From (%)"},{"name":"moves","label":"Moves","format":"int"},{"name":"share_pct","label":"Share of moves","format":"pct_plain"},{"name":"range_text","label":"Outcome"},{"name":"bucket","format":"hidden"}],"chart":{"type":"bar","x":"from_pct","y":"moves","sign":"bucket","unit":"","pos_label":"Kept going","neg_label":"Turned back","tip":["range_text","share_pct"],"drill":{"panel":"moves","set":{"bucket":"bucket"}}}}'),
    ('insight_by_hour', 1, 'metric', 'By the hour of the move',
     'What the moves did next by the UTC hour they became unusual (the median move). India is UTC + 5:30.',
     'SELECT hour_of_day AS hour,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves
GROUP BY hour_of_day
ORDER BY hour_of_day',
     '{"columns":[{"name":"hour","label":"Hour (UTC)"},{"name":"moves","label":"Moves","format":"int"},{"name":"median_pct","label":"Median","format":"pct"},{"name":"average_pct","label":"Average","format":"pct"},{"name":"kept_going_share","label":"Kept going","format":"share"}],"chart":{"type":"bar","x":"hour","y":"median_pct","sign":true,"unit":"%","pos_label":"Kept going (median)","neg_label":"Turned back (median)","tip":["average_pct","moves","kept_going_share"],"drill":{"panel":"moves","set":{"hour":"hour"}}}}'),
    ('insight_by_group', 1, 'metric', 'By size and liquidity',
     'The median next move for each size of move (in usual daily moves) and each liquidity group (average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below).',
     'SELECT CASE z_band WHEN \'3-4\' THEN \'3 to 4σ\' WHEN \'4-6\' THEN \'4 to 6σ\' ELSE \'6σ or more\' END AS size,
       CASE liquidity WHEN \'large\' THEN \'Large markets\' WHEN \'mid\' THEN \'Mid\' ELSE \'Small\' END AS markets,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       z_band,
       liquidity
FROM moves
GROUP BY z_band, liquidity
ORDER BY z_band, CASE liquidity WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END',
     '{"columns":[{"name":"size","label":"Size"},{"name":"markets","label":"Markets"},{"name":"moves","label":"Moves","format":"int"},{"name":"median_pct","label":"Median","format":"pct"},{"name":"average_pct","label":"Average","format":"pct"},{"name":"kept_going_share","label":"Kept going","format":"share"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"}],"chart":{"type":"heatmap","x":"markets","y":"size","value":"median_pct","unit":"%","tip":["average_pct","moves","kept_going_share"],"drill":{"panel":"moves","set":{"z_band":"z_band","liquidity":"liquidity"}}}}'),
    ('insight_hour_drift', 1, 'metric', 'The market by hour of the day',
     'The whole market\'s average move in each UTC hour, in basis points (0.01%), in 2020–2024 and again from 2025, before costs. An hour that leaned one way in 2020–2024 only counts if it kept leaning that way from 2025.',
     'SELECT hour,
       in_sample_bp,
       held_back_bp,
       in_sample_t,
       held_back_t,
       CASE WHEN ABS(in_sample_t) < 2 THEN \'no pattern\'                        -- nothing to choose in 2020-2024
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN \'held up\'
            ELSE \'did not hold\'
       END AS verdict,
       in_sample_days,
       held_back_days
FROM (SELECT i.utc_hour AS hour,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,                   -- 1 bp = 0.01%
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t,
             i.days AS in_sample_days,
             h.days AS held_back_days
      FROM hour_stats i
      JOIN hour_stats h ON h.utc_hour = i.utc_hour AND h.liquidity = i.liquidity AND h.period = \'held_back\'
      WHERE i.period = \'in_sample\'
        AND i.liquidity = \'all\') s
ORDER BY hour',
     '{"columns":[{"name":"hour","label":"Hour (UTC)"},{"name":"in_sample_bp","label":"2020–2024 (bp)"},{"name":"held_back_bp","label":"From 2025 (bp)"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_t","label":"t from 2025"},{"name":"verdict","label":"Verdict"},{"name":"in_sample_days","label":"Days 2020–2024","format":"int"},{"name":"held_back_days","label":"Days from 2025","format":"int"}],"chart":{"type":"bar","x":"hour","y":["in_sample_bp","held_back_bp"],"unit":"bp","tip":["in_sample_t","held_back_t","verdict"],"drill":{"panel":"drift","set":{"hour":"hour"}}}}'),
    ('moves_summary', 1, 'metric', 'The middle move',
     'The moves picked: how many, and what the middle one (the median), the average and the share that kept going did over the hours chosen.',
     'SELECT COUNT(*) AS moves,
       COUNT(DISTINCT event_date) AS days,
       COUNT(DISTINCT symbol) AS markets,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       :horizon AS hours
FROM moves_picked',
     '{"card":{"value":"{median_pct:pct}","sub":"{moves:int} moves on {days:int} days · average {average_pct:pct} · {kept_going_share:share} kept going"}}'),
    ('moves_spread', 1, 'metric', 'Spread of outcomes',
     'How many of the moves picked ended in each 1% step over the hours chosen.',
     'SELECT CASE WHEN bucket = -11 THEN \'<-10\' WHEN bucket = 10 THEN \'10+\' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN \'turned back more than 10%\'
            WHEN bucket = 10 THEN \'kept going 10% or more\'
            ELSE CONCAT(bucket, \'% to \', bucket + 1, \'%\')
       END AS range_text,
       bucket
FROM moves_picked
GROUP BY bucket
ORDER BY bucket',
     '{"columns":[{"name":"from_pct","label":"From (%)"},{"name":"moves","label":"Moves","format":"int"},{"name":"share_pct","label":"Share of moves","format":"pct_plain"},{"name":"range_text","label":"Outcome"},{"name":"bucket","format":"hidden"}],"chart":{"type":"bar","x":"from_pct","y":"moves","sign":"bucket","unit":"","pos_label":"Kept going","neg_label":"Turned back","tip":["range_text","share_pct"],"drill":{"panel":"moves","set":{"bucket":"bucket"}}}}'),
    ('moves_by_year', 1, 'metric', 'Year by year',
     'The moves picked, year by year: the median and the average next move.',
     'SELECT year,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves_picked
GROUP BY year
ORDER BY year',
     '{"columns":[{"name":"year","label":"Year"},{"name":"moves","label":"Moves","format":"int"},{"name":"median_pct","label":"Median","format":"pct"},{"name":"average_pct","label":"Average","format":"pct"},{"name":"kept_going_share","label":"Kept going","format":"share"}],"chart":{"type":"bar","x":"year","y":["median_pct","average_pct"],"unit":"%","tip":["moves","kept_going_share"],"drill":{"panel":"moves","set":{"year":"year"}}}}'),
    ('moves_list', 1, 'metric', 'The moves themselves',
     'The newest 300 of the moves picked, each with what it did over the hours chosen. Click a row for every past move of that market.',
     'SELECT symbol AS market,
       event_hour,
       ROUND(z, 1) AS z,
       z_band,
       liquidity,
       ROUND(kept_going_pct, 2) AS kept_going_pct,
       period
FROM moves_picked
ORDER BY event_hour DESC
LIMIT 300',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"event_hour","label":"When (UTC)"},{"name":"z","label":"z (σ)","format":"z_tag","title":"Today\'s move ÷ the market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"kept_going_pct","label":"Then","format":"pct","title":"+ kept going, − turned back, over the hours chosen"},{"name":"period","label":"Period"}],"drill":{"panel":"moves","set":{"symbol":"market"}},"show":100}'),
    ('drift_by_year', 1, 'metric', 'This hour, year by year',
     'The whole market\'s average move in the hour picked, each year, in basis points (0.01%), before costs.',
     'SELECT year,
       ROUND(10000 * s / n, 2) AS avg_bp,
       ROUND((s / n) / (SQRT((sq - s * s / n) / (n - 1)) / SQRT(n)), 1) AS t,
       n AS days,
       ROUND(100.0 * up / n, 0) AS up_share
FROM (SELECT year, SUM(sum_return) AS s, SUM(sum_sq_return) AS sq, SUM(days) AS n, SUM(up_days) AS up
      FROM market_hours
      WHERE utc_hour = :hour
        AND liquidity = \'all\'
      GROUP BY year) y
ORDER BY year',
     '{"columns":[{"name":"year","label":"Year"},{"name":"avg_bp","label":"Average (bp)"},{"name":"t","label":"t"},{"name":"days","label":"Days","format":"int"},{"name":"up_share","label":"Days up","format":"share"}],"chart":{"type":"bar","x":"year","y":"avg_bp","sign":true,"unit":"bp","pos_label":"Rose on average","neg_label":"Fell on average","tip":["t","days","up_share"]}}'),
    ('drift_by_liquidity', 1, 'metric', 'This hour, by liquidity',
     'The hour picked for each liquidity group: its average move in 2020–2024 and from 2025, with t (beyond ±2 is unlikely to be chance), before costs.',
     'SELECT liquidity,
       in_sample_bp,
       in_sample_t,
       held_back_bp,
       held_back_t,
       CASE WHEN ABS(in_sample_t) < 2 THEN \'no pattern\'
            WHEN in_sample_t * held_back_t > 0 AND ABS(held_back_t) >= 2 THEN \'held up\'
            ELSE \'did not hold\'
       END AS verdict
FROM (SELECT i.liquidity,
             ROUND(10000 * i.avg_return, 2) AS in_sample_bp,
             ROUND(i.avg_return / (i.sd_return / SQRT(i.days)), 1) AS in_sample_t,
             ROUND(10000 * h.avg_return, 2) AS held_back_bp,
             ROUND(h.avg_return / (h.sd_return / SQRT(h.days)), 1) AS held_back_t
      FROM hour_stats i
      JOIN hour_stats h ON h.utc_hour = i.utc_hour AND h.liquidity = i.liquidity AND h.period = \'held_back\'
      WHERE i.period = \'in_sample\'
        AND i.utc_hour = :hour) s
ORDER BY CASE liquidity WHEN \'all\' THEN 0 WHEN \'large\' THEN 1 WHEN \'mid\' THEN 2 ELSE 3 END',
     '{"columns":[{"name":"liquidity","label":"Markets","format":"liquidity"},{"name":"in_sample_bp","label":"2020–2024 (bp)"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_bp","label":"From 2025 (bp)"},{"name":"held_back_t","label":"t from 2025"},{"name":"verdict","label":"Verdict"}]}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 32)')
