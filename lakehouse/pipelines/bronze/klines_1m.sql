-- Bronze: Binance 1-minute candles, exactly as they arrived.
--
-- A STREAMING table fed by read_files is Auto Loader: it remembers which files it has
-- already loaded, so each run reads only the new files, and every file is loaded once.
--
-- Every column is kept as text (STRING), as written in the file. Turning text into numbers
-- and timestamps is silver's job, so a surprise in the data can't stop the load here.
-- A line that doesn't fit the expected columns isn't lost: it goes to _rescued_data.
--
-- Bronze never drops a row. The EXPECT rules below only count problems (shown in the
-- pipeline's data quality tab); silver decides what to do about them.

CREATE OR REFRESH STREAMING TABLE klines_1m (
  CONSTRAINT matches_file_layout EXPECT (_rescued_data IS NULL),
  CONSTRAINT has_symbol          EXPECT (symbol <> '')
)
COMMENT 'Raw 1-minute candles from data.binance.vision, one row per file line, all columns as text'
AS SELECT
  -- The candle files have no coin column: the coin is only in the file name,
  -- e.g. BTCUSDT-1m-2026-10-19.csv.gz
  regexp_extract(_metadata.file_name, '^(.+)-1m-', 1) AS symbol,
  date,  -- from the folder name date=YYYY-MM-DD
  open_time,
  open,
  high,
  low,
  close,
  volume,
  close_time,
  quote_volume,
  `count`,
  taker_buy_volume,
  taker_buy_quote_volume,
  ignore,
  _rescued_data,
  -- Lineage: where each row came from and when it was loaded.
  _metadata.file_path              AS source_file,
  _metadata.file_modification_time AS source_file_modified_at,
  current_timestamp()              AS loaded_at
FROM STREAM read_files(
  '/Volumes/market/landing/binance/klines_1m/',
  format            => 'csv',
  header            => true,
  schema            => 'open_time STRING, open STRING, high STRING, low STRING, close STRING, volume STRING, close_time STRING, quote_volume STRING, count STRING, taker_buy_volume STRING, taker_buy_quote_volume STRING, ignore STRING, date STRING',
  rescuedDataColumn => '_rescued_data',
  partitionColumns  => 'date'
);