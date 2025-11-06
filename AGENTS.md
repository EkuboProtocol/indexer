# Repository Guidelines

## Project Structure & Module Organization
TypeScript entrypoint `src/index.ts` orchestrates EVM and Starknet processors from `src/evm` and `src/starknet`, with shared utilities in `src/_shared`. Configuration bootstraps in `src/config.ts`, which layers `.env` files per network. SQL migrations under `migrations/` execute sequentially through `scripts/migrate.ts`. Tests reside in `tests/migrations/*.test.ts` and reuse the harness in `tests/helpers`. Operational scripts, including systemd generators, sit in `scripts/`.

## Build, Test, and Development Commands
- `npm run eth:mainnet` / `npm run eth:sepolia`: run the EVM indexer for the selected network; ensure database and RPC env vars are present.
- `npm run starknet:mainnet` / `npm run starknet:sepolia`: start the Starknet indexer with the same environment requirements.
- `npm run migrate`: invoke `scripts/migrate.ts` to apply `migrations/` against the configured Postgres instance.
- `npm test`: run the Vitest suite (backed by in-memory PGlite) to validate migrations and helpers.
- `npm run check-ts`: type-check the project without emitting artifacts.

## Coding Style & Naming Conventions
Use TypeScript with ESM syntax and two-space indentation. Prefer named exports and colocate modules with their network-specific logic. Functions and variables follow `camelCase`; types and interfaces use `PascalCase`. Surface shared helpers through `src/_shared`, and expose configuration via typed accessors in `env.d.ts` rather than direct `process.env` reads inside feature code. Keep logger usage structured and consistent.

## Testing Guidelines
Vitest drives the suite; add new cases under `tests/migrations` (or peers) using the `*.test.ts` suffix. Stand up temporary databases through `tests/helpers/db.ts`, seed the minimal fixtures, and assert deterministic SQL results. Run `npm test` before opening a PR, and include regression coverage when extending migrations or processors.

## Commit & Pull Request Guidelines
Commits follow short, action-oriented summaries (see `git log`, e.g. `increase number of depths to compute`), optionally referencing PR numbers inline (`cross chain indexer (#30)`). Rebase or squash to keep history linear. Pull requests should describe intent, note schema or protocol impacts, link tracking issues, and document how to validate the change. Confirm tests and migrations were run in the PR body or checklist.

## Environment & Deployment Tips
`src/config.ts` loads cascading `.env` files: `.env`, `.env.<networkType>`, `.env.<networkType>.<network>`, plus optional `.local` overrides. Keep secrets in untracked `.local` files. For long-lived workers, generate systemd units with `npm run generate-systemd -- --output-dir <dir>` and ensure the service `WorkingDirectory` matches the repository layout.
