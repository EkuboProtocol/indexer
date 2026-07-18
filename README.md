# `@ekubo/indexer`

Service for indexing Ekubo events into a Postgres database.

## Overview

The indexer focuses on producing an always-consistent realtime view of Ekubo events, using the Apibara service to get a stream of relevant data.

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

Override the command to reuse the same image for auxiliary scripts (migrations, token sync, etc.). The default entrypoint is already `bun`, so point it to the desired TypeScript file:

```bash
docker run --rm ekubo-indexer scripts/migrate.ts
```

Match the examples in `.do/app.yaml` to run other helpers, e.g.:

```bash
docker run --rm ekubo-indexer scripts/sync-tokens.ts
docker run --rm ekubo-indexer scripts/sync-token-prices.ts
```

The token-price entrypoint runs continuously; control its default cadence with `TOKEN_PRICE_SYNC_INTERVAL_MS` (milliseconds, defaults to 60000). CoinGecko contract-token prices for Base, Robinhood, and Arbitrum, plus their native ETH price and Ethereum mainnet's native ETH price, use a separate `COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS` cadence. Set it to a positive number and provide `COINGECKO_API_KEY` to enable CoinGecko syncing; zero or an unset value disables it.

Chainlink token/USD feeds can supplement those sources over EVM RPC. Set `CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS` to a positive number and provide `CHAINLINK_TOKEN_PRICE_CONFIG` as a JSON object keyed by chain ID. Each chain declares fallback RPC URLs and a list mapping indexed token addresses to Chainlink aggregator addresses. `maxAgeSeconds` should match the feed's expected heartbeat; stale, incomplete, non-positive, and superseded rounds are skipped. The RPC-reported chain ID is also checked before reading feeds.

```json
{
  "1": {
    "rpcUrls": ["https://eth-mainnet.example/v1/API_KEY"],
    "feeds": [
      {
        "tokenAddress": "0x0000000000000000000000000000000000000000",
        "feedAddress": "0x0000000000000000000000000000000000000001",
        "maxAgeSeconds": 3600
      }
    ]
  }
}
```

The example addresses are placeholders. Chainlink syncing is disabled when its interval is zero/unset or its config is empty. Valid observations are stored under the `cl1` source using the feed round's `updatedAt` timestamp, and unchanged rounds are not inserted repeatedly. One failing feed does not prevent fresh observations from other configured feeds on that chain.

## Database migrations

- Local: `bun run migrate` or `bun scripts/migrate.ts` (both invoke `scripts/migrate.ts`).
- Docker: `docker run --rm --env-file .env ekubo-indexer scripts/migrate.ts`.
- DigitalOcean: the `.do/app.yaml` `run-migrations` pre-deploy job automatically applies migrations before rolling out new workers, ensuring the Postgres schema is up-to-date.

Migration files live under `migrations/` and execute in order via `scripts/migrate.ts`.

## DigitalOcean App Spec

The DigitalOcean Apps spec in `.do/app.yaml` documents the full production stack:

- Workers for each network (e.g.: `starknet-sepolia`, `starknet-mainnet`, `eth-sepolia`, `eth-mainnet`) that run the corresponding network entrypoint (`bun src/starknet.ts` or `bun src/evm.ts`) with the appropriate `NETWORK` value, pulling the published Docker image (`ghcr.io/ekuboprotocol/indexer:${IMAGE_TAG}`).
- Managed Postgres (`indexer-db-nyc1`) wired in via the `PG_CONNECTION_STRING` env var along with secrets such as `DNA_TOKEN`.
- A `run-migrations` pre-deploy job, a scheduled `scripts/sync-tokens.ts` job, and a long-running `scripts/sync-token-prices.ts` worker that loops on `TOKEN_PRICE_SYNC_INTERVAL_MS` (ms, defaults to 60000), with independently configured CoinGecko and Chainlink cadences. The app spec enables native ETH/USD Chainlink feeds on Ethereum, Base, and Arbitrum through the existing Alchemy API key secret.

Use this file as a base to recreate the stack in a new DigitalOcean App Platform project or as a reference for configuring similar infrastructure elsewhere.

## Breaking changelog (tracking as of 2025-11-17)

This log records indexer deployments that:

- require **manual intervention beyond running `scripts/migrate.ts`** (e.g., backfilling data, reseeding state, or pausing workers), or
- introduce **schema changes**, even when the standard migration workflow can apply them automatically. Schema-only updates may not mandate manual steps but can still break downstream consumers that rely on the previous structure, so they belong here as well.

### 2026-07-16: Ve33 voted swap fee indexing

EVM V3 `VoteWeightApplied` events now store the stake's selected fee in `ve33_vote_weight_applied.voted_swap_fee`. The migration backfills existing rows to `0`, then removes the column default so new rows must provide the value. Apply migrations before deploying the updated EVM indexer; no manual backfill is required.

### 2026-06-29: Ve33 event indexing

EVM V3 Ve33 events now write to `ve33_stake_changed`, `ve33_vote_weight_applied`, `ve33_pool_fees_accounted`, `ve33_pool_fees_claimed`, `ve33_emissions_scheduled`, `ve33_pool_emissions_accrued`, and `ve33_rewards_claimed`. Sepolia also indexes VeToken and FreeVe33Positions ERC721 transfers when `VE_TOKEN_V3_ADDRESS` and `VE33_POSITIONS_V3_ADDRESS` are configured. Apply migrations before deploying consumers that read these tables.

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
