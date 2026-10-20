-- 001_catalog.sql
-- The catalog holds the whole project (like a database in SQL Server).
-- Safe to run again: IF NOT EXISTS skips it when it already exists.
CREATE CATALOG IF NOT EXISTS market
  COMMENT 'Crypto market lakehouse: Binance USD-M futures public data';