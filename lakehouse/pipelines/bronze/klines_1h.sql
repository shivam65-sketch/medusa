-- Bronze: Binance 1-hour candles from the monthly archive files, exactly as they arrived.
-- Loaded once, to give the lakehouse its history (January 2020 onward) for every USDT perpetual,
-- delisted ones included. Like klines_1m: Auto Loader, every file loaded once, every column text.
--
-- Binance's older files (before 2022) have no header row; newer ones start with one. The files are
-- read WITHOUT a header, so no data row is ever mistaken for a header and lost. The header lines
-- the newer files do have arrive as rows whose open_time is 'open_time': they are counted by the
-- is_data_row rule below and dropped in silver, like any value that isn't a number.
--
-- Bronze never drops a row. The EXPECT rules only count problems (the pipeline's data quality tab).

CREATE OR REFRESH STREAMING TABLE klines_1h (
  -- Every column with its description, in the order and types the table already has.
  symbol                  STRING    COMMENT 'Coin, taken from the file name (the candle files have no coin column), e.g. BTCUSDT',
  month                   STRING    COMMENT 'Month, from the folder name month=YYYY-MM',
  open_time               STRING    COMMENT 'Start of the hour, milliseconds since 1970-01-01 UTC, as text (the text open_time on a header line)',
  open                    STRING    COMMENT 'Price at the start of the hour, USDT, as text',
  high                    STRING    COMMENT 'Highest price in the hour, USDT, as text',
  low                     STRING    COMMENT 'Lowest price in the hour, USDT, as text',
  close                   STRING    COMMENT 'Price at the end of the hour, USDT, as text',
  volume                  STRING    COMMENT 'Amount traded in the hour, in the coin, as text',
  close_time              STRING    COMMENT 'End of the hour, milliseconds since 1970-01-01 UTC, as text',
  quote_volume            STRING    COMMENT 'Amount traded in the hour, in USDT, as text',
  `count`                 STRING    COMMENT 'Number of trades in the hour, as text',
  taker_buy_volume        STRING    COMMENT 'Aggressive buying (taker buys) in the hour, in the coin, as text',
  taker_buy_quote_volume  STRING    COMMENT 'Aggressive buying in the hour, in USDT, as text',
  ignore                  STRING    COMMENT 'Unused by Binance, always 0',
  _rescued_data           STRING    COMMENT 'Anything in the line that did not fit the expected columns; empty when the line was as expected',
  source_file             STRING    COMMENT 'Full path of the landing file the row came from (lineage)',
  source_file_modified_at TIMESTAMP COMMENT 'When that landing file was uploaded',
  loaded_at               TIMESTAMP COMMENT 'When the pipeline loaded the row',
  CONSTRAINT matches_file_layout EXPECT (_rescued_data IS NULL),
  CONSTRAINT has_symbol          EXPECT (symbol <> ''),
  CONSTRAINT is_data_row         EXPECT (open_time <> 'open_time')
)
COMMENT 'Raw 1-hour candles from data.binance.vision monthly files, one row per file line (header lines included), all columns as text'
AS SELECT
  -- The coin is only in the file name, e.g. BTCUSDT-1h-2020-01.csv.gz
  regexp_extract(_metadata.file_name, '^(.+)-1h-', 1) AS symbol,
  month,  -- from the folder name month=YYYY-MM
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
  '/Volumes/market/landing/binance/klines_1h/',
  format            => 'csv',
  header            => false,
  schema            => 'open_time STRING, open STRING, high STRING, low STRING, close STRING, volume STRING, close_time STRING, quote_volume STRING, count STRING, taker_buy_volume STRING, taker_buy_quote_volume STRING, ignore STRING, month STRING',
  rescuedDataColumn => '_rescued_data',
  partitionColumns  => 'month'
);
