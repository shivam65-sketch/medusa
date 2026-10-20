# Step 11: Coin dimension with history (SCD Type 2)

[← Lakehouse home](../../README.md) · [← Step 10](10-silver-metrics.md)

| | |
|---|---|
| **Built** | 2026-10-20 |
| **Commit** | `da1feb3` Lakehouse: dim_coin with full history (SCD Type 2 dbt snapshot) |
| **Files** | [`dbt/models/silver/int_coin_status.sql`](../../dbt/models/silver/int_coin_status.sql) · [`dbt/snapshots/dim_coin.yml`](../../dbt/snapshots/dim_coin.yml) · [`dbt/tests/assert_dim_coin_one_current_version.sql`](../../dbt/tests/assert_dim_coin_one_current_version.sql) |

## Goal

A table describing every coin (its base asset, multiplier, first day and status) that keeps every
version of that description, so the coin list can be rebuilt as it was on any past date.

## Concepts

| Concept | Here |
|---|---|
| **Facts and dimensions** (Kimball) | Facts are measurements (candles, metrics); dimensions describe what is measured (the coin). |
| **SCD Type 1 vs Type 2** | Type 1 overwrites a changed value and loses the history. Type 2 closes the old row and adds a new one, so every version is kept with the time it was true. |
| **dbt snapshot** | Each run compares the current state with what's stored. With `strategy: check`, when any of `check_cols` changes, the old row gets `dbt_valid_to` and a new row starts at `dbt_valid_from`. |
| **`dbt_valid_to_current`** | Current versions end on 9999-12-31 instead of NULL, so "as of a date" is a plain `BETWEEN dbt_valid_from AND dbt_valid_to`. |
| **Model, then snapshot** | `int_coin_status` (a view) works out each coin's state now; the snapshot keeps the history of it. |
| **Choosing the compared columns** | `last_candle_date` is left out: it changes daily and would create a version per coin per day. Only real changes count: base asset, multiplier, first day, status. |
| **Grace period** | A coin becomes `not trading` only after 3 days without candles, so a late file can't create a false "delisted" version. |
| **Survivorship bias** | Backtesting only on coins that trade today silently skips every coin that died and flatters the results. The coin history fixes that. |

## Code walkthrough

`int_coin_status.sql` (a view):

```sql
regexp_extract(symbol, '^(1000000|100000|10000|1000|1M)(?=[A-Z])', 1) as prefix   -- 1000PEPEUSDT -> 1000
...
regexp_replace(regexp_replace(symbol, '^(1000000|100000|10000|1000|1M)(?=[A-Z])', ''), 'USDT$', '') as base_asset
case prefix when '' then 1 when '1M' then 1000000 else cast(prefix as int) end as multiplier
case when last_candle_date >= date_sub(latest_date, 2) then 'trading' else 'not trading' end as status
```

`(?=[A-Z])` means "followed by a letter", so `1INCHUSDT` isn't read as 1 × INCH.

`dim_coin.yml` (a YAML snapshot, dbt 1.9+):

```yaml
snapshots:
  - name: dim_coin
    relation: ref('int_coin_status')
    config:
      schema: silver
      unique_key: symbol
      strategy: check
      check_cols: [base_asset, multiplier, first_candle_date, status]
      dbt_valid_to_current: "cast('9999-12-31' as timestamp)"
```

Tests (5): `not_null` on `symbol`, `base_asset`, `multiplier`; `accepted_values` on `status`;
`assert_dim_coin_one_current_version` (each coin has exactly one current version).

## How to run

From `lakehouse/dbt/`: `../.venv/Scripts/dbt build --select int_coin_status dim_coin`

## Result

| Multiplier | Coins | Examples |
|---|---|---|
| 1 | 857 | BTCUSDT, 1INCHUSDT, 0GUSDT |
| 1,000 | 12 | 1000PEPEUSDT → PEPE, 1000BONKUSDT → BONK |
| 1,000,000 | 3 | 1000000MOGUSDT → MOG, 1000000BOBUSDT → BOB, 1MBABYDOGEUSDT → BABYDOGE |

All 872 coins `trading`, one version each, valid from the first snapshot run (2026-10-20 15:41 UTC)
to 9999-12-31. The view took 4.6 s and the snapshot 9.5 s; 5 tests passed. Running the snapshot
again adds no versions; history grows only when a coin changes.

## Problems we hit

| Problem | How it showed | Fix |
|---|---|---|
| The three files were saved in the wrong folders (`lakehouse/` and `lakehouse/dbt/`) | `The selection criterion 'int_coin_status' does not match any enabled nodes`; dbt found only 2 models and no snapshot | Moved them to `models/silver/`, `snapshots/` and `tests/`; dbt only looks in those folders |
