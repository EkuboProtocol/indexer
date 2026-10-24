# `@ekubo/indexer`

Service for indexing Ekubo events into a Postgres database.

## Overview

The indexer focuses on producing an always-consistent realtime view of Ekubo events. Every network — Starknet included — is read by polling its own RPC over block ranges; see [Block streams](#block-streams).

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
  -e STARKNET_RPC_URL=<url> \
  ekubo-indexer bun src/starknet.ts
```

The image sets `NODE_ENV=production`, and in production a worker exits at
startup unless its `EVM_RPC_URL` or `STARKNET_RPC_URL` is set in the process
environment. The image still contains the committed `.env.evm.*` files, but their
key-free public URLs are only for local runs. Pass `-e NODE_ENV=development` to
use them from the image.

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

The price-sync process runs every configured job as an independent recurring loop. A job declares the chains it may write prices for plus a three-character source identifier; startup fails if two jobs claim the same chain and source. Most jobs price one chain, but a job may price several when one upstream request covers them all. `TOKEN_PRICE_SYNC_INTERVAL_MS` controls the default cadence in milliseconds (default: `60000`). CoinGecko jobs use `COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS`; set it to a positive number and provide `COINGECKO_API_KEY` to enable them. Zero or an unset value disables those jobs. The single native-currency `cgn` job can run on its own cadence with `COINGECKO_NATIVE_PRICE_SYNC_INTERVAL_SECONDS` (unset follows the token interval; zero disables it). It costs one request per cycle for every chain, and it is the primary native-currency price on several chains whose only other source is a lower-ranked fallback, so it is worth running more often than the per-chain token jobs.

Two properties keep CoinGecko request volume flat rather than growing with `erc20_tokens`:

- Native currency prices for every chain come from a single `cgn` job. Chains sharing a CoinGecko coin ID cost one request between them, not one apiece.
- The per-chain `cg1` jobs request only the tokens CoinGecko has actually priced. Everything else is re-probed on a slow rotation (a full pass per day), so a chain with thousands of unlisted tokens does not pay for them every cycle. The rotation survives restarts: the first cycle seeds the priced set from the retained `cg1` rows in `erc20_tokens_latest_price_by_source` and treats every token already in the table as probed, and the re-probe slot follows the wall clock rather than a per-process counter. Tokens added after startup are still probed on their next cycle. Only a chain with no retained `cg1` rows at all does a full sweep (logged as `cold start`; a seeded chain logs `warm start`). If a cold sweep is cut short -- by a restart, or by the quota gate below -- after some `cg1` rows were written, the next start is warm, and the tokens the sweep never reached are found by the daily rotation rather than immediately. Each cycle serves every rotation slot whose interval epoch has passed since the last cycle it served, so launch jitter around an epoch boundary neither repeats nor skips a slot, and a paused job catches up (at most one full rotation) when it resumes.

Every chain the `cgn` job prices also has a native-currency source that does not depend on CoinGecko, so a CoinGecko outage leaves none of them without a native price. Where Sushi's price list carries no native sentinel (Gnosis, Monad, MegaETH), its `ss1` job prices `0x0` from the chain's wrapped native token, configured per chain as `wrappedNative`. Chains that pay gas in ETH bridged from Ethereum and have no Sushi price list (Unichain, World Chain, Ink) get Ethereum's native price from the `em1` mirror job: each cycle it copies the best current non-CoinGecko `0x0` row on chain 1 (`qp1`, `cl1` or `ss1`), stamped now and with the copied row's `valid_until`. Both rank below `cgn`, so they serve only while it is stale. Never give a chain both `em1` and an `ss1` job: they share confidence 1 and would be averaged (a test enforces this).

The CoinGecko credit limit belongs to the account, so every CoinGecko job shares one quota gate. A `429` with `error_code` 10006 (monthly credit limit reached) pauses all of them for six hours and logs a single `COINGECKO_QUOTA_EXHAUSTED ... paused_until=<iso>` line; other 429s fail the cycle as usual. An hourly `GET /key` check logs `COINGECKO_CREDITS plan=… limit=… used=… remaining=… remaining_pct=…` (or `COINGECKO_CREDITS_CHECK_FAILED`) and reopens the gate early, logging `COINGECKO_QUOTA_RESTORED`, once at least 1,000 credits are available again (a smaller margin would reopen, spend it, and trip again every hour). Those lines are what the external quota monitor matches.

### Price source prioritization

Per-source `confidence` lives in `erc20_token_price_sources`, seeded once by the migration — the worker never writes that table, so policy adjustments (made in a later migration) survive deploys. Freshness is per observation instead: each price row carries a `valid_until`, stamped by the job as three of its own sync intervals (one-minute floor), except Chainlink, which uses the feed's heartbeat window anchored at the round's `updatedAt`. Rows predating the column fall back to five minutes past their timestamp. The latest-price cache prefers the quoter (the interface derives price-impact loss from it), then Chainlink, then CoinGecko, then SushiSwap and the `em1` native mirror; it averages sources tied at the highest confidence, records the result under the synthetic `AVG` source, and reconciles expiration once per second so a lower-confidence source is promoted when the leader goes stale.

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

## Block streams

EVM and Starknet share `src/_shared/blockStream.ts`. The adapters read filtered
ranges of events; only event-bearing blocks need event processing. Empty ranges
still write a durable cursor and head, without inserting empty `blocks` rows.

### RPC endpoint consistency contract

Starknet accepts exactly one HTTP(S) endpoint in `STARKNET_RPC_URL`. EVM accepts
an ordered, comma-separated list in `EVM_RPC_URL`, primary first; one URL is the
common case and behaves exactly as a list of one. **Each entry must satisfy the
contract below on its own**: the list is read one endpoint at a time, never
spread across a read. Failed requests retry against the same endpoint. A read that still fails emits nothing: the stream
logs `provider read failed; backing off`, waits (doubling from the poll interval
to `MAX_POLL_INTERVAL_MS`) and re-plans from a fresh head. Only reads failing
back to back for more than ten minutes exit, restarting from the durable cursor.
Exiting on the first failure turned a sixteen-minute provider outage into 89-315
restarts per chain, each re-requesting the refused range (EKU-502). Startup
reads (the chain ID and the stored cursor) are retried the same way, so a total
outage does not become a restart loop either.

With more than one EVM endpoint, `src/evm/stickyRpc.ts` sends every request to
the current one, and changes it only at the top of a stream loop turn, before
the finalized refresh and the plan. Plan, range read, reconciliation, stored-
history recovery and the finality announcement therefore always share one
endpoint. viem's `fallback()` is not used for this because it picks per request,
which could fence one provider's logs with another's head (the A -> B -> A case
below). To the stream, a switch between turns is a changed view between turns,
which the cursor check and the window diff already handle.

- It leaves the current endpoint after a failed read, or when that endpoint's
  head is more than `RPC_STALE_HEAD_SECONDS` (default 120) behind the wall clock
  -- a provider can freeze `latest` without any error (Unichain, 2026-09-30).
- It returns to the first endpoint after `RPC_FAILBACK_MINUTES` (default 15).
- Every switch is probed first, in both directions: the candidate must report
  the right chain ID, a `latest` block at or above the cursor, a head no older
  than `RPC_STALE_HEAD_SECONDS`, and, when leaving a stale head, a head ahead of
  it. A chain halt, where every endpoint is stale, therefore does not flip
  endpoints, and a failback to a primary still frozen below the cursor does not
  happen. A candidate that fails its probe waits `RPC_PROBE_INTERVAL_SECONDS`
  (default 30) before the next one.
- Each endpoint's chain ID is verified before its first use. A wrong chain ID is
  fatal wherever it is found; an endpoint that does not answer is only skipped,
  so a secondary's outage cannot stop a worker whose primary is healthy.
- `SUSPECT_LOG_COUNT` takes one value, or one per endpoint in the same order,
  since result caps are per provider.
- Every switch and rejected probe is logged (`switched RPC endpoint`, `RPC
  endpoint not healthier; staying`) with the endpoint's origin only.

Endpoint URLs carry the provider key, and viem copies the URL into every HTTP
error message, so the logger redacts them from every line it writes
(`src/_shared/redactSecrets.ts`): configured `EVM_RPC_URL` / `STARKNET_RPC_URL`
values are reduced to their origin, and key-shaped URL parts (`/v2/<key>`,
`/rpc/v0_10/<key>`, `dkey=`, `apikey=`) are masked wherever they appear.

The provider must return complete range results and a consistent canonical view
across requests, including across its own caches and load-balanced backends.
Specifically, if `eth_getLogs(fromBlock, toBlock)` is sandwiched between header
reads for `toBlock` and both headers have the same hash, the entire range result
must correspond to that ending block's ancestry. This includes blocks with no
matching logs. Returning a transient different branch between matching header
reads (A -> B -> A) violates this assumption. A single URL alone cannot enforce
this contract; do not put an uncoordinated multi-provider proxy behind it.
Starknet requires the equivalent consistency for its paginated event reads.

Each range is fenced by its ending block hash: read the ending header, fetch all
logs/pages and missing timestamps, verify the previous cursor, then re-read the
ending header. Nothing is emitted until those checks succeed. A missing or
incorrect trailing header cannot advance the cursor. Events in the ending block
must agree with its header. Starknet also pins the event query's `to_block` to
that hash. Cursor verification and stored-history recovery remain necessary for
real chain reorgs, including those that happen while the indexer is offline.

EVM uses timestamps supplied with logs and fetches intermediate headers only
when a timestamp is unavailable or invalid; fallback headers are hash-checked.
The ending header is reused for its timestamp and base fee. Historical base fees
are not stored in `blocks`; the head fee remains on `indexer_cursor` for quoting.
Starknet still completes fresh event-bearing blocks from its block API.

These checks rely on the provider contract above. They detect observed branch
changes and malformed results; they do not cryptographically prove event
completeness or independently enforce consistency across requests.

### Event identity and pagination

EVM preserves the block-wide `logIndex` as `event_index`. Starknet preserves the
transaction-local `event_index` and sorts events by transaction and event index.
Starknet requires JSON-RPC v0.10 or later, where those positions are supplied by
[`EMITTED_EVENT`](https://github.com/starkware-libs/starknet-specs/blob/master/api/starknet_api_openrpc.json).
Both transaction and event indices must fit the database's unsigned 16-bit fields;
unsupported indices fail before processing instead of producing wrong IDs.

Duplicate event positions, mixed hashes for one block, events outside the requested
range, and unhashed events in a numbered Starknet range are rejected. Starknet
pagination rejects repeated or invalid continuation tokens. Malformed JSON-RPC
envelopes, including mismatched response IDs, are retried as transport failures.

`SUSPECT_LOG_COUNT` defaults to 10,000. EVM responses with exactly that many logs
are split and re-read; a single block still hitting the configured cap is refused
because completeness cannot be established. Provider range errors retain their
cause and name `GET_LOGS_RANGE_SIZE` as the configuration knob. Starknet also
bounds pages per range. Configure the range and cap for the provider in use.

### Reorgs, restart, and finality

The stream re-reads an event window below the cursor and compares hashes and
counts. It also verifies the saved cursor hash, which commits to the history below
it. A deeper reorg therefore cannot be hidden merely by falling outside the
polling window. Recovery uses a matching block in the window when possible;
otherwise it walks persisted event-bearing blocks backwards until a canonical
hash matches. Without a verified checkpoint it rebuilds from the configured initial indexing
boundary (block zero if none is supplied), rather than guessing a rewind depth.
An unavailable checkpoint stops recovery.

Startup verifies the persisted cursor before seeding the window. If its hash is
missing, recovery replays from verified stored history. A second check during the
range catches a reorg between startup verification and seeding. The seeded window
is then checked against the `blocks` table: an event-bearing block at or below the
cursor that is missing from it, or stored under another hash, is rolled back and
re-indexed. Without that, a block skipped just before a restart -- a provider
whose log index lagged its head for one read -- was adopted as already emitted and
lost for good (EKU-272, Ethereum block 25739240). Adding a filter address and restarting
therefore rolls back one window on the first read, because the chain now reports
events the store never took. That is expected and bounded, not a fault. Rollback clears
orphaned head/gas metadata and any finalized cursor above the rollback height.

Newly reported finality remains pending until the previous window has been
reconciled, its hash checked, and its history indexed. It cannot move the read
floor first and hide a reorg that happened just before finalization. Current RPC
finality is not used to bound recovery of previously stored, possibly orphaned
events. EVM uses `finalized`; Starknet uses `l1_accepted`.

#### Rollback limits

Every rollback deletes the stored blocks above its target, and the cascade deletes
their events. Window rollbacks are bounded by the re-read window, but stored-history
recovery is not: an RPC endpoint answering for the wrong chain, or with corrupt
hashes, fails every stored block and lands on the initial boundary, deleting the
chain's whole history. Before deleting anything, the worker refuses:

- a recovery walk that reaches a stored block at or below the persisted finalized
  cursor (`indexer_cursor.finalized_order_key`) whose hash no longer matches. That
  cursor is written only after the history beneath it was reconciled, so the
  endpoint is wrong or finality itself failed. The walk stops at that block rather
  than reading every stored block first. This is the persisted cursor, not the
  endpoint's current finalized block: rows orphaned while the worker was down can
  sit below the latter and are still removed. Window rollbacks are not bounded by
  finality, because re-indexing a block the store missed, or events a newly added
  filter address now matches, legitimately deletes canonical finalized rows; on
  chains that finalize within a few blocks the first window after a restart reaches
  below the persisted finalized block.
- any rollback deeper than `MAX_REORG_DEPTH` blocks below the persisted cursor, when
  that is set. It is unset by default; if set, it must be at least the re-read window
  (at most half `GET_LOGS_RANGE_SIZE`) or a filter change can never be re-indexed.

A refusal logs `evt: "rollback_refused"` with the reason, block numbers, finalized
block and limit, then exits without deleting anything. `scripts/restart.sh` restarts
the worker, which re-derives the same rollback and refuses again until the endpoint
answers correctly, so the chain stops advancing and the head freshness monitor
alerts. Fix the endpoint first. Only if the chain really did reorg past the
persisted cursor should an operator, under a separately authorized database change,
clear `finalized_order_key` for that chain (or raise `MAX_REORG_DEPTH`) and let the
next start roll back.

`REORG_WINDOW_SECONDS` (default 120) determines the inexpensive comparison window
from the observed block rate. It is capped at half `GET_LOGS_RANGE_SIZE` to ensure
forward progress. A smaller window can make recovery replay more history; cursor
verification remains active regardless of that cap.

### Polling and backoff

`POLL_INTERVAL_MS` defaults to 2,000. After `QUIET_POLLS_BEFORE_BACKOFF` (default 30) consecutive polls without indexed events, the interval doubles up to
`MAX_POLL_INTERVAL_MS` (default 30,000). Events or a reorg reset it. Set the maximum
equal to the minimum to disable backoff. Backoff also delays head/gas freshness.

An unchanged head hash can skip the range read because its ancestry is unchanged.
Range queries still cover every intervening block when the head advances.

### Head freshness monitor

`scripts/monitorHeadLag.ts` reads `indexer_cursor` (read-only) and alerts a
Paperclip routine webhook when a chain's `head_block_time` is more than its
threshold behind the database clock on `HEAD_LAG_SUSTAIN_CHECKS` (default 2)
consecutive runs, or when the check itself fails that many times in a row. Run it
every minute. A live chain's lag is its block time plus at most
`MAX_POLL_INTERVAL_MS`, since the head is written on every poll; the default
threshold is 300 s (`HEAD_LAG_THRESHOLD_SECONDS`), half the interface's
ten-minute "API Performance Degraded" banner. `HEAD_LAG_CHAINS` is a comma list
of `chainId=name[:seconds|off]`: listed chains must be present, and unlisted
rows are still checked at the default. An ongoing lag re-alerts at most once per
`HEAD_LAG_REALERT_MINUTES` (default 60); streaks live in `HEAD_LAG_STATE`. The
rules are in `scripts/headLagRules.ts`; `--test-alert` proves delivery. It uses
block time, not `last_updated`, because a provider that freezes its `latest`
block produces no error at all (Unichain, 2026-09-30, EKU-500).

### Verification

`scripts/verifyStarknetStream.ts` compares a settled range against stored events.
The new consistency checks prevent future inconsistent commits; correcting an
already inconsistent historical range requires replaying from a verified point
before that range.

`scripts/verifyLogStream.ts` settles the question directly for a given chain and
range, replaying it through the stream and diffing against a direct query:

```
bun scripts/verifyLogStream.ts https://mainnet.base.org base 600 100 \
  0x4200000000000000000000000000000000000006
```

It exits non-zero on any mismatch.

### Auditing and repairing event gaps

`scripts/auditEventGaps.ts` compares every block the chain reports events for,
under the indexer's own filters, with the `blocks` table (read-only on both
sides). It defaults to all settled history for the network; pass a range, or set
`AUDIT_LAST_SECONDS` for recent history only. `AUDIT_NETWORK_TYPE=starknet`
audits Starknet (the RPC must speak JSON-RPC v0.10):

```
NETWORK=mainnet AUDIT_RPC_URL=https://mainnet.gateway.tenderly.co \
  PG_CONNECTION_STRING=... bun scripts/auditEventGaps.ts [from] [to]
```

`missing` and `hash` findings are lost or wrong data and exit 1. `count` and
`extra` also result from filter changes and from rows written before `num_events`
meant "matched filters", so `count` is only totalled unless
`AUDIT_REPORT_COUNTS=1`.

`scripts/backfillBlocks.ts <block>...` indexes finalized blocks the stream skipped
without moving the cursor. It is a dry run (rolled back) unless given `--apply`.
It uses the runtime's processors and DAO, then recomputes `pool_states` for pools
with a backfilled swap, because `on_insert_swap` assumes the newest swap. It
refuses to commit if any current pool state would change. The other triggers on
these tables are order-independent. To reverse a backfill, delete the block
through the same cascade a reorg uses:
`DELETE FROM blocks WHERE chain_id = <chain> AND block_number = <block>`.

`scripts/monitorEventGaps.ts` runs the audit over each chain's recent finalized
history (`GAP_MONITOR_WINDOW_SECONDS`, default 3 h). It POSTs an HMAC-signed alert
to a Paperclip routine webhook when it finds a gap, or when a chain's check fails
twice. `GAP_MONITOR_CHAINS` is a comma list of `network=rpcUrl`, with a
`starknet/` prefix for Starknet and an optional `|maxRange` suffix for an
endpoint that refuses wide reads. `--test-alert` proves delivery.

## Database migrations

- Local: `bun run migrate` or `bun scripts/migrate.ts` (both invoke `scripts/migrate.ts`).
- Docker: `docker run --rm --env-file .env ekubo-indexer scripts/migrate.ts`.
- DigitalOcean: the `.do/app.yaml` `run-migrations` pre-deploy job automatically applies migrations before rolling out new workers, ensuring the Postgres schema is up-to-date.

Migration files live under `migrations/` and execute in order via `scripts/migrate.ts`.

## DigitalOcean App Spec

The DigitalOcean Apps spec in `.do/app.yaml` documents the full production stack:

- Workers for each network (e.g.: `starknet-mainnet`, `eth-mainnet`, `base-mainnet`) that run the corresponding network entrypoint (`bun src/starknet.ts` or `bun src/evm.ts`) with the appropriate `NETWORK` value, pulling the published Docker image (`ghcr.io/ekuboprotocol/indexer:${IMAGE_TAG}`).
- Managed Postgres (`indexer-db-nyc1`) wired in via the `PG_CONNECTION_STRING` env var, alongside the per-worker RPC secrets (`EVM_RPC_URL`, `STARKNET_RPC_URL`).
- A `run-migrations` pre-deploy job and the long-running `src/price-sync/index.ts` process. Each price source/chain job has an independent timer, with separately configured CoinGecko and Chainlink cadences. The app spec discovers Chainlink feeds for eligible tokens on Ethereum, Base, Arbitrum, and Robinhood through Chainlink's multi-network catalogs and the existing Alchemy API key secret.

Use this file as a base to recreate the stack in a new DigitalOcean App Platform project or as a reference for configuring similar infrastructure elsewhere.

## Breaking changelog (tracking as of 2025-11-17)

### Unreleased: zero-seed launches (00140, additive)

Migration 00140 (schema `zero-seed-launch-index/v4`) indexes the forward-only
`ZeroSeedLaunch` extension and its `ZeroSeedLaunchPeriphery` (evm-contracts
`43d6628`; ABI sha256 `efae9388…e41e` and `df24d9f0…7305`, `jq -cS .abi`
without a trailing newline, unchanged since `550afc4`; the protocol's interface manifest is vendored as
`tests/fixtures/zero-seed-launch/zero-seed-interface-43d6628.json`) into `zero_seed_launch_pool_keys`, `_created`,
`_swapped`, `_fees_claimed`, `_owner_changed`, `_fees_paid` and
`zero_seed_launch_states` (one row per launch: the creator fee ledger, kept
apart from the Core pool reserves, and the periphery owner). It appends eleven
`zero_seed_launch_*`/`is_zero_seed_launch_pool` columns to
`all_pool_states_view`, and the launch's creation event becomes a source for
`pool_last_event_id`. It parks the workers by locking `blocks` first, as 00123
does. The schema must precede any later quoter-service or API deployment
selecting the new columns. This draft authorizes no deployment or live
database write. It was drafted as 00134, renumbered to 00139 to follow 00138,
then to 00140 to follow `00139_mev_capture_v21` (whose objects it does not
touch), and revised in place before any application, last for the per-launch
quote and requested supply, then for the second fee model:

- Two fee models, bound to the deployment pin (`ZeroSeedLaunchPin.feeModel`),
  never inferred from an event. `fixed_base_duration_v1` is evm-contracts
  `43d6628` (`uint32 feeDuration`, the fixed-base table below; the earlier
  revision and the existing fixture). `tick_rate_v2` is evm-contracts `3d6378f`
  (`uint64 decayRateX32`, unsigned Q32.32 ticks per second, in the same
  position; ABI sha256 `89ff4d15…aadd` and `a6d43b36…db07`, `LaunchCreated`
  topic `0x8f81ce1b…5888`): the excess over the long-run floor `final_fee`
  shrinks by `toFixed(tickToSqrtRatio(-m))`, `m = floor(rate * elapsed /
  2^32)`, and saturates to `final_fee` once `elapsed > 381061679028371455 /
  rate`; rate 0 keeps `initial_fee`. A pin's logs are decoded only with its
  model's ABI, so a creation of the other revision (another topic) is never
  decoded. `zero_seed_launch_created.fee_model` records the model,
  `fee_duration` is v1 only, `decay_rate_x32 NUMERIC` (uint64 does not fit
  `int8`) is v2 only, and a `CHECK` admits exactly the model's parameter in
  range; `fee_end` is `NULL` for v2, which has no end.
  `zero_seed_launch_tick_factor_q128`, `zero_seed_launch_tick_rate_fee` and
  the dispatcher `zero_seed_launch_model_fee_at(fee_model, trading_start,
  fee_duration, decay_rate_x32, initial, final, time)` mirror the contract; the
  v1 functions are unchanged. The view gains `zero_seed_launch_fee_model` and
  `zero_seed_launch_decay_rate_x32` (eleven columns in all). Fresh `main` ends
  at `00139_mev_capture_v21`, so the number stays 00140.
- The quote is per launch: `LaunchParameters.quoteToken` (replacing the
  extension's constructor quote and its `quoteToken()` getter) is the other
  token of the launch's pool key, so one extension and periphery serve every
  quote. Native ETH is `address(0)`, always token0; an ERC-20 quote above the
  launch token makes the launch token token0. The decoder refuses a
  `LaunchCreated` whose pool key is not (token, quoteToken) in order, whose
  token is its quote, or whose liquidity is zero.
  `zero_seed_launch_created.quote_token`/`quote_kind` (`native` or `erc20`)
  record every launch of an indexed extension; whether a quote is supported is
  the reader's policy.
- `LaunchParameters.supply` is the requested supply (the token's
  `totalSupply`); liquidity is no longer an input. The extension computes the
  installed liquidity, puts `installedSupply <= supply` into the position and
  mints the remainder directly to `address(0)`. `supply` became
  `requested_supply`, `installed_supply` and the generated `sink_supply =
  requested_supply - installed_supply` (`CHECK 0 < installed <= requested`).
  `LaunchCreated` does not carry the installed amount: the writer takes the
  launch-token delta of Core's `PositionUpdated` of the creation (same
  transaction and pool, locker the extension, salt 0, the launch bounds,
  liquidity delta equal to `LaunchCreated.liquidity`, no quote) and refuses the
  launch if there is not exactly one such update or it is inconsistent. Core
  emits it inside `updatePosition`, before the extension emits
  `LaunchCreated`, and a block's logs are written in order in one transaction,
  so the row is always present and reorgs remove both together.
- Creator fees accept the whole `uint64` range: `initial_fee` and `final_fee`
  are `NUMERIC` and hold any Q0.64 rate up to `2^64 - 1` (just under 100%)
  exactly. The protocol no longer has a 99% ceiling or a `FeeTooHigh` error;
  the schema is unchanged.
- At `43d6628` the extension installs the exact largest token0 liquidity the
  requested supply pays for, `floor(supply * lower * upper / (2^128 * (upper -
  lower)))` over the fixed sqrt ratios, instead of the shared helper's earlier
  floor, which installed less at low prices. The indexer does not recompute the
  installation: it stores `LaunchCreated.liquidity` and Core's position delta,
  so neither the schema nor the decoder changes. A creation can now have an
  empty sink (`installed_supply = requested_supply`, no mint to `address(0)`),
  which the existing `CHECK 0 < installed <= requested` already allows.
- Earlier revisions: `decayFactor`, `decay_factor`, `zero_seed_launch_pow_q64`
  and the view column `zero_seed_launch_decay_factor` are gone;
  `zero_seed_launch_decay_q128` and a five-argument `zero_seed_launch_fee_at`
  mirror the contract's fixed-base Q128 table (600 s half-life, floor after
  every multiply).
- `LaunchCreated` names the `controller` (the forwarding locker, normally the
  periphery) instead of a creator, and `CreatorFeesClaimed` lost its recipient.
  The periphery's `LaunchOwnerChanged(poolId, 0, owner)` gives the launch's
  initial owner; later ones move `current_owner`, which holds the unclaimed and
  future fee rights. `LaunchFeesClaimed` is the payout of the same claim and is
  linked to the extension's `CreatorFeesClaimed` in the same transaction: it
  moves `paid{0,1}` only and never the claimed ledger.

A database that applied an earlier draft (00134 or 00139) must be rebuilt from scratch locally;
there is no in-place upgrade path and none is needed while no launch is live.

Launch indexing is off unless `ZERO_SEED_LAUNCH_ADDRESS` and
`ZERO_SEED_LAUNCH_RUNTIME_CODEHASH` both match an entry in
`src/evm/zeroSeedLaunchConfig.ts`. No live deployment is pinned; the only pins
are the local instances of the two replay fixtures (one per fee model),
refused in production. A pin binds its fee model and that model's ABIs, chain,
extension and runtime, periphery and runtime (taken from the pin,
never configured), Core and the deployment block; it has no quote. The
zero-filled template runtimes of the build are refused as codehashes. A set address or Core that disagrees with the pin stops the
worker. Missing runtime/chain pins leave support off.

Catch-up is deployment-block inclusive. Before its first block the worker
refuses to index a pinned instance from a block after the instance's
deployment unless this database indexed the deployment's
`ExtensionRegistered` and registered every launch pool Core initialized since;
otherwise launch events could be missing. Recovery is to roll the indexer back
to the block before the deployment (delete blocks at or above it) and restart:
replay is idempotent and the ledgers and owners are exact under reorgs.

Rollback before any launch exists: in one transaction that locks `blocks`
first, recreate `all_pool_states_view` and `recompute_pool_last_event_id` from
00123 and drop the `zero_seed_launch_*` tables and functions. Once launches
exist on chain, rolling back only stops indexing them; their pools and locked
principal are unaffected. Stop supported creation/handoff by leaving launch
support off. Apps cannot refund, withdraw, rebalance or migrate the immutable
principal.

`tests/fixtures/zero-seed-launch/local-chain.json` is regenerated with
`bun scripts/zeroSeedLaunchFixture.ts <evm-contracts checkout>` (local anvil,
no fork, deterministic); `src/evm/zeroSeedLaunchReplay.postgres.test.ts`
replays it against `TEST_PG_CONNECTION_STRING` (any disposable server, for
example `docker run --rm -d -p 127.0.0.1:55432:5432 -e
POSTGRES_PASSWORD=postgres postgres:18` and
`TEST_PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/postgres`;
the test creates and drops its own databases). The generator only reads the
checkout, requires the exact clean pinned source and checks both ABIs,
creation codes and runtime templates. Its chain has one extension and
periphery with native-ETH and ERC-20 quote launches (the checkout's plain
`test/TestToken.sol` relocated to `0xff…ff`) and swaps through the compiled
`test/LaunchTestRouter.sol`; six launches request `1e27` at the default
geometry and two ERC-20 (token0) launches use low-price geometry where the
exact installation differs from the shared helper (`1e30` over ticks
`-88080384..-85983232` at spacing 524288, and an int128-scale supply over the
full width at spacing 1, which installs its whole supply). Each launch's
liquidity, installed and sink supply equal the protocol's exact installation
vectors (`tests/fixtures/zero-seed-launch/zero-seed-launch-installation.json`,
vendored verbatim). The generator
checks the `Installation` that `create` returns, Core's `PositionUpdated`
delta, `totalSupply` and `balanceOf(address(0))` against the requested,
installed and sink supply it records. The replay compares, after every block,
indexed Core state and custody (native ETH and ERC-20), the creator fee
ledger, the current and initial owner, the supply and the contract's `feeAt`
with the chain, including two launches created at the maximum rate `2^64 - 1`
(native max to 0.3% over 3,600 s and ERC-20 flat at the maximum) whose swaps
net `floor(gross / 2^64)` on exact input and pay `calculated * 2^64` on exact
output, and covers a reorg across transfers, claims and a creation,
redelivery, deletion orders, orphans, missing or inconsistent Core position
updates and the catch-up guard.
`fee-curve-all-seconds.json.gz` and `fee-decay-vectors.json` are the protocol's
independent fee vectors (25,212 rows); the SQL fee function reproduces every
row. Contract-event replay does not enforce producer build-time/start/expiry
rules: those require fresh-time producer/owner validation.

`tests/fixtures/zero-seed-launch/local-chain-v2.json` is the same chain
program generated at evm-contracts `3d6378f` (`bun
scripts/zeroSeedLaunchFixture.ts <checkout at 3d6378f>
tests/fixtures/zero-seed-launch/local-chain-v2.json`; the checkout's head
selects the model and its pinned ABIs, creation codes and runtime templates).
Its launches use rates 0 (flat), 1 (slowest), `2^30` (a quarter tick per
second, on the reorg fork), the one-day default `68913100933`, the 600 s rate
`9923486534471` and `2^64 - 1` (at the floor from the first second).
`src/evm/zeroSeedLaunchReplayV2.postgres.test.ts` replays it and checks, after
every block, Core state, ledgers, owners, supply and the contract's `feeAt`
against `zero_seed_launch_model_fee_at`, every swap's fee rate, a reorg, the
schedule `CHECK`, and the SQL tick-rate functions against the contract's
frozen vectors v7 (`zero-seed-launch-v2-vectors.json`, verbatim: 40 fee rows,
the curve tables, tick steps, saturation seconds and the five SHA-256 chains).

### 2026-10-22: MEVCapture v2.1 anchor/config history, gate events and per-swap surcharges (00139, additive)

**`00139_mev_capture_v21`. New tables, a view and two SQL functions. No
existing table, view, trigger or the v1 MEVCapture path changes. Nothing is
written until a worker sets `MEV_CAPTURE_V21_V3_ADDRESS`.**

Contract: `src/extensions/MEVCaptureV21.sol` on evm-contracts `main`, for the
current (V3) Core. Ethereum deployment:
`0x51f831c23fa4051862881Ef8EfC0c3C37905Ce49`.

- `mev_capture_v21_configs`: all eight `getConfig()` fields (`max_fee` is
  Q0.64 `numeric`; `segment_width_multiplier = 2^segment_exp`), one row per
  extension. Read once, at the block of the first v2.1 activity seen. It is
  never inferred from constructor defaults.
- `mev_capture_v21_pools`: pools initialized on the configured v2.1 extension.
  The version is chosen by extension address only. A worker refuses to start if
  the v2.1 address is also configured as v1.
- `mev_capture_v21_anchor_states`: all seven `getAnchor(poolId)` fields at the
  end of every block in which Core logged a swap, position update or
  initialization for the pool, or the extension logged `AnchorGateFailed`.
- `mev_capture_v21_gate_failures`: `AnchorGateFailed(bytes32 indexed poolId,
  uint8 lObs, uint8 eRef)` with chain, block, transaction, log index, emitter
  and pool. An event from another address, with another topic layout, with
  non-canonical data or for a pool that is not a v2.1 pool of the emitter
  fails the block. It is not dropped.
- `mev_capture_v21_swap_surcharges`: one row per forwarded v2.1 swap, written
  at the end of the block. The extension charges the surcharge through
  `Core.accumulateAsFees` right after each charged Core call, so each
  `FeesAccumulated` of a v2.1 pool is attributed to the forwarded swap of the
  `Swapped` log (locker = extension) preceding it in the same transaction. A
  forwarded swap is a maximal run of consecutive `Swapped` logs in a
  transaction with the same pool and the extension as locker. The row has the
  number of Core calls and of charged calls, the summed Core deltas, the
  surcharge per token and `delta0`/`delta1`, which equal the forward's
  returned balance update. A `FeesAccumulated` that cannot be attributed fails
  the block. Two forwarded swaps of the same pool with no other pool's swap
  between them in one transaction form one row.
- `mev_capture_v21_pool_states` (view): the quoter contract. One row per v2.1
  pool with config and latest indexed anchor. A pool missing either is absent,
  so consumers fail closed.
- `mev_capture_v21_pool_health(chain_id, as_of)`: monitor input, not a
  monitor. It returns anchor age, `stale_anchor` (> 2*tau), the decayed gate
  reference `e_ref_now`, `gate_margin_now` against the latest swap's liquidity,
  gate failures within the last 2*tau, and the last failure.

**Reads and errors.** Core's logs do not carry the extension's state, so the
worker uses `eth_call` pinned to the block hash (EIP-1898,
`requireCanonical`). The call runs in the same transaction that writes the
block's events. A failed or malformed read fails the block and the runtime
retries it, so there are no gaps. Every row cascades from `blocks`, so a reorg
removes orphaned reads and events and the canonical block reads again. Expect
one `getAnchor` per touched v2.1 pool per block, plus one `getConfig` per
extension.

**Known limit.** Two paths change anchor state with no log at all: a no-op
forwarded swap (zero amount, or limit equal to price) whose gate passes, and a
zero-delta position update that takes the per-timestamp liquidity snapshot.
The next logged touch catches up, but the intermediate state is not recorded.
Exact quotes must `eth_call getAnchor` at the quote block. The tables are
history and analytics input.

**Order.** Run the migration first (additive, no locks on worker-written
tables). Then set `MEV_CAPTURE_V21_V3_ADDRESS` on the V3 workers that should
index a deployed v2.1 extension. The address must be a real deployment, not a
placeholder. Pools of the extension whose initialization is already indexed
are registered once when the worker starts processing blocks, so the address
can be set after the first pool initialization.

**Rollback.** Unset `MEV_CAPTURE_V21_V3_ADDRESS` and restart. Then
`DROP FUNCTION mev_capture_v21_pool_health(int8, timestamptz); DROP FUNCTION
mev_capture_v21_bit_length(numeric); DROP VIEW mev_capture_v21_pool_states;
DROP TABLE mev_capture_v21_swap_surcharges, mev_capture_v21_gate_failures, mev_capture_v21_anchor_states,
mev_capture_v21_pools, mev_capture_v21_configs;` and, to allow a later
re-apply, `DELETE FROM migrations WHERE migration_id = 139;` (postgres-shift).
Only valid while 00139 is the latest migration.

**Indexes and representative queries.**

```sql
-- quoter / API: current state of every v2.1 pool on a chain
-- (latest anchor: PK (pool_key_id, block_number) backward scan, LIMIT 1)
SELECT * FROM mev_capture_v21_pool_states WHERE chain_id = $1;

-- anchor history of one pool (PK range scan)
SELECT * FROM mev_capture_v21_anchor_states
WHERE pool_key_id = $1 AND block_number BETWEEN $2 AND $3 ORDER BY block_number;

-- gate failures of one pool, newest first ((pool_key_id, event_id DESC))
SELECT * FROM mev_capture_v21_gate_failures
WHERE pool_key_id = $1 ORDER BY event_id DESC LIMIT 100;

-- surcharge per forwarded swap of one pool, newest first
-- ((pool_key_id, first_event_id DESC))
SELECT * FROM mev_capture_v21_swap_surcharges
WHERE pool_key_id = $1 ORDER BY first_event_id DESC LIMIT 100;

-- monitor input: stale anchors and pools at or past the gate edge
SELECT * FROM mev_capture_v21_pool_health($1, now())
WHERE stale_anchor OR gate_margin_now <= 0 OR gate_failures_2tau > 0;
```

The per-block touched-pool lookup uses the existing `(chain_id, block_number)`
indexes on `swaps`, `position_updates`, `pool_initializations` and the new
gate-failure table. The latest-liquidity lookup uses
`swaps (pool_key_id, event_id DESC)`. Each new table has a
`(chain_id, block_number)` index for the reorg cascade.

### 2026-10-14: Exact division for TWAMM hourly volume (00138)

**`00138_twamm_hourly_volume_exact_division`. Replaces the body of
`insert_twamm_hourly_volume` and adds `recompute_twamm_hourly_volume`. No table
locks, no column changes.**

00137 floored rounded numeric quotients, so an execution's hourly shares could
add up to a few base units more than its total and leave the last hour slightly
negative (3 of 1,671,457 rows after the backfill, by at most 13 base units).
The function now uses exact integer division.

**Manual step, after the migration is applied:** rewrite the rows 00137
already wrote, per chain, until `examined` is 0:

```sql
SELECT * FROM recompute_twamm_hourly_volume(<chain_id>, -9223372036854775808, 2000);
-- then repeat with the returned last_event_id in place of the second argument
```

Each batch deletes and rewrites its executions' rows in one transaction, so
hourly volume never drops while it runs. Rollback: restore the 00137 function
body; the rows differ from it by rounding only.

### 2026-10-14: TWAMM execution in hourly volume (00137)

**`00137_twamm_hourly_volume`. `hourly_volume_by_token.volume` now includes
what TWAMM orders sell, not only the net core swap the TWAMM extension makes
when it executes them. No column changes. History needs a manual backfill.**

Each `twamm_virtual_order_executions` insert computes what the pool's orders
sold since its previous execution (sale rate × seconds / 2^32 for each period
of constant sale rate, split by hour), subtracts the input of the extension's
own core swaps for that execution (same transaction and pool, locker = pool
extension), which the swaps trigger already counts, and stores the remainder
per hour and token in the new `twamm_hourly_volume_by_token`. That table's
triggers add it to `hourly_volume_by_token`. Its rows cascade from the
execution, so reorgs subtract exactly what was added. Fees are unchanged.

Readers (`api` volume endpoints, `last_24h_pool_stats_view`) sum `volume` and
need no change; TWAMM pools simply report higher volume.

Deploy: the migration creates two indexes on `twamm_order_updates` and a
trigger on `twamm_virtual_order_executions`, so it parks the workers on
`blocks` first (the 00120/00123 pattern). It does not touch existing rows.

**Manual step, after the migration is applied:** backfill executions indexed
before it, per chain, until `examined` is 0:

```sql
SELECT * FROM backfill_twamm_hourly_volume(<chain_id>, -9223372036854775808, 5000);
-- then repeat with the returned last_event_id in place of the second argument
```

It is idempotent: executions that already have rows are skipped, so it can be
rerun or overlap with the live trigger.

Rollback: `DROP TRIGGER twamm_hourly_volume ON twamm_virtual_order_executions;
DELETE FROM twamm_hourly_volume_by_token;` (its delete trigger takes the
contributions back out of `hourly_volume_by_token`), then drop the table, the
functions `insert_twamm_hourly_volume`, `backfill_twamm_hourly_volume`,
`twamm_hourly_volume_on_voe_insert` and `apply_twamm_hourly_volume`, and the
two `twamm_order_updates_pool_key_id_*` indexes. Everything removed is derived
from indexed events and can be recomputed by reapplying the migration and the
backfill.

### 2026-10-14: Stored-history recovery stops at persisted finality

**All networks. No schema change and no manual step to deploy. Cursor recovery that
finds a stored block at or below `indexer_cursor.finalized_order_key` no longer
canonical now refuses, and the worker exits instead of deleting. New optional
`MAX_REORG_DEPTH` (unset by default) refuses rollbacks deeper than that many blocks
below the persisted cursor.**

Previously recovery kept walking and deleted everything above the first block that
verified, back to the initial boundary when none did. Window rollbacks behave as
before. A refused worker stops advancing until the RPC endpoint is fixed; see
"Rollback limits" for the manual path when a real reorg passed persisted finality.
Readers see a stale chain head rather than lost history. Rollback: redeploy the
previous image; there is no data to revert.

### 2026-10-13: Bridge link provenance columns (00136, additive)

**`00136_erc20_bridge_link_provenance`. Adds nullable `relationship`,
`bridge_name`, `source_name`, `source_url` and `inferred_reverse` columns to
`erc20_tokens_bridge_relationships`. Metadata-only column additions plus a
check constraint validated over a table of a few thousand rows; no manual
steps.**

`relationship` is one of `canonical_bridge`, `native_issuer`,
`interoperability` or `unknown`. The columns stay NULL until the
`default-tokens` sync writes them from `tokens.json`; existing readers are
unaffected. Deploy before the `default-tokens` sync that writes them and the
api release that reads them.

Rollback: once no sync writes and no api release reads them,
`ALTER TABLE erc20_tokens_bridge_relationships DROP COLUMN relationship,
DROP COLUMN bridge_name, DROP COLUMN source_name, DROP COLUMN source_url,
DROP COLUMN inferred_reverse;`. The values are regenerated from `tokens.json`
by the next sync, so dropping them loses nothing that cannot be rewritten.

### 2026-10-13: Hourly token price history for 30 days (00134, additive)

**`00134_hourly_token_price_history`. Adds `erc20_tokens_usd_prices_hourly`
and `prune_erc20_tokens_usd_prices()`, and points the hourly
`prune_erc20_tokens_usd_prices` cron job at the function. No locks on
worker-written tables, no manual steps.**

`erc20_tokens_usd_prices` still keeps a day of raw observations. The prune now
folds what it deletes into the latest observation per token and UTC hour, in
the same statement, and keeps those hourly rows for 31 days (about 11M rows).
History accrues from the deploy, starting with the day still in the raw table.
Deploy before the api release that reads the hourly table.

Rollback: reschedule the job with its 00117 `DELETE` command, then
`DROP FUNCTION prune_erc20_tokens_usd_prices(timestamptz);
DROP TABLE erc20_tokens_usd_prices_hourly;` once no api release reads it.

### 2026-09-30: Production workers require their RPC URL in the environment

`src/runtime.ts` now fails when `NODE_ENV` is `production` (any case) and the
worker's `EVM_RPC_URL` or `STARKNET_RPC_URL` is missing or empty in the
process environment. The check runs before the `.env` files are loaded, so the
worker exits naming the variable before it takes the database lock or reads
chain data. Before this, a worker whose `.do/app.yaml` entry lost the key would
have indexed from the public URL in its `.env.evm.<network>` file. That
endpoint is rate-limited and can return short results without an error. For
`mainnet` and `bsc-mainnet` the file default is dRPC's free tier. The committed
defaults are unchanged and still apply to local runs. Scripts, migrations and
price sync do not go through this check.

### 2026-09-29: MEVCapture pool series (00132, additive)

**`00132_mev_capture_series`. Adds two SQL functions and nothing else: no
tables, no indexes, no locks on worker-written tables, no manual steps.**

- `mev_capture_block_series(chain_id, from_epoch, to_epoch)`: one row per
  MEVCapture pool per block with a swap. Includes volume in and out per token,
  base fee on input, surcharge, `tick_last`, liquidity before and after, and
  the first-touch swap (transaction hash, index and event index).
- `mev_capture_daily_metrics(chain_id, from_epoch, to_epoch)`: the same series
  per pool per UTC day, in the shape of the continuous auction dashboards.

Core's swap event carries the swap before MEVCapture adds its surcharge. The
surcharge is the `fees_accumulated` donation made at the pool's next touch,
attributed to the pool's last earlier swapping block. It is NULL (pending)
until that touch is indexed. The migration header has the full derivation and
its limits: active liquidity comes from swaps only, because `position_updates`
has no state-after column.

For windows the database cannot serve, `scripts/extractMevCaptureSeries.ts`
builds the same series from chain logs. It checks every log chunk against a
second RPC and reconciles each block's donation against a tick-based
reconstruction.

Rollback: `DROP FUNCTION mev_capture_daily_metrics(int8, int8, int8);
DROP FUNCTION mev_capture_block_series(int8, int8, int8);`

### 2026-09-29: Integer scale for legacy `pool_config` values (00131)

**`00131_pool_config_integer_scale`. Data-only. No manual steps.**

00060/00065 built `pool_config` with `POWER(2::NUMERIC, n)`, so 234 rows (v2
core `0xe0e0…d444` on Ethereum and Sepolia) were stored with a fractional scale,
e.g. `…842.0000000`. The values were already integers. The migration
`trunc()`s them so every `pool_config` has scale 0. Readers that parsed the
text as an integer failed on those rows. That caused the HTTP 500 on
`/poolKeys/1/0xe0e0…d444`.

### 2026-09-28: Market depth includes the fee band (00130)

**`00130_market_depth_include_fee_band`. Redefines `pool_market_depth_view`.
Same columns, different values. No manual steps.**

Each depth band used to start one fee width away from the price on each side,
so the liquidity closest to the price was never counted. Bands now cover
`[tick - depth, tick + depth]`, and a pool gets a row for every band that holds
liquidity, including bands narrower than its fee. `depth0`/`depth1` therefore
rise for pools whose liquidity sits within about a fee width of the price.
Ethereum USDC/USDG's ±0.106% band goes from ~$329k to ~$842k, which is its TVL.
Consumers read the same columns: the api's pair, pool and boosted-fee APRs and
the `incentives` campaign view (00088). The APRs fall to match. Reward
distribution does not read this view.

`pool_market_depth_materialized` is left to the existing 10-minute cron job
rather than refreshed in the migration, so new values appear within 10 minutes
of the deploy, plus the api's 600 s cache.

### 2026-09-24: Starknet extension routing metadata (00129, additive)

Deploy the indexer before the quoter release that reads this metadata. Migration
00129 records `ExtensionCallPointsSet` history and exposes the last canonical
event per `(chain_id, Core, extension)`, including re-registration and reorgs.
It does **not** change `all_pool_states_view`, `pool_last_event_id`, their indexes,
or the per-swap trigger path. Existing quoter versions remain compatible.

After the new Starknet worker is live and its cursor has advanced past
deployment, run `NETWORK=mainnet bun scripts/backfillStarknetExtensionCallPoints.ts`
with the production `PG_CONNECTION_STRING` and `STARKNET_RPC_URL` (v0.10 event
positions). It fetches historical events through a hash-pinned indexed anchor,
checks latest flags against Core at that anchor, then atomically inserts history
and publishes the eligible-extension set. The short write transaction locks
`blocks` first, following migration lock ordering. It never resets the cursor or
replays pool events; reruns are idempotent. A changed anchor aborts the write;
later reorgs remove imported events through the normal block cascade. Including
the unfinalized tail closes the deployment gap without waiting for L1 finality.
Missing backfill metadata fails closed.

The eligible set is recomputed only on registration insertion/deletion, not on
pool writes or quote polls. The new quoter reads it with one PK lookup alongside
its existing head read, passes it as a constant array to its pool query, and
replaces the routing graph if it changes. This handles both admitting and evicting
idle pools. Roll the quoter back first if rolling back event ingestion; otherwise
its allow-set could become stale. Keep the additive schema on rollback.

### 2026-09-09: Require a single consistent RPC endpoint

EVM and Starknet workers now require one HTTP(S) URL in `EVM_RPC_URL` or
`STARKNET_RPC_URL`. Before deploying, replace any comma-separated EVM endpoint
list with one provider satisfying the RPC endpoint consistency contract above.
Uncoordinated proxy pools are unsupported. EVM no longer fetches intermediate
headers when event logs already supply timestamps. No database migration is
required; existing cursors are preserved.

This log records indexer deployments that:

- require **manual intervention beyond running `scripts/migrate.ts`** (e.g., backfilling data, reseeding state, or pausing workers), or
- introduce **schema changes**, even when the standard migration workflow can apply them automatically. Schema-only updates may not mandate manual steps but can still break downstream consumers that rely on the previous structure, so they belong here as well.

### 2026-09-08: Starknet moves off apibara DNA onto its own RPC

**No schema change. Requires configuration before deploying.**

Starknet is now indexed by the same stream as every EVM chain
(`src/_shared/blockStream.ts`) instead of the apibara DNA gRPC stream. Two
manual steps:

1. **`starknet-mainnet` must be enabled on the Alchemy app** whose key
   `ALCHEMY_API_KEY` holds. It was an EVM-only app, so the worker will
   fail to read the chain until it is. (Already done.)
2. **`STARKNET_RPC_URL`** is a new secret in the app spec.

Apibara is gone entirely: the four `@apibara/*` packages, `APIBARA_URL`,
`DNA_TOKEN`, and the `APIBARA_DNA_TOKEN`, `STARKNET_MAINNET_APIBARA_URL` and
`ETH_MAINNET_APIBARA_URL` secrets the deploy workflow passed to `envsubst`. The
repository secrets themselves can be deleted in GitHub once this has shipped;
nothing reads them.

Downstream is unaffected, checked rather than assumed. `api` and
`quoter-service` are the only things that read this database directly (`mcp`,
`interface` and `wallet` go through the api), and both read the same five
`indexer_cursor` columns plus `event_id`. Against a live cursor row written by
the DNA stream, the new adapter returns an identical `head_block_hash`,
`head_block_time` and `head_base_fee_per_gas`; `event_id` is unchanged, which is
what quoter-service's incremental sync keys on (`last_event_id > $n`); and
`fork_counter`, which it compares to decide a full refetch, only moves on an
invalidate, of which a live boot from the real cursor produced none.

The one behavioural difference is latency: DNA pushed a block as it was
produced, and this polls, so Starknet events land up to `POLL_INTERVAL_MS`
(2 s) later than they used to.

`event_id` is unchanged: `transaction_index` and `event_index` come from
`starknet_getEvents` under JSON-RPC v0.10 and match what DNA wrote, verified
over 5,000 mainnet blocks against 44 event tables with no row missed. The URL
must name v0.10 or later; the stream refuses to index without those fields
rather than defaulting them.

Adds ~1.9M Alchemy compute units a day (~$26/month at a 2 s poll floor), where
DNA was billed separately.

### 2026-09-06: Market depth refresh, 25 s → 10 s, and a 10-minute schedule

**`00126_faster_pool_market_depth`. Redefines `pool_market_depth_view` and
reschedules its cron job. Same columns, same values, no consumer changes.**

`refresh_pool_market_depth` was the most expensive job left on the instance:
25.1 s average over 24 hours (35.5 s over 7 days, max 169.7 s), every 15
minutes. Two independent causes, neither of them a missing index — the index
this needed already existed from 00118.

- **The median-tick step read the whole `swaps` table.** Its `LATERAL`
  subquery had no `LIMIT`/`OFFSET`, so the planner pulled it up into a plain
  join, lost the per-pool correlation, and estimated ~513k rows per pool for a
  one-hour window. Against that estimate a hash join over a sequential scan of
  all 46M swaps beats 5,000 index probes, and that is what it picked: ~20 s and
  ~11 GB read from disk per refresh, 96 times a day, roughly a terabyte.
  Forcing the index with `enable_seqscan = off` does not help either: measured,
  it ran past 170 s and the statement timeout cut it off before the plan could
  be captured. The estimate is what is wrong, so `OFFSET 0` is the fix — the
  standard optimisation fence, no semantic change. That step now runs in 0.29 s
  entirely from cache.

- **The tick math was quadratic in disguise.** Every `(pool, depth)` pair
  intersected the depth band against every one of the pool's tick segments (the
  largest pool has 1,763), so a pool cost `ticks × 41` range intersections. It
  is now one ordered pass per pool: prefix sums of each segment's token
  amounts, and a band's amount is the difference of the cumulative value at its
  two edges. The largest pool goes from 1,689 ms to 93 ms.

The rewrite is **exact, not approximate**. `NUMERIC` `+ - *` are
arbitrary-precision and lossless; the only rounding is inside `POWER()` and the
`1/p` divisions, and both definitions evaluate those at the same tick values,
so the reassociated sums agree digit for digit. Verified two ways: on
production, both definitions in a single snapshot returned the same 69,150 rows
with zero differing values (24.5 s → 10.0 s); and in
`tests/migrations/faster-pool-market-depth.test.ts`, which snapshots the old
view's output, applies the migration, and asserts strict equality over a
fixture covering bands inside the tick range, bands running off both ends, a
pool whose liquidity returns to zero mid-range, a pool priced from
`pool_states` because it never swapped, a pool with no ticks, and a pool whose
fee is wider than the tightest bands.

Watch for one trap if this is ever touched again: deriving the band edge prices
as `p(last) × p(offset)` via exponent laws is one extra rounding step and
drifts ~1e-12 relative. Each edge price is computed directly from its own tick.

**Schedule.** The `REFRESH … CONCURRENTLY` diff costs ~0.19 s on top of
computing the view, so a run goes 25.1 s → ~10.5 s. The job moves from every 15
minutes to every **10**: 1,512 s/day against today's 2,410, a 37% cut, while
the worst-case lag between a liquidity change and the pools table drops from 25
minutes to 20 (the API's own 600 s cache is the other half of that). Every 5
minutes was considered and not taken — it would cost ~3,000 s/day, _more_ than
today, for a further 5 minutes. It is a one-token change in the migration's
`DO` block if that trade is wanted later.

Deploy: `CREATE OR REPLACE VIEW` takes `ACCESS EXCLUSIVE` on the view alone and
only `ACCESS SHARE` on the tables it reads, so unlike 00120 and 00123 it holds
nothing the workers can wait on and needs no `LOCK TABLE blocks`. The one lock
it can wait behind is a cron refresh already reading the view, hence the
15-minute `lock_timeout`. The migration does not refresh the matview; the next
cron run picks up the new definition.

### 2026-09-06: Price-source bloat and stale statistics

**`00125_price_source_bloat_and_stale_stats`. Reloptions and `ANALYZE` only —
no lock that conflicts with the workers — plus one manual operator step.**

Two findings from the I/O sweep that followed 00124:

- `erc20_tokens_latest_price_by_source` is the largest live source of disk
  reads on the instance (~1 GB per five minutes): 17,223 live rows in 978 MB
  (594 MB heap + 384 MB index), ~6 MB of live data. Autovacuum is not behind
  on it — it fires on essentially every naptime. The heap is the residue of the
  2026-09-01 incident described under 00119: a worker blocked 22 hours inside
  `pg_advisory_lock` pinned the vacuum horizon, and at ~90 updates/s that left
  ~7M dead tuples vacuum could not remove until the session ended. Vacuum
  reclaims that space in place; only a rewrite shrinks the heap.

  The migration sets `fillfactor=70` (HOT headroom after the repack; the
  table's only index is its primary key) and
  `autovacuum_vacuum_scale_factor=0.01` (matching 00119's setting on the
  sibling table `erc20_tokens_latest_price`, which got `fillfactor=80`). Neither
  prevents a repeat of the incident — that needs `lock_timeout` /
  `statement_timeout` on the indexer role and an alert on `age(backend_xmin)`,
  a separate change.

  **Manual step, after the migration is applied:** rewrite the table once.
  Preferred, because it rewrites without an exclusive lock:

  ```sh
  pg_repack -d defaultdb -t erc20_tokens_latest_price_by_source
  ```

  (`pg_repack` 1.5.2 is available on the managed instance; it needs `CREATE
  EXTENSION pg_repack` in `defaultdb` and a matching local client.) The
  fallback is `VACUUM (FULL, ANALYZE) erc20_tokens_latest_price_by_source`,
  which takes seconds at 17k live rows but holds `ACCESS EXCLUSIVE`: it blocks
  the price sync's **reads** as well as its writes, and nothing in
  `src/price-sync` retries a failed cycle, so prices go stale for the duration.
  If using it, set `lock_timeout = '10s'` first and run outside :00–:02, when
  the hourly `prune_erc20_tokens_usd_prices` DELETE is holding the table's
  trigger path. Expect ~978 MB → a few MB and the table's `heap_blks_read` in
  `pg_statio_user_tables` to go flat.

- Planner statistics on four large event tables were months stale (statistics
  reset at the 08-25 restart; the default 10% analyze threshold would not
  re-fire for months): `nonfungible_token_transfers` reported 13,645 live rows
  against 3.1M real, `nonfungible_token_owners` 10,751 against 2.35M,
  `protocol_fees_paid` 426 against 1.86M, `position_fees_collected` 2,251
  against 1.81M. This is what had the positions-history query (`WITH transfers
  …`, 28k calls at 909 ms — the slowest API statement remaining) estimating one
  row for a whole chain and scanning millions of transfers per request. The
  migration runs `ANALYZE` on those four and sets
  `autovacuum_analyze_scale_factor=0.01` on them so it stays current.

  `ANALYZE` alone repairs the plan: with current statistics the existing
  `(chain_id, emitter, token_id, …)` index serves `chain_id + token_id` by skip
  scan. An extra `(chain_id, token_id)` index was tried in review and dropped —
  it saved ~14 buffers a call against the skip scan and nothing at all under
  stale statistics, the actual failure mode. The hourly tables are deliberately
  not on the list; they autoanalyze every few days at the default threshold.

Deploy: `ANALYZE` and reloption changes take `SHARE UPDATE EXCLUSIVE`, which
does not conflict with the workers' writes, so this migration holds nothing a
worker can wait on and needs no `LOCK TABLE blocks`. It runs in seconds.

### 2026-09-05: Index `generated_drop_proof` for the claims endpoint

**`00124_index_generated_drop_proof_address`. Schema change; no consumer
changes.**

`incentives.generated_drop_proof` (3.1M rows, 2.6 GB, proofs inline) had only
its primary key `(drop_id, id)`, while `GET /claims/:address` filters it by
`address`. Every claims request was a sequential scan of the whole table:
17,378 calls at 1,180 ms and 269k disk blocks each since 2026-08-25 — 35 TB of
physical reads from a 2.6 GB table at a 20% cache-hit ratio, the largest
source of I/O on the instance and the reason other hot tables were being
evicted from the buffer cache. Adds `generated_drop_proof_address_idx
(address)` and `generated_drop_proof_drop_id_amount_idx (drop_id, amount)` (the
per-drop totals aggregate becomes an index-only scan), and runs `ANALYZE` on
the table, whose column statistics had never been collected.

Deploy: `CREATE INDEX` takes `SHARE` on a table only the out-of-band drop
generator writes, so it does not interact with the indexer workers and does
not use the `LOCK TABLE blocks` pattern. Expect tens of seconds for the build.
After: the `WITH funded_roots …` statement in `pg_stat_statements` should drop
from ~1.2 s to milliseconds, and `pg_statio_user_tables` should show the
table's `heap_blks_read` flat.

### 2026-09-05: Indexable `last_event_id` for the pool-state poll

**`00123_pool_last_event_id`. Schema change; no consumer changes.**

quoter-service polls `all_pool_states_view` every 5 s per chain with
`last_event_id > $3`. That column was `GREATEST()` over five state tables, so
the predicate could only be a post-join filter and every poll walked every pool
on the chain through the view's ~10 side-table joins — 96.8 ms and ~112k
buffers per call, the largest single CPU consumer on the instance (5.9% of the
box on its own in a 10-minute sample).

New table `pool_last_event_id (pool_key_id, chain_id, core_address,
last_event_id)` stores that value. Each of `pool_states`, `twamm_pool_states`,
`boosted_fees_pool_states`, `limit_order_pool_states` and `ve33_pool_states`
gets **two** triggers: `<table>_maintain_pool_last_event_id` (`AFTER INSERT OR
DELETE`) and `<table>_maintain_pool_last_event_id_upd` (`AFTER UPDATE OF
last_event_id`, guarded by `WHEN (OLD.last_event_id IS DISTINCT FROM
NEW.last_event_id)`). An upward move — every swap and position update — is a
single primary-key update; inserts, deletes and downward moves recompute the
value exactly from the five sources. It tracks those sources; whether they go
down on a reorg is their own recompute functions' behaviour, unchanged from
the live `GREATEST`, and the quoter relies on `fork_counter` for reorgs.

The view's `last_event_id` column now reads from the table through an inner
join placed inside the first eight relations of the join list (the planner's
`join_collapse_limit`; further down, the index could never drive the plan).
Column list, order and types are unchanged — `CREATE OR REPLACE VIEW` — so
neither quoter-service nor the API needs a change.

**Operator notes.** Repair one pool with `SELECT
recompute_pool_last_event_id(<pool_key_id>)`; resync everything with `SELECT
recompute_pool_last_event_id(pool_key_id) FROM pool_states` — required after
any bulk rewrite done with triggers disabled, since a missing row silently
drops the pool from the view and a stale-low value stops the quoter refetching
it. Post-deploy parity check: `SELECT (SELECT count(*) FROM pool_states),
(SELECT count(*) FROM pool_last_event_id), (SELECT count(*) FROM
all_pool_states_view)` — all three must match. Then watch the `apsv` poll in
`pg_stat_statements`: mean should fall from ~97 ms to low single digits.

Deploy: `CREATE TRIGGER` takes `SHARE ROW EXCLUSIVE` on five tables the
workers write mid-transaction; the migration locks `blocks` first (the #173
pattern) so it cannot deadlock. The swap is a single short transaction.

### 2026-09-04: Stop writing empty blocks; chain head moves to `indexer_cursor`

**`00122_indexer_cursor_head_block`. Coordinated deploy across three repos —
read this before rolling out.**

The indexer no longer writes a `blocks` row for a block with no events, and the
migration deletes the 202,040 empty rows already stored. 85% of blocks written
were empty (8 of the 13 chains are 100% empty), and each one was inserted, kept
a day, then deleted by `delete_old_empty_blocks()` — paying all 43 of the
`ON DELETE CASCADE` lookups hanging off `blocks` despite never having had a
child row. That was ~99M of the 184.5M cascade executions in a 10-day window.
`delete_old_empty_blocks()`, its cron job, and `blocks_num_events_block_time_idx`
are all dropped.

`indexer_cursor` gains four nullable columns — `head_block_number` (bigint),
`head_block_hash` (numeric), `head_block_time` (timestamptz),
`head_base_fee_per_gas` (numeric) — seeded from the current tip. The indexer
maintains them in `writeCursor`, which already upserts that row once per block,
so the head costs no extra write. New accessor `public.get_chain_head_time()`;
`incentives.compute_pending_reward_periods` and `public.get_oracle_twap_tick`
now use it instead of `ORDER BY block_number DESC` / `MAX(block_time)` over
`blocks`.

**Deploy order is load-bearing and there is no compatibility bridge.** Nothing
keeps the head columns current except the indexer build shipping with this
migration, and nothing keeps a `blocks`-based tip query correct once that build
stops writing empty blocks. The indexer, the API and quoter-service must go out
together. A reader left on `SELECT … FROM blocks ORDER BY block_number DESC
LIMIT 1` does **not** error — it silently returns the last block that happened
to carry an event, which on an all-empty chain is arbitrarily stale.

Consumers updated alongside:

| repo                           | what changed                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `EkuboProtocol/api`            | `getLatestBlock` reads `indexer_cursor`; the timestamp and block-number lookups stay on `blocks` |
| `EkuboProtocol/quoter-service` | `LATEST_BLOCK_QUERY` reads `indexer_cursor`                                                      |

`base_fee_per_gas` has no consumer inside the database — no view, matview or
function references it — so quoter-service's tip query was its only reader.

Lookups that genuinely want history keep reading `blocks`:
`incentives.compute_rewards_for_period_v1` and the API's by-timestamp and
by-number queries. They already tolerated empty blocks being absent, since the
sweep had been removing day-old ones for as long as it existed; this makes that
behaviour uniform rather than time-dependent.

The migration's `DELETE FROM blocks WHERE num_events = 0` runs after `00121`,
which is what makes it affordable — the cascade lookups it fires are index
scans rather than sequential scans of two ~100 MB tables.

### 2026-09-04: Incremental rewards by position; index the block cascade

Two schema changes, both aimed at the hourly cron spike on `ekubo-db-nyc1`.
Measured from `cron.job_run_details` and `pg_stat_statements` on 2026-09-04.

**`00120_incremental_rewards_by_position`. Schema change with a downstream
contract.** `incentives.computed_rewards_by_position_materialized` is no longer
a materialized view. It is now a plain **view** over a new table,
`incentives.computed_rewards_by_position`, which is maintained incrementally by
triggers. The view exposes exactly the columns the matview did, so readers
(including the API's position-rewards endpoint) need no change — but anything
issuing `REFRESH MATERIALIZED VIEW` against that name will now fail, and the
cron job `refresh_computed_rewards_by_position` is **unscheduled**.

`REFRESH ... CONCURRENTLY` has no change detection, so it re-aggregated all
40M rows of `computed_rewards` every hour — 3,488 s/day — to absorb the ~205
rows that actually land per day. Both aggregates are `SUM`, so they are now
maintained forward instead: ~205 single-row upserts a day, and the numbers are
exact at every instant rather than up to an hour stale.

New objects: table `computed_rewards_by_position` (adds `source_row_count`,
not exposed through the view); `rewards_by_position_apply()`; triggers on
`computed_rewards` (insert/update/delete), `generated_drop_reward_periods`
(insert/delete) and `campaigns` (update of `core_address`);
`rebuild_rewards_by_position()`; and `verify_rewards_by_position()`.

**Operator notes.** The migration seeds the table with one full aggregate,
which is the same ~145 s the hourly job used to take, inside the migration
transaction — expect the deploy to sit there for that long.

Because the totals are now maintained rather than recomputed, drift is possible
in a way it was not before. `SELECT * FROM incentives.verify_rewards_by_position()`
returns the disagreeing groups and empty means correct; it costs about what the
old refresh did, so run it out of band (daily or weekly), not on a read path.
`SELECT incentives.rebuild_rewards_by_position()` repairs it from the base
tables. A rebuild is **required** after anything the triggers deliberately do
not cover — in particular moving a `campaign_reward_period` to a different
campaign, which would re-key rows. Nothing does that today.

Bulk maintenance caution: the `computed_rewards` trigger is row-level, which is
right for ~205 rows/day but wrong for a mass recompute. Recomputing every
period would fire 40M triggers; disable the trigger and call
`rebuild_rewards_by_position()` instead.

**`00121_index_block_cascade_children`.** Adds 13 `(chain_id, block_number)`
indexes on the children of `blocks` that had none, three of which carry real
data today: `ve33_pool_fees_accounted`, `ve33_pool_emissions_accrued` and
`ve33_rewards_claimed`.

`blocks` has 43 `ON DELETE CASCADE` children, so each deleted block runs 43
cascade lookups; the unindexed ones sequentially scanned 100 MB+ tables.
`delete_old_empty_blocks()` grew from 12.9 s to 250 s per hourly run between
2026-07-31 and 2026-09-04 as the new chain indexers raised the block-deletion
rate and the ve33 tables grew. Those three tables accounted for 54,754 s of the
56,140 s of cascade CPU in a 10-day window.

**Manual consideration:** the indexes are built with plain `CREATE INDEX`, not
`CONCURRENTLY`, because `scripts/migrate.ts` runs the migration set inside a
single transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. Building
takes a `SHARE` lock that blocks writes to those tables — a few seconds each at
current sizes (109 MB and 105 MB), but it will stall the ve33 indexer workers
for the duration.

Either apply during a quiet period, or build the three large ones by hand
first, which avoids the write stall entirely:

```sql
CREATE INDEX CONCURRENTLY ve33_pool_fees_accounted_chain_id_block_number_idx
    ON ve33_pool_fees_accounted (chain_id, block_number);
CREATE INDEX CONCURRENTLY ve33_pool_emissions_accrued_chain_id_block_number_idx
    ON ve33_pool_emissions_accrued (chain_id, block_number);
CREATE INDEX CONCURRENTLY ve33_rewards_claimed_chain_id_block_number_idx
    ON ve33_rewards_claimed (chain_id, block_number);
```

The migration's statements are `IF NOT EXISTS` and use exactly these names, so
a hand-built index is adopted rather than rebuilt. Keep the names identical, and
check for an `INVALID` index (`\d+` on the table) if a concurrent build is
interrupted — that one must be dropped and rebuilt, since `IF NOT EXISTS` will
otherwise skip past a broken index.

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
`https://<network>.g.alchemy.com/v2/${ALCHEMY_API_KEY}` in `.do/app.yaml`,
falling back to the chain's public endpoint where one exists; the committed
`.env.evm.*` files keep key-free public URLs for local runs.

`.do/app.yaml`'s `&indexer-image` anchor moved from `starknet-sepolia` to
`starknet-mainnet`, since the service that defined it is gone.

**Price sync now covers every EVM mainnet.** Previously only Ethereum, Base,
Monad, Robinhood, Arbitrum and Starknet had any price source, so the nine
mainnets this release adds would have indexed pools with no USD prices at all.
Each of the 13 EVM mainnets now has at least three:

| chain                | CoinGecko native        | CoinGecko tokens    | Sushi | Ekubo quoter |
| -------------------- | ----------------------- | ------------------- | ----- | ------------ |
| Ethereum (1)         | ethereum                | —                   | yes   | USDC         |
| Optimism (10)        | ethereum                | optimistic-ethereum | yes   | USDC         |
| BNB Smart Chain (56) | binancecoin             | binance-smart-chain | yes   | USDC (18dp)  |
| Gnosis (100)         | xdai                    | xdai                | yes   | USDC.e       |
| Unichain (130)       | ethereum                | unichain            | no    | USDC         |
| Polygon (137)        | polygon-ecosystem-token | polygon-pos         | yes   | USDC         |
| Monad (143)          | monad                   | monad               | yes   | USDC         |
| World Chain (480)    | ethereum                | world-chain         | no    | USDC         |
| MegaETH (4326)       | ethereum                | megaeth             | yes   | —            |
| Robinhood (4663)     | ethereum                | robinhood           | yes   | USDC         |
| Base (8453)          | ethereum                | base                | yes   | USDC         |
| Arbitrum (42161)     | ethereum                | arbitrum-one        | yes   | —            |
| Ink (57073)          | ethereum                | ink                 | no    | USDC         |

CoinGecko asset-platform slugs and native coin IDs are taken from CoinGecko's
own `/asset_platforms` response rather than assumed. Sushi is wired only where
`api.sushi.com/price/v1/<chainId>` actually answers: Unichain, World Chain and
Ink return 404 and are left off. MegaETH has no listed USD stablecoin to quote
against, so it gets no quoter job.

Quoter jobs query only tokens that already have a pool with non-zero TVL, so on
a chain with no pools yet they issue no requests and cost nothing; they begin
reporting on their own once liquidity arrives. They resolve through
`prod-api-quoter.ekubo.org/<chainId>`, which is served by the matching quoter
services in EkuboProtocol/quoter-service#41 — that PR should land first or
these jobs will log failed lookups once pools exist.

Note BNB Smart Chain's bridged USDC is **18 decimals**, not the usual 6. Every
proxy token's `symbol()`, `decimals()` and `totalSupply()` were read on-chain.
Gnosis uses USDC.e (`0x2a22…76F0`) rather than the older USDC
(`0xDDAf…7A83`) because it carries about 11x the DEX liquidity.

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

|                                    | buffers                        | time     |
| ---------------------------------- | ------------------------------ | -------- |
| index scan (today)                 | 50                             | 0.14 ms  |
| seq scan on bloated heap           | 46,147 (45,155 read from disk) | 103.6 ms |
| seq scan after repack (~250 pages) | ~250                           | sub-ms   |

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
