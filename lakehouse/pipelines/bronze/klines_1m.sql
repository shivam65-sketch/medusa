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
  -- Every column with its description, in the order and types the table already has.
  symbol                  STRING    COMMENT 'Coin, taken from the file name (the candle files have no coin column), e.g. BTCUSDT',
  date                    STRING    COMMENT 'Day, from the folder name date=YYYY-MM-DD',
  open_time               STRING    COMMENT 'Start of the minute, milliseconds since 1970-01-01 UTC, as text',
  open                    STRING    COMMENT 'Price at the start of the minute, USDT, as text',
  high                    STRING    COMMENT 'Highest price in the minute, USDT, as text',
  low                     STRING    COMMENT 'Lowest price in the minute, USDT, as text',
  close                   STRING    COMMENT 'Price at the end of the minute, USDT, as text',
  volume                  STRING    COMMENT 'Amount traded in the minute, in the coin, as text',
  close_time              STRING    COMMENT 'End of the minute, milliseconds since 1970-01-01 UTC, as text',
  quote_volume            STRING    COMMENT 'Amount traded in the minute, in USDT, as text',
  `count`                 STRING    COMMENT 'Number of trades in the minute, as text',
  taker_buy_volume        STRING    COMMENT 'Aggressive buying (taker buys) in the minute, in the coin, as text',
  taker_buy_quote_volume  STRING    COMMENT 'Aggressive buying in the minute, in USDT, as text',
  ignore                  STRING    COMMENT 'Unused by Binance, always 0',
  _rescued_data           STRING    COMMENT 'Anything in the line that did not fit the expected columns; empty when the line was as expected',
  source_file             STRING    COMMENT 'Full path of the landing file the row came from (lineage)',
  source_file_modified_at TIMESTAMP COMMENT 'When that landing file was uploaded',
  loaded_at               TIMESTAMP COMMENT 'When the pipeline loaded the row',
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