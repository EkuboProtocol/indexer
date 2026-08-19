# Vendored Apibara SDK packages

These directories are unmodified TypeScript sources copied out of the Apibara
TypeScript SDK so the Starknet indexer can stream from a plain JSON-RPC
provider instead of a DNA gRPC endpoint, the same way the EVM indexer already
does.

- Source: <https://github.com/software-mansion-labs/apibara-typescript-sdk>
- Branch: `maciektr/live-reorg-fix`
- Commit: `fc2c48e4d8e13533fb0a63ea8d1c8184452a20ec`

| Directory                | Upstream package               | Upstream path              |
| ------------------------ | ------------------------------ | -------------------------- |
| `apibara-protocol/`      | `@apibara/protocol` (2.1.3)    | `packages/protocol`        |
| `apibara-starknet-rpc/`  | `@apibara/starknet-rpc` (2.1.4)| `packages/starknet-rpc`    |

## Why vendored

`@apibara/starknet-rpc` is not published to npm yet, and it depends on RPC
stream changes to `@apibara/protocol` (multi-filter finality,
`fetchBlockRangeMany`, `initializeRequest`, and the live-reorg fix in
`fc2c48e`) that are not in the published `@apibara/protocol@2.1.3` either.
npm and Bun cannot install a single package out of a monorepo subdirectory, so
the sources live here and are wired up with `file:` dependencies.

The vendored `@apibara/protocol` is also forced onto `@apibara/evm-rpc` through
`overrides` in the root `package.json`. That is deliberate: `@apibara/evm-rpc`
pins `@apibara/protocol@2.1.3`, and a second, nested copy of the published
2.1.3 would break the EVM indexer at runtime, because the branch's
`RpcDataStream` calls `initializeRequest()` / `fetchBlockRangeMany()` on the
stream config and those only exist on the branch's `RpcStreamConfig` base
class. With one shared copy, `EvmRpcStream` inherits the new base-class
defaults and keeps working.

## Local changes

Only the package manifests are hand-written: upstream ships `workspace:*`
dependencies and `dist` entry points produced by `unbuild`, neither of which
work outside the SDK monorepo. The manifests here point at `src/**/*.ts`
(Bun runs TypeScript directly, exactly like `src/` in this repo) and pin
`@apibara/starknet` to the published `2.1.4`, which is byte-identical to the
branch's `packages/starknet/src`.

`src/**` is copied verbatim. Upstream tests are intentionally not vendored:
they run under Vitest and would be picked up by `bun test`.

## Updating

Re-copy `packages/protocol/src` and `packages/starknet-rpc/src` from the
upstream commit you want, leave the manifests alone, and update the commit
recorded above.
