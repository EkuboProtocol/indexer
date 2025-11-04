# `@ekubo/indexer`

Service for indexing Ekubo events into a Postgres database.

## Overview

The indexer focuses on producing an always-consistent realtime view of Ekubo events, using the Apibara service to get a stream of relevant data.

Events are not transformed by the indexer, simply cataloged for later use such as in materialized views or complex analytical queries.

## Syncing a new node

It can take weeks to sync a new mainnet node, so it's recommended to start from a backup of our production database.

Join the [Discord](https://discord.ekubo.org) and ask in the `#devs` channel to get the latest export of the data.

## Systemd service files

Generate unit files for running the four supported networks as always-on services:

```bash
npm run generate-systemd
```

By default the files are written to `./systemd`. Pass `--output-dir`, `--working-dir`, `--runner` (for example, `pnpm run`), or `--force` to override defaults:

```bash
npm run generate-systemd -- --output-dir /etc/systemd/system --working-dir /opt/ekubo/indexer --runner "pnpm run" --force
```

After generating, copy the files into place and enable them with `systemctl enable --now <service name>`.
