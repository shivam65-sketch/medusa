-- 003_volumes.sql
-- A volume stores files, not rows. The daily job uploads Binance's CSV files here.
CREATE VOLUME IF NOT EXISTS market.landing.binance
  COMMENT 'Daily Binance files, uploaded only after their checksum matched';