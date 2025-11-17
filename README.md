# `@ekubo/indexer`

Service for indexing Ekubo events into a Postgres database.

## Overview

The indexer focuses on producing an always-consistent realtime view of Ekubo events, using the Apibara service to get a stream of relevant data.

Events are not transformed by the indexer, simply cataloged for later use such as in materialized views or complex analytical queries.

## Syncing a new node

It can take weeks to sync a new mainnet node, so it's recommended to start from a backup of our production database.

Join the [Discord](https://discord.ekubo.org) and ask in the `#devs` channel to get the latest export of the data.

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

Override the command to reuse the same image for auxiliary scripts (migrations, token sync, etc.); the default entrypoint is already `bun`:

```bash
docker run --rm \
  --env-file .env \
  ekubo-indexer \
  scripts/migrate.ts
```
