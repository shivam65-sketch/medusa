-- 015_metric_definitions_breakout_watch.sql
-- Version 1 of the definitions behind the Breakout watch on the Markets page's Today view (lakehouse step 32.4):
-- each market's range (a shared step: the high and low of its last 3 days with trades, its usual 3-day range and
-- the live price) and the two lists, Setting up and Breaking out. Made from public/markets-metrics.js, where they
-- were first written. From now on the table is the master copy and a change adds a new version.
-- Safe to run again: MERGE only inserts versions that aren't in the table yet.
-- Apostrophes are written \' because in Databricks '' joins two strings instead of meaning one '.
MERGE INTO market.semantic.metric_definitions AS t
USING (
  SELECT * FROM VALUES
    ('ranges', 1, 'model', 'Each market\'s range',
     'Each trading market\'s range, the high and low of its last 3 days with trades, against its usual 3-day range and the live price.',
     'SELECT n.symbol,
       n.market_type,
       n.price,                                         -- the live price (Binance\'s stream)
       CASE WHEN b.as_of_date >= :yesterday OR m.yesterday_high IS NULL THEN b.high_3d   -- the lakehouse\'s last 3 days
            WHEN m.yesterday_high > b.high_2d THEN m.yesterday_high   -- else its last 2 and yesterday from Binance\'s daily candle
            ELSE b.high_2d
       END AS range_top,
       CASE WHEN b.as_of_date >= :yesterday OR m.yesterday_low IS NULL THEN b.low_3d
            WHEN m.yesterday_low < b.low_2d THEN m.yesterday_low
            ELSE b.low_2d
       END AS range_bottom,
       b.avg_range_3d_30d AS usual_range,               -- its average 3-day range over 30 days (top ÷ bottom − 1)
       n.quote_volume_24h / NULLIF(n.avg_quote_volume_30d, 0) AS volume_x,   -- the last 24 hours ÷ a usual day
       n.history_days
FROM market_now n
JOIN market_baseline b ON b.symbol = n.symbol
LEFT JOIN binance_markets m ON m.symbol = n.symbol',
     NULL),
    ('setting_up', 1, 'metric', 'Setting up',
     'Markets in a quiet range, at most half as wide as their usual 3-day range, with the price within 3% under its top. Closest to the top first.',
     'SELECT symbol AS market,
       price,
       range_top,
       ROUND(100 * (1 - price / range_top), 2) AS below_top_pct,           -- how far under the top
       ROUND((range_top / range_bottom - 1) / usual_range, 2) AS range_x,  -- its range ÷ its usual 3-day range
       ROUND(volume_x, 1) AS volume_x
FROM ranges
WHERE history_days >= 20                                -- a usual range from 20 days or more
  AND usual_range > 0
  AND range_top / range_bottom - 1 <= 0.5 * usual_range  -- quiet: at most half its usual range
  AND price <= range_top AND price >= 0.97 * range_top   -- within 3% under the top
  AND :kind IN (\'all\', market_type)
ORDER BY price / range_top DESC',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"range_top","label":"Range top","format":"price","title":"The highest price of its last 3 days (UTC)"},{"name":"below_top_pct","label":"Below top","format":"pct_plain","title":"How far the price is under the top of its range"},{"name":"range_x","label":"Range vs usual","format":"times","title":"How wide its 3-day range is against its usual 3-day range over 30 days: ×0.5 is half as wide"},{"name":"volume_x","label":"Volume","format":"times","title":"USDT traded in the last 24 hours ÷ its usual day"}]}'),
    ('breaking_out', 1, 'metric', 'Breaking out',
     'Markets whose price is above the top of their 3-day range now, the ones just above it first.',
     'SELECT symbol AS market,
       price,
       range_top,
       ROUND(100 * (price / range_top - 1), 2) AS above_top_pct,           -- how far over the top
       ROUND((range_top / range_bottom - 1) / usual_range, 2) AS range_x,  -- its range ÷ its usual 3-day range
       ROUND(volume_x, 1) AS volume_x
FROM ranges
WHERE history_days >= 20
  AND usual_range > 0
  AND price > range_top                                  -- above its last 3 days
  AND :kind IN (\'all\', market_type)
ORDER BY price / range_top ASC',
     '{"columns":[{"name":"market","label":"Market","format":"market"},{"name":"price","label":"Price","format":"price"},{"name":"range_top","label":"Range top","format":"price","title":"The highest price of its last 3 days (UTC)"},{"name":"above_top_pct","label":"Above top","format":"pct","title":"How far the price is over the top of its range"},{"name":"range_x","label":"Range vs usual","format":"times","title":"How wide its 3-day range is against its usual 3-day range over 30 days: ×0.5 is half as wide"},{"name":"volume_x","label":"Volume","format":"times","title":"USDT traded in the last 24 hours ÷ its usual day"}]}')
  AS v(metric_id, version, kind, name, description, sql_text, display)
) AS s
ON t.metric_id = s.metric_id AND t.version = s.version
WHEN NOT MATCHED THEN INSERT
  (metric_id, version, kind, name, description, sql_text, display, valid_from, valid_to, is_current, changed_by, change_note)
VALUES
  (s.metric_id, s.version, s.kind, s.name, s.description, s.sql_text, s.display, current_timestamp(), NULL, true,
   'Shivam', 'First version, from public/markets-metrics.js (lakehouse step 32.4)')
