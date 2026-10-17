-- Upgrades a single-user Medusa database (before accounts) to accounts. Run it ONCE:
--   npx wrangler@4 d1 execute medusa --remote --file=migrations/001_accounts.sql
-- Back up first: npx wrangler@4 d1 export medusa --remote --output=backups/before-accounts.sql
--
-- Every existing row is kept and given user_id 0, which no account has (ids start at 1), so nobody
-- can see it. After you create your account in the app, migrations/claim.sql moves it to you.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL,
  recovery TEXT NOT NULL,
  totp TEXT,
  totp_pending TEXT,
  totp_last INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  pw_changed_at INTEGER,
  recovery_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS attempts (kind TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_lookup ON attempts (kind, key, ts);

-- orders
CREATE TABLE orders_v2 (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, pair TEXT NOT NULL, mcur TEXT NOT NULL, side TEXT NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, lev REAL, otype TEXT, stage TEXT, status TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id)
);
INSERT INTO orders_v2 (user_id, id, pair, mcur, side, qty, price, fee, lev, otype, stage, status, created_at, updated_at)
  SELECT 0, id, pair, mcur, side, qty, price, fee, lev, otype, stage, status, created_at, updated_at FROM orders;
DROP TABLE orders;
ALTER TABLE orders_v2 RENAME TO orders;
CREATE INDEX orders_pair ON orders (user_id, pair, mcur);
CREATE INDEX orders_side ON orders (user_id, side);

-- txs
CREATE TABLE txs_v2 (
  user_id INTEGER NOT NULL, k TEXT NOT NULL, pair TEXT, mcur TEXT, order_id TEXT, stage TEXT,
  amount REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, k)
);
INSERT INTO txs_v2 (user_id, k, pair, mcur, order_id, stage, amount, fee, created_at)
  SELECT 0, k, pair, mcur, order_id, stage, amount, fee, created_at FROM txs;
DROP TABLE txs;
ALTER TABLE txs_v2 RENAME TO txs;
CREATE INDEX txs_pair ON txs (user_id, pair, mcur);

-- trades
CREATE TABLE trades_v2 (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, pair TEXT NOT NULL, sym TEXT NOT NULL, base TEXT NOT NULL, mcur TEXT NOT NULL,
  side TEXT NOT NULL, open_ts INTEGER NOT NULL, close_ts INTEGER NOT NULL, qty REAL NOT NULL, entry REAL NOT NULL,
  exit REAL NOT NULL, pnl REAL NOT NULL, fees REAL NOT NULL, funding REAL NOT NULL, net REAL NOT NULL, lev REAL,
  entry_type TEXT, exit_kind TEXT, orders INTEGER NOT NULL, pnl_source TEXT, PRIMARY KEY (user_id, id)
);
INSERT INTO trades_v2 (user_id, id, pair, sym, base, mcur, side, open_ts, close_ts, qty, entry, exit, pnl, fees, funding, net, lev, entry_type, exit_kind, orders, pnl_source)
  SELECT 0, id, pair, sym, base, mcur, side, open_ts, close_ts, qty, entry, exit, pnl, fees, funding, net, lev, entry_type, exit_kind, orders, pnl_source FROM trades;
DROP TABLE trades;
ALTER TABLE trades_v2 RENAME TO trades;
CREATE INDEX trades_pair ON trades (user_id, pair, mcur);
CREATE INDEX trades_close ON trades (user_id, close_ts);

-- triggers (created on first use by older versions, so it may be missing)
CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, pair TEXT NOT NULL, mcur TEXT NOT NULL, side TEXT NOT NULL,
  kind TEXT NOT NULL, price REAL NOT NULL, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE triggers_v2 (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, pair TEXT NOT NULL, mcur TEXT NOT NULL, side TEXT NOT NULL, kind TEXT NOT NULL,
  price REAL NOT NULL, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, id)
);
INSERT INTO triggers_v2 (user_id, id, pair, mcur, side, kind, price, status, created_at, updated_at)
  SELECT 0, id, pair, mcur, side, kind, price, status, created_at, updated_at FROM triggers;
DROP TABLE triggers;
ALTER TABLE triggers_v2 RENAME TO triggers;
CREATE INDEX triggers_pair ON triggers (user_id, pair, mcur);

-- annotations
CREATE TABLE annotations_v2 (
  user_id INTEGER NOT NULL, trade_id TEXT NOT NULL, setup TEXT, tags TEXT, mistakes TEXT, emotion TEXT, rating INTEGER,
  plan INTEGER, risk REAL, notes TEXT, chart TEXT, updated_at INTEGER, PRIMARY KEY (user_id, trade_id)
);
INSERT INTO annotations_v2 (user_id, trade_id, setup, tags, mistakes, emotion, rating, plan, risk, notes, chart, updated_at)
  SELECT 0, trade_id, setup, tags, mistakes, emotion, rating, plan, risk, notes, chart, updated_at FROM annotations;
DROP TABLE annotations;
ALTER TABLE annotations_v2 RENAME TO annotations;

-- days
CREATE TABLE days_v2 (
  user_id INTEGER NOT NULL, date TEXT NOT NULL, plan TEXT, review TEXT, mood INTEGER, updated_at INTEGER, PRIMARY KEY (user_id, date)
);
INSERT INTO days_v2 (user_id, date, plan, review, mood, updated_at) SELECT 0, date, plan, review, mood, updated_at FROM days;
DROP TABLE days;
ALTER TABLE days_v2 RENAME TO days;

-- kv: settings, import progress and the CoinDCX key move to user 0; the old app password,
-- the old session signing key and any import lock are dropped (sessions now live in `sessions`).
CREATE TABLE kv_v2 (user_id INTEGER NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (user_id, k));
INSERT INTO kv_v2 (user_id, k, v) SELECT 0, k, v FROM kv WHERE k IN ('settings', 'import', 'coindcx');
DROP TABLE kv;
ALTER TABLE kv_v2 RENAME TO kv;

DROP TABLE IF EXISTS logins;
