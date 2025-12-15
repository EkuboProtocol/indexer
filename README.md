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

The resulting image can execute any of the TypeScript entrypoints. By default it runs the main indexer; pass environment variables the same way you would locally:

```bash
docker run --rm \
  -e NETWORK_TYPE=starknet \
  -e NETWORK=mainnet \
  ekubo-indexer
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

The token-price entrypoint now runs continuously; control its cadence with `TOKEN_PRICE_SYNC_INTERVAL_MS` (milliseconds, defaults to 60000).

## Database migrations

- Local: `bun run migrate` or `bun scripts/migrate.ts` (both invoke `scripts/migrate.ts`).
- Docker: `docker run --rm --env-file .env ekubo-indexer scripts/migrate.ts`.
- DigitalOcean: the `.do/app.yaml` `run-migrations` pre-deploy job automatically applies migrations before rolling out new workers, ensuring the Postgres schema is up-to-date.

Migration files live under `migrations/` and execute in order via `scripts/migrate.ts`.

## DigitalOcean App Spec

The DigitalOcean Apps spec in `.do/app.yaml` documents the full production stack:

- Workers for each network (e.g.: `starknet-sepolia`, `starknet-mainnet`, `eth-sepolia`, `eth-mainnet`) that all run `bun src/index.ts` with the appropriate `NETWORK_TYPE`/`NETWORK` pairs, pulling the published Docker image (`ghcr.io/ekuboprotocol/indexer:${IMAGE_TAG}`).
- Managed Postgres (`indexer-db-nyc1`) wired in via the `PG_CONNECTION_STRING` env var along with secrets such as `DNA_TOKEN`.
- A `run-migrations` pre-deploy job, a scheduled `scripts/sync-tokens.ts` job, and a long-running `scripts/sync-token-prices.ts` worker that loops on `TOKEN_PRICE_SYNC_INTERVAL_MS` (ms, defaults to 60000).

Use this file as a base to recreate the stack in a new DigitalOcean App Platform project or as a reference for configuring similar infrastructure elsewhere.

## Breaking changelog (tracking as of 2025-11-17)

This log records indexer deployments that:

- require **manual intervention beyond running `scripts/migrate.ts`** (e.g., backfilling data, reseeding state, or pausing workers), or
- introduce **schema changes**, even when the standard migration workflow can apply them automatically. Schema-only updates may not mandate manual steps but can still break downstream consumers that rely on the previous structure, so they belong here as well.

### 2025-12-14: Remove tvl_usd from all_pool_states_view

The `tvl_usd` column has been removed from `all_pool_states_view` to keep the view lightweight. Update any consumers that read this column before deploying, then run the standard migrations; no backfill or manual work is required.

### 2025-11-27: Limit-order pools in all_pool_states_view

`all_pool_states_view` now joins `limit_order_pool_states`, exposes `is_limit_order_pool`, and allows pools with the limit-order extension to appear in the view. Apply migrations before deploying any component that reads this view; no manual backfills are required.

### 2025-11-29: Pool config metadata for the EVM indexer

Pools now persist the raw `PoolConfig` word plus its decoded attributes. The `pool_keys` table gains `pool_config`, `pool_config_type`, `stableswap_center_tick`, and `stableswap_amplification`, and `tick_spacing` can be null for stableswap pools. `all_pool_states_view` also surfaces these new columns so downstream quoters can tell which pool type they are handling. Starknet pools continue to expose `pool_config = NULL` because their fee encoding is incompatible with the EVM packer. No manual work is required besides running the migrations, but any consumer that relied on `tick_spacing` always being non-null should be updated before ingesting stableswap data.

### 2025-11-18: TWAMM proceeds withdrawal bug

We had to reindex from the beginning due to a bug in inserting TWAMM proceeds withdrawal events. We also added some columns to the TWAMM order updates and TWAMM collect proceeds tables to improve correctness.
