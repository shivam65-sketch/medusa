-- 010_metric_definitions_names_and_clicks.sql
-- The next version of 19 definitions (lakehouse step 32.2): every table's column names back as they were,
-- and every value on the Markets screener opening its own window. Each keeps its name and kind. The queries that change
-- are unusual, which returns what a click on a verdict needs, and moves_picked, which takes the new picks.
-- Made from public/markets-metrics.js.
-- One MERGE closes the version before and adds the new one, the way a save on the page does. Safe to
-- run again: a new version is only added once, and only a current version is closed.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  WITH new_versions AS (
    SELECT * FROM VALUES
    ('unusual', 4,
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
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"next_1h","label":"Next 1 h","format":"verdict","sub":"all_1h","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1}}},{"name":"all_1h","format":"hidden"},{"name":"next_4h","label":"Next 4 h","format":"verdict","sub":"all_4h","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4}}},{"name":"all_4h","format":"hidden"},{"name":"next_24h","label":"Next 24 h","format":"verdict","sub":"all_24h","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24}}},{"name":"all_24h","format":"hidden"},{"name":"market_type","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"}]}'),
    ('gainers', 3,
     'The eight biggest gains since yesterday\'s close.',
     'SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move > 0
  AND :kind IN (\'all\', market_type)
ORDER BY move DESC
LIMIT 8',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('losers', 3,
     'The eight biggest losses since yesterday\'s close.',
     'SELECT symbol AS market,
       price,
       ROUND(100 * move, 2) AS today_pct,
       ROUND(z, 1) AS z
FROM today
WHERE move < 0
  AND :kind IN (\'all\', market_type)
ORDER BY move ASC
LIMIT 8',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('markets', 3,
     'Today against each market\'s normal. The table\'s search, sort buttons and pages work on this result.',
     'SELECT t.symbol AS market,
       t.price,
       ROUND(100 * t.move, 2) AS today_pct,
       ROUND(t.z, 1) AS z,
       ROUND(100 * t.sd_return_30d, 2) AS usual_day_pct,  -- its usual daily move (σ)
       ROUND(t.volume_x, 1) AS volume_x,
       t.liquidity,
       CASE WHEN f.symbol IS NULL THEN 0 ELSE 1 END AS unusual   -- highlighted when unusual
FROM today t
LEFT JOIN flagged f ON f.symbol = t.symbol
WHERE :kind IN (\'all\', t.market_type)',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain","title":"The market\'s usual daily move (σ) over its last 30 days"},{"name":"volume_x","label":"Volume","format":"times","title":"USDT traded in the last 24 hours ÷ its usual day"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"unusual","format":"hidden"}]}'),
    ('market', 4,
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
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"usual_day_pct","label":"Usual day","format":"pct_plain"},{"name":"volume_x","label":"Volume","format":"times"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"next_1h","label":"Next 1 h","format":"verdict","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1}}},{"name":"next_4h","label":"Next 4 h","format":"verdict","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4}}},{"name":"next_24h","label":"Next 24 h","format":"verdict","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24}}}]}'),
    ('unusual_all_types', 3,
     'Every unusual market of any type with its kind of move: the Patterns view\'s Now, and when this page first saw each one unusual.',
     'SELECT direction,
       z_band,
       liquidity,
       symbol AS market,
       ROUND(z, 1) AS z
FROM flagged
ORDER BY ABS(z) DESC',
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"market","label":"Market","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."}]}'),
    ('patterns_held', 5,
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
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"horizon_hours","label":"Over (hours)"},{"name":"side","label":"Side"},{"name":"held_back_pct","label":"From 2025","format":"pct","title":"A trade from 2025 on, after the round-trip cost"},{"name":"held_back_t","label":"t from 2025"},{"name":"held_back_days","label":"Days from 2025"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"in_sample_days","label":"Days 2020–2024"},{"name":"events","label":"Moves"},{"name":"days","label":"Days"},{"name":"cost_pct","label":"Cost","format":"pct_plain"},{"name":"market","label":"Right now","format":"market"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."}],"each":{"panel":"moves","set":{"direction":"direction","z_band":"z_band","liquidity":"liquidity","horizon":"horizon_hours"}}}'),
    ('patterns_grid', 4,
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
     '{"columns":[{"name":"direction","label":"Direction"},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"now","label":"Now","format":"int","title":"Tested markets of the type chosen in this group right now"},{"name":"next_1h","label":"Next 1 h","format":"verdict","hours":1,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1}}},{"name":"next_4h","label":"Next 4 h","format":"verdict","hours":4,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4}}},{"name":"next_24h","label":"Next 24 h","format":"verdict","hours":24,"drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24}}}]}'),
    ('moves_picked', 2,
     'The past moves behind what was clicked: a year, an hour, a 1% step of the outcome, a size band, a liquidity group, one market, a period, those that continued or reversed, or a worst 5%. A parameter that is NULL doesn\'t filter.',
     'SELECT *
FROM moves
WHERE (:year IS NULL OR year = :year)
  AND (:hour IS NULL OR hour_of_day = :hour)
  AND (:bucket IS NULL OR bucket = :bucket)
  AND (:z_band IS NULL OR z_band = :z_band)
  AND (:liquidity IS NULL OR liquidity = :liquidity)
  AND (:symbol IS NULL OR symbol = :symbol)
  AND (:period IS NULL OR period = :period)
  AND (:kept IS NULL OR CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END = :kept)  -- 1 continued, 0 reversed
  AND (:at_least IS NULL OR kept_going_pct >= :at_least)   -- the worst 5% that kept going
  AND (:at_most IS NULL OR kept_going_pct <= :at_most)     -- the worst 5% that turned back',
     NULL),
    ('insight_live_map', 6,
     'Each market\'s move today in its usual daily moves (z, across) against the volume of its last 24 hours compared with a usual day (up), coloured by whether it is unusual and whether its kind of move has a tested pattern. Live.',
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
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"z_axis","label":"z (σ), at most ±12 on the graph","format":"z"},{"name":"volume_x","label":"Volume against a usual day","format":"times"},{"name":"today_pct","label":"Today","format":"pct"},{"name":"z","label":"z (σ)","format":"z","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"state","label":"State"}],"chart":{"type":"scatter","x":"z_axis","y":"volume_x","ylog":true,"label":"market","color":"state","xunit":"","colors":{"Unusual, a pattern held up":0,"Unusual, no tested edge":1,"Normal":"muted"},"tip":["today_pct","z","liquidity","state"],"drill":{"panel":"market","set":{"symbol":"market"}}}}'),
    ('playbook', 3,
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
     '{"show":100,"columns":[{"name":"market","label":"Market","format":"market","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","symbol":"market"},"fixed":{}}},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"kind_of_move","label":"Kind of move","title":"The group of past moves this one is compared with: direction, size, and how much the market trades","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{}}},{"name":"verdict","label":"Verdict","format":"verdict","title":"Whether this group passed the test, over the hours chosen. The only column that has","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{}}},{"name":"moves","label":"Past moves","format":"int","under":{"col":"days","text":"on {} days","format":"int","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{}}},"title":"How many times any market of this type made a move in this group, and on how many days","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{}}},{"name":"next_1h","label":"Next 1 h","format":"pct","under":{"col":"recent_1h","text":"from 2025 {}","format":"pct","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1,"period":"held_back"}}},"title":"The middle result 1 hour later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":1}}},{"name":"next_4h","label":"Next 4 h","format":"pct","under":{"col":"recent_4h","text":"from 2025 {}","format":"pct","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4,"period":"held_back"}}},"title":"The middle result 4 hours later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":4}}},{"name":"next_24h","label":"Next 24 h","format":"pct","under":{"col":"recent_24h","text":"from 2025 {}","format":"pct","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24,"period":"held_back"}}},"title":"The middle result 24 hours later: + continued, − reversed","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"horizon":24}}},{"name":"kept_going_share","label":"Kept going","format":"share","under":{"col":"recent_kept_going","text":"from 2025 {}","format":"share","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"kept":1,"period":"held_back"}}},"title":"How often the move continued over the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity"},"fixed":{"kept":1}}},{"name":"worst_kept_going","label":"Worst 5%: kept going","format":"pct","under":{"col":"recent_worst_kept_going","text":"from 2025 {}","format":"pct","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_least":"recent_worst_kept_going"},"fixed":{"period":"held_back"}}},"title":"If you bet the move would reverse: 1 time in 20 it continued at least this far by the end of the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_least":"worst_kept_going"},"fixed":{}}},{"name":"worst_turned_back","label":"Worst 5%: turned back","format":"pct","under":{"col":"recent_worst_turned_back","text":"from 2025 {}","format":"pct","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_most":"recent_worst_turned_back"},"fixed":{"period":"held_back"}}},"title":"If you joined the move: 1 time in 20 it reversed at least this far by the end of the hours chosen","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","z_band":"z_band","liquidity":"liquidity","at_most":"worst_turned_back"},"fixed":{}}},{"name":"own_median","label":"Its own past","format":"pct","under":{"col":"own_moves","text":"{} moves","format":"int","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","symbol":"market"},"fixed":{}}},"title":"The middle result of this market\'s own past moves in this direction, over the hours chosen, from 5 moves on","drill":{"panel":"moves","set":{"kind":"market_type","direction":"direction","symbol":"market"},"fixed":{}}},{"name":"days","format":"hidden"},{"name":"recent_1h","format":"hidden"},{"name":"recent_4h","format":"hidden"},{"name":"recent_24h","format":"hidden"},{"name":"recent_kept_going","format":"hidden"},{"name":"recent_worst_kept_going","format":"hidden"},{"name":"recent_worst_turned_back","format":"hidden"},{"name":"own_moves","format":"hidden"},{"name":"market_type","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"z_band","format":"hidden"},{"name":"liquidity","format":"hidden"}]}'),
    ('insight_patterns_map', 6,
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
     '{"columns":[{"name":"kind_of_move","label":"Kind of move"},{"name":"horizon","label":"Over"},{"name":"avg_pct","label":"Average next move, all years","format":"pct"},{"name":"verdict_text","label":"Verdict"},{"name":"events","label":"Moves","format":"int"},{"name":"days","label":"Days","format":"int"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_t","label":"t from 2025"},{"name":"too_few","format":"hidden"},{"name":"direction","format":"hidden"},{"name":"horizon_hours","format":"hidden"},{"name":"pick_band","format":"hidden"},{"name":"pick_liquidity","format":"hidden"}],"chart":{"type":"heatmap","x":"horizon","y":"kind_of_move","value":"avg_pct","text":"verdict_text","unit":"%","scale":"x","faint":"too_few","tip":["verdict_text","events","days","in_sample_t","held_back_t"],"drill":{"panel":"moves","set":{"direction":"direction","horizon":"horizon_hours","z_band":"pick_band","liquidity":"pick_liquidity"}}}}'),
    ('insight_by_year', 3,
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
    ('insight_by_hour', 3,
     'What the moves did next by the UTC hour they became unusual (the median move). India is UTC + 5:30.',
     'SELECT hour_of_day AS hour,
       COUNT(*) AS moves,
       ROUND(MEDIAN(kept_going_pct), 2) AS median_pct,
       ROUND(AVG(kept_going_pct), 2) AS average_pct,
       ROUND(100.0 * AVG(CASE WHEN kept_going_pct > 0 THEN 1 ELSE 0 END), 0) AS kept_going_share
FROM moves
GROUP BY hour_of_day
ORDER BY hour_of_day',
     '{"columns":[{"name":"hour","label":"Hour (UTC)"},{"name":"moves","label":"Moves","format":"int"},{"name":"median_pct","label":"Median","format":"pct"},{"name":"average_pct","label":"Average","format":"pct"},{"name":"kept_going_share","label":"Kept going","format":"share"}],"chart":{"type":"bar","x":"hour","y":"median_pct","sign":true,"unit":"%","pos_label":"Continued (median)","neg_label":"Reversed (median)","tip":["average_pct","moves","kept_going_share"],"drill":{"panel":"moves","set":{"hour":"hour"}}}}'),
    ('insight_by_group', 3,
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
    ('insight_hour_drift', 4,
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
     '{"columns":[{"name":"hour","label":"Hour (UTC)"},{"name":"in_sample_bp","label":"2020–2024 (bp)"},{"name":"held_back_bp","label":"From 2025 (bp)"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_t","label":"t from 2025"},{"name":"verdict","label":"Verdict"},{"name":"in_sample_days","label":"Days 2020–2024","format":"int"},{"name":"held_back_days","label":"Days from 2025","format":"int"}],"chart":{"type":"bar","x":"hour","y":["in_sample_bp","held_back_bp"],"unit":"bp","tip":["in_sample_t","held_back_t","verdict"],"drill":{"panel":"drift","set":{"hour":"hour"}}}}'),
    ('moves_by_year', 3,
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
    ('moves_list', 3,
     'The newest 300 of the moves picked, each with what it did over the hours chosen. Click a market for only its moves.',
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
     '{"show":100,"columns":[{"name":"market","label":"Market","format":"market","drill":{"panel":"moves","set":{"symbol":"market"}}},{"name":"event_hour","label":"When (UTC)"},{"name":"z","label":"z (σ)","format":"z_tag","title":"How many times bigger today\'s move is than this market\'s usual daily move (σ). 3σ or more is unusual."},{"name":"z_band","label":"Size band"},{"name":"liquidity","label":"Liquidity","format":"liquidity","title":"Average daily volume over 30 days: large ≥ 100 million USDT, mid ≥ 10 million, small below"},{"name":"kept_going_pct","label":"Then","format":"pct","title":"+ continued, − reversed, over the hours chosen"},{"name":"period","label":"Period","format":"period"}]}'),
    ('drift_by_liquidity', 4,
     'The hour picked for each liquidity group: its average move in 2020–2024 and from 2025, with t (beyond ±2 is unlikely to be chance), before costs.',
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
     '{"columns":[{"name":"liquidity","label":"Markets","format":"liquidity"},{"name":"in_sample_bp","label":"2020–2024 (bp)"},{"name":"in_sample_t","label":"t 2020–2024"},{"name":"held_back_bp","label":"From 2025 (bp)"},{"name":"held_back_t","label":"t from 2025"},{"name":"verdict","label":"Verdict"}]}')
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
          'Column names as they were; every value opens its own window')
