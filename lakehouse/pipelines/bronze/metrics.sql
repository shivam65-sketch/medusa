-- Bronze: Binance 5-minute market metrics (open interest and long/short ratios), exactly as
-- they arrived. Same rules as klines_1m.sql: loaded once per file, all text, nothing dropped.

CREATE OR REFRESH STREAMING TABLE metrics (
  CONSTRAINT matches_file_layout EXPECT (_rescued_data IS NULL),
  CONSTRAINT has_symbol          EXPECT (symbol <> '')
)
COMMENT 'Raw 5-minute open interest and long/short ratios from data.binance.vision, all columns as text'
AS SELECT
  symbol,  -- unlike the candle files, these files have a coin column
  date,    -- from the folder name date=YYYY-MM-DD
  create_time,
  sum_open_interest,
  sum_open_interest_value,
  count_toptrader_long_short_ratio,
  sum_toptrader_long_short_ratio,
  count_long_short_ratio,
  sum_taker_long_short_vol_ratio,
  _rescued_data,
  _metadata.file_path              AS source_file,
  _metadata.file_modification_time AS source_file_modified_at,
  current_timestamp()              AS loaded_at
FROM STREAM read_files(
  '/Volumes/market/landing/binance/metrics/',
  format            => 'csv',
  header            => true,
  schema            => 'create_time STRING, symbol STRING, sum_open_interest STRING, sum_open_interest_value STRING, count_toptrader_long_short_ratio STRING, sum_toptrader_long_short_ratio STRING, count_long_short_ratio STRING, sum_taker_long_short_vol_ratio STRING, date STRING',
  rescuedDataColumn => '_rescued_data',
  partitionColumns  => 'date'
);