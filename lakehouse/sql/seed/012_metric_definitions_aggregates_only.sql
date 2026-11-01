-- 012_metric_definitions_aggregates_only.sql
-- The next version of 11 definitions (lakehouse step 32.2): only aggregates are clickable, and a window opens
-- with the number that was clicked. The queries that change are moves_picked, which loses two picks nothing uses, and
-- moves_summary, which counts the moves that continued. Each keeps its name and kind. Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('unusual', 5,
     'Every unusual market, and what moves of the same kind (direction, size band, liquidity) did next. The small line under each verdict is every move in the same direction together.',
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
       CASE WHEN f.tested = 1 THEN w.next_24h ELSE \'not tested\' END AS all_24h,
       f.market_type,                               -- for a click on a verdict
       f.direction,
       f.z_band
FROM flagged f
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
LEFT JOIN verdicts w ON w.direction = f.direction AND w.z_band = \'all\' AND w.liquidity = \'all\'
WHERE :kind IN (\'all\', f.market_type)
ORDER BY ABS(f.z) DESC',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"next_1h","label":"Next 1 h","format":"verdict","sub":"all_1h","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1,"focus":"verdict"}}},{"name":"all_1h","format":"hidden"},{"name":"next_4h","label":"Next 4 h","format":"verdict","sub":"all_4h","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4,"focus":"verdict"}}},{"name":"all_4h","format":"hidden"},{"name":"next_24h","label":"Next 24 h","format":"verdict","sub":"all_24h","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24,"focus":"verdict"}}},{"name":"all_24h","format":"hidden"},{"name":"market_type","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"}]}'),
    ('market', 5,
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
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_1h END AS next_1h,    -- what moves of that kind did next
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_4h END AS next_4h,
       CASE WHEN f.tested = 0 THEN \'not tested\' ELSE v.next_24h END AS next_24h
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
LEFT JOIN verdicts v ON v.direction = f.direction AND v.z_band = f.z_band AND v.liquidity = f.liquidity
WHERE t.symbol = :symbol',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain"},{"name":"volume_x","label":"Volume","format":"times"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"next_1h","label":"Next 1 h","format":"verdict","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1,"focus":"verdict"}}},{"name":"next_4h","label":"Next 4 h","format":"verdict","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4,"focus":"verdict"}}},{"name":"next_24h","label":"Next 24 h","format":"verdict","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24,"focus":"verdict"}}}]}'),
    ('patterns_held', 6,
     'Each kind of move whose side, chosen on 2020–2024, still made money after costs from 2025, with one row for each market in that group right now.',
     'SELECT e.direction,
       e.z_band,
       e.liquidity,
       e.horizon_hours,
       e.side,                                              -- fade (bet it reverses) or follow
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
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"horizon_hours","label":"Over (hours)"},{"name":"side","label":"Side"},{"name":"held_back_pct","label":"From 2025","format":"pct","title":"A trade from 2025 on, after the round-trip cost"},{"name":"held_back_t","label":"t from 2025"},{"name":"held_back_days","label":"Days from 2025"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"in_sample_days","label":"Days 2020–2024"},{"name":"events","label":"Moves"},{"name":"days","label":"Days"},{"name":"cost_pct","label":"Cost","format":"pct_plain"},{"name":"market","label":"Right now","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('patterns_grid', 5,
     'Each kind of move (direction, size band, liquidity, and every up or down move together), how many markets are in it right now, and its verdict over the next 1, 4 and 24 hours.',
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
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"now","label":"Now","format":"int","title":"Tested markets of the type chosen in this group right now"},{"name":"next_1h","label":"Next 1 h","format":"verdict","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1,"focus":"verdict"}}},{"name":"next_4h","label":"Next 4 h","format":"verdict","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4,"focus":"verdict"}}},{"name":"next_24h","label":"Next 24 h","format":"verdict","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24,"focus":"verdict"}}}]}'),
    ('moves_picked', 3,
     'The past moves behind what was clicked: a year, an hour, a 1% step of the outcome, a size band, a liquidity group, one market or a worst 5%. A parameter that is NULL doesn\'t filter.',
     'SELECT *
FROM moves
WHERE (:year IS NULL OR year = :year)
  AND (:hour IS NULL OR hour_of_day = :hour)
  AND (:bucket IS NULL OR bucket = :bucket)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
  AND (:symbol IS NULL OR symbol = :symbol)
  AND (:at_least IS NULL OR kept_going_pct >= :at_least)   -- the worst 5% that kept going
  AND (:at_most IS NULL OR kept_going_pct <= :at_most)     -- the worst 5% that turned back',
     NULL),
    ('playbook', 4,
     'Each market that is unusual right now, and what similar past moves did next. Before costs. Live.',
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
     '{"show":100,"columns":[{"name":"market","label":"Market","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"kind_of_move","label":"Kind of move","title":"The group of past moves this one is compared with: direction, size, and how much the market trades"},{"name":"verdict","label":"Verdict","format":"verdict","title":"Whether this group passed the test, over the hours chosen. The only column that has"},{"name":"moves","label":"Past moves","format":"int","under":{"col":"days","text":"on {} days","format":"int"},"title":"How many times any market of this type made a move in this group, and on how many days","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"focus":"count"}}},{"name":"next_1h","label":"Next 1 h","format":"pct","under":{"col":"recent_1h","text":"from 2025 {}","format":"pct"},"title":"The middle result 1 hour later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1}}},{"name":"next_4h","label":"Next 4 h","format":"pct","under":{"col":"recent_4h","text":"from 2025 {}","format":"pct"},"title":"The middle result 4 hours later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4}}},{"name":"next_24h","label":"Next 24 h","format":"pct","under":{"col":"recent_24h","text":"from 2025 {}","format":"pct"},"title":"The middle result 24 hours later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24}}},{"name":"kept_going_share","label":"Kept going","format":"share","under":{"col":"recent_kept_going","text":"from 2025 {}","format":"share"},"title":"How often the move continued over the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"focus":"share"}}},{"name":"worst_kept_going","label":"Worst 5%: kept going","format":"pct","under":{"col":"recent_worst_kept_going","text":"from 2025 {}","format":"pct"},"title":"If you bet the move would reverse: 1 time in 20 it continued at least this far by the end of the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_least":"worst_kept_going","of":"moves"},"fixed":{"focus":"cutoff"}}},{"name":"worst_turned_back","label":"Worst 5%: turned back","format":"pct","under":{"col":"recent_worst_turned_back","text":"from 2025 {}","format":"pct"},"title":"If you joined the move: 1 time in 20 it reversed at least this far by the end of the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_most":"worst_turned_back","of":"moves"},"fixed":{"focus":"cutoff"}}},{"name":"own_median","label":"Its own past","format":"pct","under":{"col":"own_moves","text":"{} moves","format":"int"},"title":"The middle result of this market\'s own past moves in this direction, over the hours chosen, from 5 moves on","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","symbol":"market"},"fixed":{}}},{"name":"days","format":"hidden"},{"name":"recent_1h","format":"hidden"},{"name":"recent_4h","format":"hidden"},{"name":"recent_24h","format":"hidden"},{"name":"recent_kept_going","format":"hidden"},{"name":"recent_worst_kept_going","format":"hidden"},{"name":"recent_worst_turned_back","format":"hidden"},{"name":"own_moves","format":"hidden"},{"name":"market_type","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"}]}'),
    ('insight_patterns_map', 7,
     'What each kind of move did next on the markets chosen, on average over days since 2020 (blue continued, red reversed, grey where there are too few days to judge), and its verdict: the side and its result from 2025 when the pattern held up. Stocks and commodities are not tested.',
     'WITH moved AS (                                     -- the moves chosen: + continued, - reversed
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
       ROUND(100 * k.avg_continuation, 2) AS avg_pct,  -- + continued, - reversed
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
     '{"columns":[{"name":"kind_of_move","label":"Kind of move"},{"name":"horizon","label":"Over"},{"name":"avg_pct","label":"Average next move, all years","format":"pct"},{"name":"verdict_text","label":"Verdict"},{"name":"events","label":"Moves","format":"int"},{"name":"days","label":"Days","format":"int"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_t","label":"t from 2025"},{"name":"too_few","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"horizon_hours","format":"hidden"},{"name":"pick_band","format":"hidden"},{"name":"pick_liquidity","format":"hidden"}],"chart":{"type":"heatmap","x":"horizon","y":"kind_of_move","value":"avg_pct","text":"verdict_text","unit":"%","scale":"x","faint":"too_few","tip":["verdict_text","events","days","in_sample_t","held_back_t"],"drill":{"panel":"moves","set":{"direction":"direction","horizon":"horizon_hours","z_band":"pick_band","liquidity":"pick_liquidity"},"fixed":{"focus":"verdict"}}}}'),
    ('insight_spread', 3,
     'How many moves ended in each 1% step over the hours chosen: how often a move reversed, continued, or ran far either way. The tails are the risk of taking a side.',
     'SELECT CASE WHEN bucket = -11 THEN \'<-10\' WHEN bucket = 10 THEN \'10+\' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN \'reversed more than 10%\'
            WHEN bucket = 10 THEN \'continued 10% or more\'
            ELSE CONCAT(bucket, \'% to \', bucket + 1, \'%\')
       END AS range_text,
       bucket
FROM moves
GROUP BY bucket
ORDER BY bucket',
     '{"columns":[{"name":"from_pct","label":"From (%)"},{"name":"moves","label":"Moves","format":"int"},{"name":"share_pct","label":"Share of moves","format":"pct_plain"},{"name":"range_text","label":"Outcome"},{"name":"bucket","format":"hidden"}],"chart":{"type":"bar","x":"from_pct","y":"moves","sign":"bucket","unit":"","pos_label":"Continued","neg_label":"Reversed","tip":["range_text","share_pct"],"drill":{"panel":"moves","set":{"bucket":"bucket"},"fixed":{"focus":"count"}}}}'),
    ('kinds_with_verdict', 2,
     'Every kind of move and horizon with the verdict clicked, and how many moves stand behind each. Click a verdict for its moves.',
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
     '{"columns":[{"name":"kind_of_move","label":"Kind of move"},{"name":"horizon","label":"Over"},{"name":"verdict_text","label":"Verdict","drill":{"panel":"moves","set":{"direction":"direction","z_band":"z_band","liquidity":"liquidity","horizon":"horizon_hours"},"fixed":{"focus":"verdict"}}},{"name":"events","label":"Moves","format":"int"},{"name":"days","label":"Days","format":"int"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"},{"name":"horizon_hours","format":"hidden"}]}'),
    ('moves_summary', 4,
     'The moves picked: how many, and what the middle one (the median), the average and the share that continued did over the hours chosen.',
     'SELECT COUNT(*) AS moves,
       COUNT(DISTINCT event_date) AS days,
       COUNT(DISTINCT symbol) AS markets,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share,
       SUM(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END) AS kept_moves,
       CASE :horizon WHEN 0 THEN 4 ELSE :horizon END AS hours
FROM moves_picked',
     '{"card":{"value":"{median_pct:pct}","sub":"{moves:int} moves on {days:int} days · average {average_pct:pct} · {kept_going_share:share} continued"}}'),
    ('moves_spread', 3,
     'How many of the moves picked ended in each 1% step over the hours chosen.',
     'SELECT CASE WHEN bucket = -11 THEN \'<-10\' WHEN bucket = 10 THEN \'10+\' ELSE CONCAT(bucket) END AS from_pct,
       COUNT(*) AS moves,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct,
       CASE WHEN bucket = -11 THEN \'reversed more than 10%\'
            WHEN bucket = 10 THEN \'continued 10% or more\'
            ELSE CONCAT(bucket, \'% to \', bucket + 1, \'%\')
       END AS range_text,
       bucket
FROM moves_picked
GROUP BY bucket
ORDER BY bucket',
     '{"columns":[{"name":"from_pct","label":"From (%)"},{"name":"moves","label":"Moves","format":"int"},{"name":"share_pct","label":"Share of moves","format":"pct_plain"},{"name":"range_text","label":"Outcome"},{"name":"bucket","format":"hidden"}],"chart":{"type":"bar","x":"from_pct","y":"moves","sign":"bucket","unit":"","pos_label":"Continued","neg_label":"Reversed","tip":["range_text","share_pct"],"drill":{"panel":"moves","set":{"bucket":"bucket"},"fixed":{"focus":"count"}}}}')
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
          'Only aggregates are clickable; a window opens with the number clicked')
