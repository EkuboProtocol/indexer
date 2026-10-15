import { toHex, type Hex } from "viem";
import type { IndexerCursor } from "../_shared/dao";
import { parseRpcEnvelope, type RpcEnvelope } from "../_shared/rpcEnvelope";
import {
  checkContinuationToken,
  recordEventIdentity,
  requireBlockInRange,
} from "../_shared/rpcRecords";
import { StaleSnapshotError } from "../_shared/blockSnapshot";
import {
  createBlockStream,
  requireRepresentableIndex,
  type BlockStreamOptions,
  type ChainAdapter,
  type ChainHead,
  type LoadStoredBlocks,
  type StreamBlock as SharedStreamBlock,
  type StreamMessage as SharedStreamMessage,
} from "../_shared/blockStream";

export interface StarknetStreamFilter {
  id: number;
  fromAddress: Hex;
  keys: Hex[];
}

export interface StarknetStreamEvent {
  address: Hex;
  keys: Hex[];
  data: Hex[];
  transactionHash: Hex;
  transactionIndex: number;
  /**
   * Position of the event within its transaction, counting *every* event the
   * transaction emitted rather than only ours.
   *
   * This is what the apibara stream stored as `event_index` and what
   * `compute_event_id` has packed into every Starknet `event_id` ever written,
   * so it is not ours to renumber: re-basing it is a migration, not a stream
   * change. Note it counts the events in between, which is why it cannot be a
   * position within the filtered results -- block 14555766 holds 3 and 19 for
   * one transaction, where numbering only the matched events would give 0 and 1.
   */
  eventIndex: number;
  filterIds: number[];
}

export type StarknetStreamBlock = SharedStreamBlock<StarknetStreamEvent>;
export type StarknetStreamMessage = SharedStreamMessage<StarknetStreamEvent>;

function feltEquals(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

/**
 * A felt in one fixed spelling, applied to every block hash leaving this
 * adapter.
 *
 * The adapter compares felts by value, but the shared core it feeds does not
 * and cannot: `firstDivergentBlock` diffs `before.hash.toLowerCase() ===
 * after.hash.toLowerCase()` and `headUnchanged` compares strings outright.
 * Starknet nodes strip leading zeroes -- block 14555766 comes back as 62 hex
 * characters, not 64 -- and two nodes behind one endpoint have historically
 * disagreed about whether to. If the same block is ever spelled two ways, the
 * digest diff reads it as a block that changed hash, `rollbackTo` invalidates
 * and clears the window, and the next poll can do it again: rows deleted and
 * re-indexed on a chain that never reorged, looking exactly like a real reorg
 * in the logs.
 *
 * Canonicalising here rather than teaching the core about felts keeps the core
 * chain-agnostic, and costs nothing downstream: the hash is stored in a numeric
 * column, so padding never reaches the database either way.
 */
function canonicalFelt(felt: string): Hex {
  return toHex(BigInt(felt), { size: 32 });
}

export function eventMatchesFilter(
  event: Pick<StarknetStreamEvent, "address" | "keys">,
  filter: StarknetStreamFilter,
): boolean {
  if (!feltEquals(event.address, filter.fromAddress)) return false;
  if (event.keys.length < filter.keys.length) return false;
  for (let i = 0; i < filter.keys.length; i++) {
    const expected = filter.keys[i];
    if (expected === undefined) continue;
    const actual = event.keys[i];
    if (actual === undefined || !feltEquals(actual, expected)) return false;
  }
  return true;
}

export function matchingFilterIds(
  event: Pick<StarknetStreamEvent, "address" | "keys">,
  filters: StarknetStreamFilter[],
): number[] {
  const ids: number[] = [];
  for (const filter of filters) {
    if (eventMatchesFilter(event, filter)) ids.push(filter.id);
  }
  return ids;
}

/**
 * The selectors to ask the node for, or null when the filters do not all pin
 * one.
 *
 * A prefilter is only ever an optimisation, so it has to be a superset of what
 * `matchingFilterIds` accepts. A filter with no keys matches on address alone,
 * and no selector list can stand in for that -- so one such filter disables the
 * prefilter entirely rather than silently narrowing the read.
 */
export function selectorPrefilter(
  filters: StarknetStreamFilter[],
): Hex[] | null {
  const selectors = new Map<string, Hex>();
  for (const filter of filters) {
    const selector = filter.keys[0];
    if (selector === undefined) return null;
    selectors.set(BigInt(selector).toString(), selector);
  }
  return selectors.size > 0 ? [...selectors.values()] : null;
}

interface EmittedEvent {
  from_address: Hex;
  keys: Hex[];
  data: Hex[];
  block_hash?: Hex;
  block_number?: number;
  transaction_hash: Hex;
  transaction_index?: number;
  event_index?: number;
}

export function groupEventsByBlock(
  events: EmittedEvent[],
  filters: StarknetStreamFilter[],
): StarknetStreamBlock[] {
  const byBlock = new Map<number, StarknetStreamBlock>();
  const seen = new Map<string, string>();

  for (const event of events) {
    if (event.block_number === undefined || event.block_hash === undefined) {
      // A pre-confirmed block has neither, and it has no hash to anchor a
      // cursor to either. Nothing that cannot be rolled back to is indexed.
      continue;
    }
    const filterIds = matchingFilterIds(
      { address: event.from_address, keys: event.keys },
      filters,
    );
    if (filterIds.length === 0) continue;

    let block = byBlock.get(event.block_number);
    if (!block) {
      block = {
        header: {
          blockNumber: BigInt(event.block_number),
          blockHash: canonicalFelt(event.block_hash),
          timestamp: new Date(0),
          baseFeePerGas: null,
        },
        logs: [],
      };
      byBlock.set(event.block_number, block);
    }

    // Refused rather than defaulted. A zero here is not a near miss: it is a
    // wrong `event_id`, which is a primary key other tables order on, and it
    // would be written with no error anywhere. An endpoint that does not send
    // these is serving a spec older than the URL asks for.
    if (
      event.transaction_index === undefined ||
      event.event_index === undefined
    ) {
      throw new Error(
        `starknet_getEvents returned an event in block ${event.block_number} with no transaction_index or event_index. The RPC URL must name JSON-RPC v0.10 or later, which is where EMITTED_EVENT carries them.`,
      );
    }

    recordEventIdentity(
      seen,
      event.block_number,
      event.block_hash,
      `${event.transaction_index}:${event.event_index}`,
    );
    block.logs.push({
      address: event.from_address,
      keys: event.keys,
      data: event.data,
      transactionHash: event.transaction_hash,
      transactionIndex: requireRepresentableIndex(
        event.transaction_index,
        event.block_number,
        "the transaction index",
      ),
      eventIndex: requireRepresentableIndex(
        event.event_index,
        event.block_number,
        "the index within its transaction",
      ),
      filterIds,
    });
  }

  return [...byBlock.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      block.logs.sort(
        (a, b) =>
          a.transactionIndex - b.transactionIndex ||
          a.eventIndex - b.eventIndex,
      );
      return block;
    });
}

export interface StarknetRpc {
  request<T>(method: string, params: unknown): Promise<T>;
}

type BlockId = "latest" | "l1_accepted" | { block_number: number };

interface BlockHeaderResponse {
  block_hash?: Hex;
  block_number?: number;
  timestamp: number;
  l2_gas_price?: { price_in_fri?: Hex };
}

function toChainHead(block: BlockHeaderResponse | null): ChainHead | null {
  if (
    !block ||
    block.block_hash === undefined ||
    block.block_number === undefined
  ) {
    return null;
  }
  const priceInFri = block.l2_gas_price?.price_in_fri;
  return {
    number: block.block_number,
    hash: canonicalFelt(block.block_hash),
    timestamp: new Date(block.timestamp * 1000),
    baseFeePerGas: priceInFri === undefined ? null : BigInt(priceInFri),
  };
}

export interface StarknetAdapterOptions {
  rpc: StarknetRpc;
  filters: StarknetStreamFilter[];
  chunkSize?: number;
  maxPages?: number;
}

export function createStarknetAdapter({
  rpc,
  filters,
  chunkSize = 1_000,
  maxPages = 200,
}: StarknetAdapterOptions): ChainAdapter<StarknetStreamEvent> {
  if (filters.length === 0) {
    throw new Error("createStarknetEventStream requires at least one filter");
  }
  const keysPrefilter = selectorPrefilter(filters);

  const fetchHeader = async (blockId: BlockId): Promise<ChainHead | null> =>
    toChainHead(
      await rpc
        .request<BlockHeaderResponse | null>("starknet_getBlockWithTxHashes", [
          blockId,
        ])
        .catch((error: unknown) => {
          if (
            error instanceof StarknetRpcError &&
            error.code === BLOCK_NOT_FOUND
          )
            return null;
          throw error;
        }),
    );

  return {
    label: "starknet",

    fetchHead: () => fetchHeader("latest"),

    fetchFinalized: () => fetchHeader("l1_accepted"),

    fetchBlock: (blockNumber) => fetchHeader({ block_number: blockNumber }),

    async readRange(from, to, endHash) {
      const events: EmittedEvent[] = [];
      let continuationToken: string | null | undefined;
      let pages = 0;
      const tokens = new Set<string>();

      do {
        if (++pages > maxPages) {
          throw new Error(
            `starknet_getEvents did not finish paginating blocks ${from}..${to} within ${maxPages} pages of ${chunkSize}. Lower GET_LOGS_RANGE_SIZE.`,
          );
        }

        const page = await rpc
          .request<{
            events: EmittedEvent[];
            continuation_token?: string | null;
          }>("starknet_getEvents", [
            {
              from_block: { block_number: from },
              to_block: endHash
                ? { block_hash: endHash }
                : { block_number: to },
              ...(keysPrefilter ? { keys: [keysPrefilter] } : {}),
              chunk_size: chunkSize,
              ...(continuationToken
                ? { continuation_token: continuationToken }
                : {}),
            },
          ])
          .catch((error: unknown) => {
            if (
              endHash &&
              error instanceof StarknetRpcError &&
              error.code === BLOCK_NOT_FOUND
            ) {
              throw new StaleSnapshotError(
                `starknet_getEvents could not find end block ${to} (${endHash}); retry the snapshot`,
                { cause: error },
              );
            }
            throw error;
          });

        for (const event of page.events) {
          requireBlockInRange(event.block_number!, from, to);
          if (event.block_hash == null)
            throw new Error(
              "Numbered event range returned an event without a block hash",
            );
          events.push(event);
        }
        continuationToken = page.continuation_token;
        checkContinuationToken(continuationToken, tokens);
        // `!= null` deliberately: the field is optional in the spec, so a node
        // may end a listing with an explicit JSON `null` rather than by omitting
        // it. Testing only for `undefined` would keep this loop alive while the
        // falsy token was dropped from the request below -- page one re-fetched
        // until `maxPages`, then an error blaming the range size.
      } while (continuationToken != null);

      return groupEventsByBlock(events, filters);
    },

    async completeFresh(blocks, head) {
      for (const block of blocks) {
        const blockNumber = Number(block.header.blockNumber);
        const header = await fetchHeader({ block_number: blockNumber });
        if (!header) {
          throw new StaleSnapshotError(
            `Could not read block ${blockNumber}, whose events are already in hand`,
          );
        }

        // The range read and this read are two requests, so the chain can move
        // between them. A timestamp from a different block would be written to
        // `blocks.block_time` with nothing to flag it, so a block that changed
        // identity is refused instead, and the stream re-reads the snapshot.
        if (
          header.number !== blockNumber ||
          !feltEquals(header.hash, block.header.blockHash)
        ) {
          throw new StaleSnapshotError(
            `Block ${blockNumber} changed hash between the event read (${block.header.blockHash}) and the header read (${header.hash}); refusing to timestamp its events from a different block`,
          );
        }

        block.header.timestamp = header.timestamp;
      }

      for (const block of blocks) {
        if (Number(block.header.blockNumber) === head.number) {
          block.header.baseFeePerGas = head.baseFeePerGas;
        }
      }
    },
  };
}

const RETRYABLE_RPC_CODES = new Set([-1, -32005, -32603, 429]);

const BLOCK_NOT_FOUND = 24;

export class StarknetRpcError extends Error {
  override readonly name = "StarknetRpcError";
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([403, 408, 413, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

type Attempt<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "retry"; error: Error }
  | { outcome: "fail"; error: Error };

export function createStarknetRpc(
  url: string,
  {
    retries = 3,
    retryDelayMs = 250,
    timeoutMs = 20_000,
  }: { retries?: number; retryDelayMs?: number; timeoutMs?: number } = {},
): StarknetRpc {
  const attempt = async <T>(
    method: string,
    params: unknown,
  ): Promise<Attempt<T>> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        // Nothing else bounds how long this may hang. Without it a half-open
        // socket blocks the poll indefinitely: the generator is parked on this
        // await, so the retry loop below never runs, and because `runtime.ts`
        // does not reset the no-blocks timer on heartbeats the only backstop
        // left is NO_BLOCKS_TIMEOUT_MS -- five minutes of not indexing. viem
        // gives the EVM streams this for free; this is the equivalent.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { outcome: "retry", error: error as Error };
    }

    if (isRetryableStatus(response.status)) {
      return {
        outcome: "retry",
        error: new Error(`${method} failed with HTTP ${response.status}`),
      };
    }
    if (!response.ok) {
      return {
        outcome: "fail",
        error: new Error(`${method} failed with HTTP ${response.status}`),
      };
    }

    let body: RpcEnvelope<T>;
    try {
      body = parseRpcEnvelope<T>(await response.json());
    } catch (error) {
      return {
        outcome: "retry",
        error: new Error(
          `${method} returned an invalid JSON-RPC response: ${String(error).slice(0, 120)}`,
        ),
      };
    }

    if (body.error) {
      const failure = new StarknetRpcError(
        `${method} failed: ${body.error.message} (code ${body.error.code})`,
        body.error.code,
      );
      return RETRYABLE_RPC_CODES.has(body.error.code)
        ? { outcome: "retry", error: failure }
        : { outcome: "fail", error: failure };
    }
    return { outcome: "ok", value: body.result as T };
  };

  return {
    async request<T>(method: string, params: unknown): Promise<T> {
      let lastError: unknown;

      for (let i = 0; i <= retries; i++) {
        if (i > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * 2 ** (i - 1)),
          );
        }

        const result = await attempt<T>(method, params);
        if (result.outcome === "ok") return result.value;
        if (result.outcome === "fail") throw result.error;
        lastError = result.error;
      }

      throw new Error(
        `${method} failed after ${retries + 1} attempts. Cause: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
        { cause: lastError },
      );
    },
  };
}

export interface CreateStarknetEventStreamArgs {
  rpc: StarknetRpc;
  filters: StarknetStreamFilter[];
  startingCursor: IndexerCursor;
  loadPreviousCursor?: (before: number) => Promise<IndexerCursor | null>;
  loadStoredBlocks?: LoadStoredBlocks;
  options?: BlockStreamOptions & { chunkSize?: number; maxPages?: number };
}

export function createStarknetEventStream(
  args: CreateStarknetEventStreamArgs,
): AsyncGenerator<StarknetStreamMessage> {
  const { chunkSize, maxPages, ...options } = args.options ?? {};

  return createBlockStream<StarknetStreamEvent>({
    adapter: createStarknetAdapter({
      rpc: args.rpc,
      filters: args.filters,
      chunkSize,
      maxPages,
    }),
    startingCursor: args.startingCursor,
    loadPreviousCursor: args.loadPreviousCursor,
    loadStoredBlocks: args.loadStoredBlocks,
    options,
  });
}
