# `@ekubo/indexer`

Service for indexing Ekubo events into a Postgres database.

## Overview

The indexer focuses on producing an always-consistent realtime view of Ekubo events, using the Starkstream service to get a stream of relevant data.

Events are not transformed by the indexer, simply cataloged for later use such as in materialized views or complex analytical queries.

## Syncing a new node

It can take days to sync a fresh database with all the networks, so it's recommended to start from a backup of our production database.

Nightly dumps are published by `.github/workflows/pg-dump.yaml`—grab the most recent `db-backup-<timestamp>.dump` artifact from the Actions tab, then import it into your Postgres instance:

```bash
pg_restore --clean --if-exists --no-owner \
  --dbname postgres://user:pass@host:5432/dbname \
  db-backup-20240101T000000Z.dump
```

During restore you may see warnings or errors about the DigitalOcean `doadmin` role or the `pg_cron` extension; those are expected and can be ignored if your target database lacks the same privileges/extensions.

Join the [Discord](https://discord.ekubo.org) and ask in the `#devs` channel if you need support.

### Restoring a dump from the command line

The sequence below goes from an empty (or stale) local database to a warm one without opening a browser, and is safe to run unattended. It assumes the `gh` CLI is authenticated against this repository.

**1. Find the newest successful dump.** Artifacts are kept for 7 days, so the most recent run is usually the only one still downloadable:

```bash
gh run list --repo EkuboProtocol/indexer --workflow pg-dump.yaml \
  --status success --limit 1 --json databaseId,createdAt
```

**2. Download it.** The artifact is named `db-backup-<run_id>` and contains a single `db-backup-<timestamp>.dump`:

```bash
gh run download <run_id> --repo EkuboProtocol/indexer --dir ./dump
```

The dump is on the order of 8 GB. `gh` buffers the whole artifact into `$TMPDIR` before extracting it, so budget roughly twice its size in free space, plus room for the restored data. Expect the download to take several minutes.

**3. Check the archive before touching the database.** This only reads the table of contents, so it is fast and catches a truncated download:

```bash
pg_restore --list ./dump/db-backup-*/db-backup-*.dump | head
```

**4. Restore.** CI dumps with PostgreSQL 18, so the local client must be 18 or newer — verify with `pg_restore --version`. `--clean --if-exists` drops each object the dump recreates, so a database with an older copy of the schema does not need to be emptied by hand:

```bash
pg_restore --clean --if-exists --no-owner --no-privileges -j 8 \
  --dbname postgres://postgres:postgres@localhost:5432/postgres \
  ./dump/db-backup-*/db-backup-*.dump
```

**`pg_restore` exits non-zero on a restore that worked.** The dump carries the production `doadmin` role and the `pg_cron` extension along with its scheduled jobs; locally those statements fail, which only means scheduled jobs will not run. Do not gate on the exit code — confirm the data instead:

```bash
psql -d postgres -c "select chain_id, order_key from indexer_cursor order by chain_id"
psql -d postgres -c "select count(*) from pool_keys"
```

Every chain in the snapshot should have an `indexer_cursor` row, and that block number is where an indexer started against this database will resume from.

**5. Apply any migrations newer than the snapshot**, since the dump reflects production at the time it was taken:

```bash
bun run migrate
```

### Automated database dumps

Nightly backups run through `.github/workflows/pg-dump.yaml`, which connects to the production database using repository secrets, runs `pg_dump -Fc`, and uploads the resulting `db-backup-<timestamp>.dump` as a GitHub Actions artifact (retained for 7 days, named `db-backup-<run_id>`). These artifacts let you bootstrap a new node quickly without waiting for a multi-day sync—grab the latest run from the Actions tab when you need a fresh snapshot.

## Docker image

Build the runtime image once. Bun executes the TypeScript sources directly, so no separate build step is required:

```bash
docker build -t ekubo-indexer .
```

CI publishes the same image to GitHub Container Registry under `ghcr.io/ekuboprotocol/indexer:<git-sha>` so other environments can pull the exact build:

```bash
docker pull ghcr.io/ekuboprotocol/indexer:<git-sha>
```

The resulting image can execute any of the TypeScript entrypoints. Run the network-specific indexer entrypoint directly:

```bash
docker run --rm \
  -e NETWORK=mainnet \
  ekubo-indexer bun src/starknet.ts
```

### Running scripts from the Docker image

Override the command to reuse the same image for auxiliary scripts such as migrations. The default entrypoint is already `bun`, so point it to the desired TypeScript file:

```bash
docker run --rm ekubo-indexer scripts/migrate.ts
```

Match the examples in `.do/app.yaml` to run other helpers, e.g.:

```bash
docker run --rm ekubo-indexer src/price-sync/index.ts
```

Token metadata generation and database synchronization are owned by the
[`EkuboProtocol/default-tokens`](https://github.com/EkuboProtocol/default-tokens)
repository. The indexer image does not fetch or write token metadata.

The price-sync process runs every configured job as an independent recurring loop. A job declares the chains it may write prices for plus a three-character source identifier; startup fails if two jobs claim the same chain and source. Most jobs price one chain, but a job may price several when one upstream request covers them all. `TOKEN_PRICE_SYNC_INTERVAL_MS` controls the default cadence in milliseconds (default: `60000`). CoinGecko jobs use `COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS`; set it to a positive number and provide `COINGECKO_API_KEY` to enable them. Zero or an unset value disables those jobs.

Two properties keep CoinGecko request volume flat rather than growing with `erc20_tokens`:

- Native currency prices for every chain come from a single `cgn` job. Chains sharing a CoinGecko coin ID cost one request between them, not one apiece.
- The per-chain `cg1` jobs request only the tokens CoinGecko has actually priced. Everything else is re-probed on a slow rotation (a full pass per day), so a chain with thousands of unlisted tokens does not pay for them every cycle. This state is held in the worker process, so a restart replays one full sweep before settling back down.

### Price source prioritization

Per-source `confidence` lives in `erc20_token_price_sources`, seeded once by the migration — the worker never writes that table, so policy adjustments (made in a later migration) survive deploys. Freshness is per observation instead: each price row carries a `valid_until`, stamped by the job as three of its own sync intervals (one-minute floor), except Chainlink, which uses the feed's heartbeat window anchored at the round's `updatedAt`. Rows predating the column fall back to five minutes past their timestamp. The latest-price cache prefers the quoter (the interface derives price-impact loss from it), then Chainlink, then CoinGecko, then SushiSwap; it averages sources tied at the highest confidence, records the result under the synthetic `AVG` source, and reconciles expiration once per second so a lower-confidence source is promoted when the leader goes stale.

### Chainlink feeds

Chainlink token/USD feeds supplement those sources over EVM RPC. Set `CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS` to a positive number and provide `CHAINLINK_TOKEN_PRICE_CONFIG` as a JSON object keyed by chain ID. Each chain declares fallback RPC URLs and a Chainlink Reference Data Directory `catalogUrl`. The catalog supplies token/USD proxy addresses and heartbeats; feeds are matched only when an eligible indexed token and catalog base asset have a unique symbol. Discovery prefers standard reference-price proxies, falls back to the underlying proxy associated with a shared SVR feed on networks that only publish that variant, and also supports primary tokenized-price feeds. Secondary SVR proxies, ambiguous symbols, and hidden, deprecating, or non-USD feeds are skipped. An optional `feeds` array can override or supplement discovery for exceptional mappings.

Catalogs are refreshed hourly by default, controlled by `CHAINLINK_FEED_CATALOG_REFRESH_INTERVAL_SECONDS`, and the last successful response remains usable during a catalog outage. All discovered feed reads for a chain are aggregated into one on-chain Multicall3 call, which the RPC provider accounts for as a single `eth_call`; `multicallAddress` can override the standard `0xcA11...CA11` deployment for a chain. Stale, incomplete, non-positive, and superseded rounds are skipped. The RPC-reported chain ID is also checked before reading feeds.

```json
{
  "1": {
    "rpcUrls": ["https://eth-mainnet.example/v1/API_KEY"],
    "catalogUrl": "https://reference-data-directory.vercel.app/feeds-mainnet.json"
  }
}
```

Chainlink jobs are disabled when the interval is zero/unset or the config is empty. Valid observations are stored under the `cl1` source using the feed round's `updatedAt` timestamp, and unchanged rounds are not inserted repeatedly. One failing feed does not prevent fresh observations from other configured feeds on that chain.

## Database migrations

- Local: `bun run migrate` or `bun scripts/migrate.ts` (both invoke `scripts/migrate.ts`).
- Docker: `docker run --rm --env-file .env ekubo-indexer scripts/migrate.ts`.
- DigitalOcean: the `.do/app.yaml` `run-migrations` pre-deploy job automatically applies migrations before rolling out new workers, ensuring the Postgres schema is up-to-date.

Migration files live under `migrations/` and execute in order via `scripts/migrate.ts`.

## DigitalOcean App Spec

The DigitalOcean Apps spec in `.do/app.yaml` documents the full production stack:

- Workers for each network (e.g.: `starknet-mainnet`, `eth-mainnet`, `base-mainnet`) that run the corresponding network entrypoint (`bun src/starknet.ts` or `bun src/evm.ts`) with the appropriate `NETWORK` value, pulling the published Docker image (`ghcr.io/ekuboprotocol/indexer:${IMAGE_TAG}`).
- Managed Postgres (`indexer-db-nyc1`) wired in via the `PG_CONNECTION_STRING` env var along with secrets such as `DNA_TOKEN`.
- A `run-migrations` pre-deploy job and the long-running `src/price-sync/index.ts` process. Each price source/chain job has an independent timer, with separately configured CoinGecko and Chainlink cadences. The app spec discovers Chainlink feeds for eligible tokens on Ethereum, Base, Arbitrum, and Robinhood through Chainlink's multi-network catalogs and the existing Alchemy API key secret.

Use this file as a base to recreate the stack in a new DigitalOcean App Platform project or as a reference for configuring similar infrastructure elsewhere.

## Breaking changelog (tracking as of 2025-11-17)

This log records indexer deployments that:

- require **manual intervention beyond running `scripts/migrate.ts`** (e.g., backfilling data, reseeding state, or pausing workers), or
- introduce **schema changes**, even when the standard migration workflow can apply them automatically. Schema-only updates may not mandate manual steps but can still break downstream consumers that rely on the previous structure, so they belong here as well.

### 2026-09-02: Mainnet-only networks; nine new EVM mainnets

The indexer no longer runs any testnet. Removed workers, `.env.evm.*` /
`.env.starknet.*` files and `package.json` scripts for `starknet-sepolia`,
`eth-sepolia`, `base-sepolia`, `arb-sepolia` and `rhc-sepolia`, and dropped the
matching price-sync fetchers for chains 11155111, 421614 and 46630. Downstream
consumers still reading rows for those chain IDs will see the data stop
advancing; no rows are deleted by this change, so purging them is a separate
manual step if wanted.

Added mainnet workers for Optimism, Gnosis, Unichain, World Chain, Ink, BNB
Smart Chain and Polygon alongside the existing Ethereum, Base, Arbitrum,
Robinhood, Monad and MegaETH. Each new worker takes its production RPC from
`https://<network>.g.alchemy.com/v2/${EVM_RPC_ALCHEMY_API_KEY}` in `.do/app.yaml`,
falling back to the chain's public endpoint where one exists; the committed
`.env.evm.*` files keep key-free public URLs for local runs.

`.do/app.yaml`'s `&indexer-image` anchor moved from `starknet-sepolia` to
`starknet-mainnet`, since the service that defined it is gone.

### 2026-09-02: Reduce write amplification on hot tables

Three CPU fixes measured from `pg_stat_statements` on `ekubo-db-nyc1` over
2026-08-25 to 2026-09-01.

**Schema changes.** Drops `erc20_tokens_latest_price_valid_until_idx` (added in
00116). Its only consumer is `refresh_expired_erc20_token_latest_prices`, which
reads ~4,316 of the table's ~7,360 rows per scan and takes `FOR UPDATE`, so it
was barely filtering while blocking HOT on all 47.9M updates the table takes per
week. Nothing in the API filters on `valid_until`. Sets
`autovacuum_vacuum_scale_factor = 0.01` and a lowered `fillfactor` on
`pool_states`, `pool_tvl` and `erc20_tokens_latest_price`.

**Cron change.** `refresh_computed_rewards_by_position` moves from `* */6 * * *`
to `5 * * * *`. The old expression put `*/6` in the hour field and left the
minute field wide, so the job fired every minute during hours 0, 6, 12 and 18 —
240 runs/day totalling 4h52m of database time. Reward periods land on hourly
boundaries, so the new cadence is hourly rather than the six-hourly one the
broken expression was reaching for; minute 5 leaves four minutes after
`compute_incentive_rewards` (minute 1) for the boundary blocks to be indexed.
24 runs/day of ~100 s is ~40m/day.

**Manual intervention required, BEFORE this migration is deployed.** The
migration drops `erc20_tokens_latest_price_valid_until_idx`, and
`refresh_expired_erc20_token_latest_prices` (~1 call/sec) then has to find
expired rows by sequential scan. That is only cheap once the heap matches its
live rows. Measured on 2026-09-02 against the bloated 46,147-page heap:

| | buffers | time |
|---|---|---|
| index scan (today) | 50 | 0.14 ms |
| seq scan on bloated heap | 46,147 (45,155 read from disk) | 103.6 ms |
| seq scan after repack (~250 pages) | ~250 | sub-ms |

**Repack first, then deploy.** Deploying the migration against an unrepacked
table makes that once-a-second query 750x more expensive.

```sh
# ~7,700 live rows in a 361 MB heap + 280 MB of indexes.
pg_repack -d defaultdb -t erc20_tokens_latest_price -t pool_states -t pool_tvl
```

`pg_repack` 1.5.2 is available on the managed instance and rewrites without an
exclusive lock. `VACUUM (FULL, ANALYZE)` on the same three tables is equivalent
and takes seconds, but holds `ACCESS EXCLUSIVE` and will stall the indexer and
price-sync for the duration.

Note also that `fillfactor` only applies to pages written after a rewrite, and
that lowering `autovacuum_vacuum_scale_factor` lets autovacuum reclaim space in
place but never shrinks an already-bloated heap. `scripts/migrate.ts` runs each
migration inside a transaction, so the rewrite cannot live in the migration —
hence the manual step.

Downstream consumers are unaffected: no column, view or function signature
changes, so the order in which the indexer components roll is irrelevant — the
only ordering that matters is repack before migrate.

### 2026-08-09: Freshness-aware prioritized token prices

Per-source `confidence` now lives in `erc20_token_price_sources`, seeded by the migration and never written by the worker, with the quoter ranked highest. `erc20_tokens_usd_prices` gains a nullable `valid_until` that each observation carries (legacy rows are treated as valid for five minutes past their timestamp). The compact `erc20_tokens_latest_price_by_source` cache tracks those expirations, while the physical, primary-keyed `erc20_tokens_latest_price` table stores the fresh maximum-confidence aggregate for fast quoter reads. The price worker reconciles expirations once per second, promoting a lower-confidence source when needed. The `all_pool_states_view` definition remains unchanged. Apply migrations before deploying the updated price-sync worker. Consumers selecting every column from `erc20_tokens_latest_price` must account for its new `confidence` and `valid_until` columns and the synthetic `AVG` source on tied values; consumers of `erc20_tokens_usd_prices` gain a nullable column. No manual backfill is required.

This release also adds the `cl1` Chainlink price source, which reads token/USD reference feeds over EVM RPC and is seeded above the aggregator APIs (the quoter ranks highest). It is inert until `CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS` and `CHAINLINK_TOKEN_PRICE_CONFIG` are set, so no manual intervention is required to deploy without it.

### 2026-08-05: Pool-key discovery indexes

Adds two indexes on `pool_keys` — `(chain_id, token1)` and
`(chain_id, pool_extension)` — so the API's new `/poolKeys` discovery route
can filter by a single token (either side) or by extension without scanning a
chain's whole pool set. Schema-only change: run the migration; no manual
backfill is required and no existing structure changes.

### 2026-07-31: Token circulating supply

`erc20_tokens` now has a nullable, non-negative integer `circulating_supply`
column.
Like `total_supply`, the value is stored in the token's indivisible units so
consumers must divide by `10 ^ token_decimals` before multiplying by a per-token
USD price. Apply this migration before deploying the `default-tokens` database
sync that writes the new field. Existing rows remain `NULL` until that sync
finds a supply source; no manual backfill is required.

### 2026-07-31: Ve33 fee component added to fee stats

`hourly_volume_by_token` now tracks the Ve33 portion of its total `fees` in a
dedicated `ve33_fees` column. The 24-hour pool stats views expose
`ve33_fees0_24h` and `ve33_fees1_24h` as components of the existing inclusive
`fees0_24h` and `fees1_24h` totals. The migration backfills the breakdown from
indexed `PoolFeesAccounted` events and keeps both totals reorg-safe. Apply the
indexer migration before deploying API code that selects the new columns; no
manual backfill is required.

### 2026-07-31: Token price history covering index

`erc20_tokens_usd_prices` now has a covering index on
`(chain_id, token_address, timestamp DESC)` that includes the price value and
source. Apply migrations before deploying the token price-history API to keep
its bounded chart queries index-only. No backfill or manual intervention is
required beyond running the migration.

### 2026-07-31: Reorg-safe per-tick liquidity aggregation

The `per_pool_per_tick_liquidity` triggers now retain transient rows until both
the net liquidity delta and total liquidity are zero. This prevents
order-dependent corruption when position updates are cascade-deleted during a
reorg. The migration atomically rebuilds every tick aggregate from canonical
`position_updates`; no manual backfill is required beyond running the
migration.

### 2026-07-30: Pool token-pair lookup index

`pool_keys` now has an index on `(chain_id, token0, token1)` so API queries can
find every configuration for a token pair without scanning all pool keys.
Apply migrations before deploying the optimized pair-events API query. No
backfill or manual intervention is required beyond running the migration.

### 2026-07-30: Ve33 fees included in hourly pool stats

EVM V3 `PoolFeesAccounted` events now contribute to
`hourly_volume_by_token.fees`, which feeds the API's fee totals and APRs. The
migration backfills existing Ve33 fee events and keeps the hourly aggregates
correct when events are inserted or removed during a reorg. These events now
require a `pool_key_id`, so an unresolved pool fails indexing instead of being
silently omitted from fee stats. Apply migrations before deploying the updated
EVM indexer; no manual backfill is expected.

### 2026-07-28: Token metadata automation moved to `default-tokens`

The DigitalOcean `sync-tokens` scheduled job and `scripts/sync-tokens.ts` were
removed. Before deploying this indexer version, configure the
`EkuboProtocol/default-tokens` update and database-sync workflow secrets, run
the token-list update once, and run the separate database sync once. Future
token sources, generated metadata, provenance, bridge mappings, and hosted
logos are audited in that repository.

### 2026-07-16: Ve33 voted swap fee indexing

EVM V3 `VoteWeightApplied` events now store the stake's selected fee in `ve33_vote_weight_applied.voted_swap_fee`. The migration backfills existing rows to `0`, then removes the column default so new rows must provide the value. Apply migrations before deploying the updated EVM indexer; no manual backfill is required.

### 2026-06-29: Ve33 event indexing

EVM V3 Ve33 events now write to `ve33_stake_changed`, `ve33_vote_weight_applied`, `ve33_pool_fees_accounted`, `ve33_pool_fees_claimed`, `ve33_emissions_scheduled`, `ve33_pool_emissions_accrued`, and `ve33_rewards_claimed`. Robinhood Chain also indexes VeToken and FreeVe33Positions ERC721 transfers when `VE_TOKEN_V3_ADDRESS` and `VE33_POSITIONS_V3_ADDRESS` are configured. Apply migrations before deploying consumers that read these tables.

### 2026-06-29: Ve33 pool state view support

Ve33 pool quote state is now maintained in `ve33_pool_states` and exposed through `all_pool_states_view` via `ve33_*` columns plus `is_ve33_pool`. Apply migrations before deploying consumers that select from the view; no manual backfill is required beyond the migration.

### 2026-02-23: all_pool_states_view now includes unsupported extensions

`all_pool_states_view` no longer filters rows by supported pool extension state markers, so any pool with a `pool_states` row now appears in the view. Downstream consumers that assumed the view contained only quoter-supported pools should add their own filtering before deploy; no backfill or manual intervention is required beyond running migrations.

### 2026-03-23: all_pool_states_view adds pool_tvl_usd

`all_pool_states_view` now includes `pool_tvl_usd`, computed from `pool_tvl` plus `erc20_tokens_latest_price` for both pool tokens. The column is `NULL` when either side lacks a latest USD price. Apply migrations before deploying any consumer that selects from this view.

### 2026-02-10: Auctions contract event indexing

EVM V3 auction events now write to `auction_completed`, `auction_funds_added`, `auction_boost_started`, and `auction_creator_proceeds_collected`.

### 2026-02-01: Boosted fees indexing and pool flags

Boosted fees now write to `boosted_fees_events`, `boosted_fees_donate_rate_deltas`, and `boosted_fees_donated`, while `all_pool_states_view` now exposes the boosted fee donate rates plus the last donated time and future deltas. Run migrations before deploying any consumers that read the view or expect boosted-fee schedules.

### 2026-01-28: Reorg detection fork counter on indexer_cursor

The `indexer_cursor` table now includes a `fork_counter` column that increments whenever the indexer deletes blocks during reorg handling. Downstream services can use it to detect reorgs even when the cursor position is unchanged. Run the migrations before deploying consumers that query `indexer_cursor`.

### 2026-01-05: Incentives campaigns scoped to core/licensee

Incentives campaigns now require a single `core_address` and support optional locker/licensee filters (`allowed_lockers`). Run the migrations before computing rewards, and refresh `incentives.campaign_rewards_overview_materialized` after deploy so the updated filtering is reflected in dashboards.

### 2025-12-14: Remove tvl_usd from all_pool_states_view

The `tvl_usd` column has been removed from `all_pool_states_view` to keep the view lightweight. Update any consumers that read this column before deploying, then run the standard migrations; no backfill or manual work is required.

### 2025-11-29: Pool config metadata for the EVM indexer

Pools now persist the raw `PoolConfig` word plus its decoded attributes. The `pool_keys` table gains `pool_config`, `pool_config_type`, `stableswap_center_tick`, and `stableswap_amplification`, and `tick_spacing` can be null for stableswap pools. `all_pool_states_view` also surfaces these new columns so downstream quoters can tell which pool type they are handling. Starknet pools continue to expose `pool_config = NULL` because their fee encoding is incompatible with the EVM packer. No manual work is required besides running the migrations, but any consumer that relied on `tick_spacing` always being non-null should be updated before ingesting stableswap data.

### 2025-11-27: Limit-order pools in all_pool_states_view

`all_pool_states_view` now joins `limit_order_pool_states`, exposes `is_limit_order_pool`, and allows pools with the limit-order extension to appear in the view. Apply migrations before deploying any component that reads this view; no manual backfills are required.

### 2025-11-18: TWAMM proceeds withdrawal bug

We had to reindex from the beginning due to a bug in inserting TWAMM proceeds withdrawal events. We also added some columns to the TWAMM order updates and TWAMM collect proceeds tables to improve correctness.
