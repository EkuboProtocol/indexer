# `@apibara/starknet-rpc`

Stream Starknet data from a standard JSON-RPC endpoint using Apibara's DNA
stream interface.

## Install

```sh
pnpm add @apibara/protocol @apibara/starknet-rpc
```

## Usage

Create a `StarknetRpcStream`, then pass it to `RpcClient`:

```ts
import { RpcClient } from "@apibara/protocol/rpc";
import {
  type Filter,
  type StarknetRpcBlock,
  StarknetRpcStream,
} from "@apibara/starknet-rpc";

const stream = new StarknetRpcStream({
  url: "https://your-starknet-rpc.example",
  wsUrl: "wss://your-starknet-rpc.example",
  requestsPerSecond: 20,
  maxConcurrency: 8,
  retryCount: 3,
  cacheSize: 256,
  blockRangeSize: 20,
  eventPageSize: 1_000,
  eventRangeSize: 10_000n,
});
const client = new RpcClient<Filter, StarknetRpcBlock>(stream);

const filters: Filter[] = [
  { events: [{ id: 1, address: "0x123", keys: ["0x456"] }] },
  { transactions: [{ id: 2, includeReceipt: true }] },
];

for await (const message of client.streamData({
  filter: filters,
  finality: "accepted",
  startingCursor: { orderKey: 1_000_000n },
})) {
  if (message._tag !== "data") continue;

  for (const filterResults of message.data.data) {
    // Entries stay aligned with `filters`; an entry is null when that filter
    // did not select data from the block.
    console.log(filterResults);
  }
}
```

## Options

- `url` is the HTTP JSON-RPC endpoint.
- `wsUrl` enables WebSocket head and pending signals when the endpoint supports
  them.
- `requestsPerSecond` and `maxConcurrency` control request pressure.
- `timeout`, `retryCount`, and `retryDelay` control request failure handling.
- `fetch` and `headers` customize HTTP transport and authentication without
  bypassing capability probes.
- `batch` enables JSON-RPC batching when supported by the endpoint.
- `mergeEventFilters` controls whether compatible event discovery requests are
  combined.
- `headRefreshIntervalMs`, `finalizedRefreshIntervalMs`, and
  `pendingDebounceMs` control refresh timing.
- `cacheSize` bounds each accepted-block cache and may be set to `0` to disable
  caching.
- `blockRangeSize`, `eventPageSize`, and `eventRangeSize` bound provider work.

Use `finality: "finalized"` for finalized blocks, `"accepted"` for the accepted
chain head, or `"pending"` for pending revisions. Pending streams require a
compatible `wsUrl`, or `pendingPolling: true` to explicitly use polling.

Call `stream.close()` when the stream configuration is no longer needed to
close its internally owned socket.
