/**
 * The Starknet adapter for the shared block stream.
 *
 * Starknet used to be indexed from an apibara DNA gRPC stream while every EVM
 * chain moved to range-reading its own RPC. That left two ways of handling the
 * same three problems -- reorgs, backoff and the cursor -- and only one of them
 * had the bugs beaten out of it. This puts Starknet on the same core, so a fix
 * to the reorg window or the poll backoff lands on every chain at once.
 *
 * Three things genuinely differ from EVM, and they are all here rather than in
 * the shared core:
 *
 * 1. `starknet_getEvents` takes one address, not a list. Asking per contract
 *    would be twelve requests a poll where EVM makes one, so the range read is
 *    filtered by event selector instead -- which the RPC does accept as an
 *    OR-list -- and narrowed to our contracts locally. Measured on mainnet the
 *    selector prefilter cuts a range read from 15.9 to 3.3 events per block.
 *
 * 2. `EMITTED_EVENT` carries a transaction index and an event index only from
 *    JSON-RPC v0.10, which is why the URL pins that version. Under v0.9 they
 *    are absent and the `continuation_token` counts *matched* results, so it
 *    cannot supply them either -- they had to be rebuilt from the block's
 *    receipts, pairing our events back onto their true positions. That is a
 *    lot of machinery to get exactly right for two integers, and both were
 *    checked three ways before this was allowed to rely on them: v0.10's
 *    values, a receipts reconstruction, and the rows the DNA stream wrote
 *    years ago all agree, over 5,000 mainnet blocks.
 *
 *    A block read remains, but only for the timestamp: `EMITTED_EVENT` has
 *    none and `blocks.block_time` needs one. It costs the same 20 compute
 *    units the receipts read did, so this is a simplification rather than a
 *    saving -- one request per block above the cursor either way.
 *
 * 3. A felt is not an EVM word. Nodes return them unpadded, the processor
 *    filters are written unpadded, and the database stores them as numerics, so
 *    every comparison here is on the value and never on the string.
 */
import { toHex, type Hex } from "viem";
import type { IndexerCursor } from "../_shared/dao";
import { parseRpcEnvelope, type RpcEnvelope } from "../_shared/rpcEnvelope";
import { checkContinuationToken, recordEventIdentity, requireBlockInRange } from "../_shared/rpcRecords";
import {
  createBlockStream,
  requireRepresentableIndex,
  type BlockStreamOptions,
  type ChainAdapter,
  type ChainHead,
  type StreamBlock as SharedStreamBlock,
  type StreamMessage as SharedStreamMessage,
} from "../_shared/blockStream";

/** A single processor's event filter, as `eventProcessors` already writes it. */
export interface StarknetStreamFilter {
  /** 1-based, matching the `filterIds` the block processors index into. */
  id: number;
  fromAddress: Hex;
  /** Matched positionally against the event's keys, as a prefix. */
  keys: Hex[];
}

/** One event, as the runtime's processors consume it. */
export interface StarknetStreamEvent {
  address: Hex;
  keys: Hex[];
  data: Hex[];
  transactionHash: Hex;
  /** Position of the emitting transaction in its block. */
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

/** Felts compare by value: nodes pad them inconsistently and we do not. */
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

/**
 * True when `event` satisfies `filter`.
 *
 * Prefix match on keys, mirroring what the DNA filter did: an event carrying
 * more keys than the filter names still matches, which is what lets a filter on
 * the selector alone match every event of that name.
 */
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
  /** v0.10 and above. Absent is a misconfigured endpoint, not an old block. */
  transaction_index?: number;
  event_index?: number;
}

/**
 * Groups matched events into blocks, in ascending block order, preserving the
 * order the node returned them in within a block.
 *
 * Blocks carrying nothing we match are omitted, which the shared diff depends
 * on: a block with no matched event has no representation in a range read, so
 * recording one would make it look like it had disappeared on the next re-read.
 */
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
          // Filled by `completeFresh`, which reads the block anyway.
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
    if (event.transaction_index === undefined || event.event_index === undefined) {
      throw new Error(
        `starknet_getEvents returned an event in block ${event.block_number} with no transaction_index or event_index. The RPC URL must name JSON-RPC v0.10 or later, which is where EMITTED_EVENT carries them.`,
      );
    }

    recordEventIdentity(seen, event.block_number, event.block_hash, `${event.transaction_index}:${event.event_index}`);
    block.logs.push({
      address: event.from_address,
      keys: event.keys,
      data: event.data,
      transactionHash: event.transaction_hash,
      transactionIndex: requireRepresentableIndex(
        event.transaction_index, event.block_number, "the transaction index",
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
      block.logs.sort((a, b) => a.transactionIndex - b.transactionIndex || a.eventIndex - b.eventIndex);
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
  if (!block || block.block_hash === undefined || block.block_number === undefined) {
    return null;
  }
  const priceInFri = block.l2_gas_price?.price_in_fri;
  return {
    number: block.block_number,
    hash: canonicalFelt(block.block_hash),
    timestamp: new Date(block.timestamp * 1000),
    // What the DNA stream reported as the header's base fee, and what
    // `indexer_cursor.head_base_fee_per_gas` has held for Starknet all along.
    baseFeePerGas: priceInFri === undefined ? null : BigInt(priceInFri),
  };
}

export interface StarknetAdapterOptions {
  rpc: StarknetRpc;
  filters: StarknetStreamFilter[];
  /** Events per `starknet_getEvents` page. */
  chunkSize?: number;
  /** Refuses a range read that will not terminate rather than looping forever. */
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
      await rpc.request<BlockHeaderResponse | null>(
        "starknet_getBlockWithTxHashes",
        [blockId],
      ),
    );

  return {
    label: "starknet",

    fetchHead: () => fetchHeader("latest"),

    // Starknet's finality is settlement on Ethereum, and `l1_accepted` names
    // the deepest block that has it. It trails the head by hours rather than
    // seconds, which costs nothing here: the finalized block is only a floor on
    // the re-read and a cursor to announce.
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

        const page = await rpc.request<{
          events: EmittedEvent[];
          // Nullable, not merely optional: the field is optional in the spec, so
          // a node may end a listing either by omitting it or by sending null.
          continuation_token?: string | null;
        }>("starknet_getEvents", [
          {
            from_block: { block_number: from },
            to_block: endHash ? { block_hash: endHash } : { block_number: to },
            ...(keysPrefilter ? { keys: [keysPrefilter] } : {}),
            chunk_size: chunkSize,
            ...(continuationToken
              ? { continuation_token: continuationToken }
              : {}),
          },
        ]);

        for (const event of page.events) {
          requireBlockInRange(event.block_number!, from, to);
          if (event.block_hash == null) throw new Error("Numbered event range returned an event without a block hash");
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

      // Unlike `eth_getLogs` there is no truncation to guard against. A capped
      // response says so by handing back a continuation token, and the loop
      // above only stops when the node reports there is no more -- so a short
      // read is a protocol violation rather than something indistinguishable
      // from a complete answer.
      return groupEventsByBlock(events, filters);
    },

    async completeFresh(blocks, head) {
      // Only the timestamp, and only for blocks above the cursor. Everything
      // below is being re-read to diff its digest, which the range read already
      // answers, so paying a request per block for it would be the reorg
      // window's width in waste on every poll -- ~390k requests a day against
      // ~6k.
      for (const block of blocks) {
        const blockNumber = Number(block.header.blockNumber);
        const header = await fetchHeader({ block_number: blockNumber });
        if (!header) {
          throw new Error(
            `Could not read block ${blockNumber}, whose events are already in hand`,
          );
        }

        // The range read and this read are two requests, so the chain can move
        // between them. A timestamp from a different block would be written to
        // `blocks.block_time` with nothing to flag it, so a block that changed
        // identity is refused instead. The cursor is durable and the runtime
        // restarts, so the next pass re-reads a consistent block.
        if (header.number !== blockNumber || !feltEquals(header.hash, block.header.blockHash)) {
          throw new Error(
            `Block ${blockNumber} changed hash between the event read (${block.header.blockHash}) and the header read (${header.hash}); refusing to timestamp its events from a different block`,
          );
        }

        block.header.timestamp = header.timestamp;
      }

      // The head's own gas price is already in hand from this poll's head read,
      // and it is the only block whose base fee is stored -- the DAO keeps it on
      // `indexer_cursor`, which quoter-service reads to price gas.
      for (const block of blocks) {
        if (Number(block.header.blockNumber) === head.number) {
          block.header.baseFeePerGas = head.baseFeePerGas;
        }
      }
    },
  };
}

/**
 * Retryable JSON-RPC error codes, matching the list viem applies to the EVM
 * streams.
 *
 * A JSON-RPC error is usually an answer rather than a failure to answer, so
 * most are not retried. These are the exceptions, and 429 is the one that
 * matters here: Alchemy reports a compute-unit overage as an **HTTP 200
 * carrying code 429**, so a client that only inspects the status code sees a
 * successful response containing an error and gives up.
 *
 * Getting this wrong is not a dropped request. Throwing propagates out of
 * `fetchHead`, exits the generator, and `restart.sh` restarts the worker a
 * second later -- so the response to being throttled would be to poll the
 * throttling endpoint harder, forever, while every EVM worker quietly backs
 * off. Under the account's spend cap that is exactly when it would fire.
 */
const RETRYABLE_RPC_CODES = new Set([-1, -32005, -32603, 429]);

/**
 * HTTP statuses viem retries for the EVM streams, enumerated so this client
 * matches them rather than approximating them.
 *
 * 403 and 413 are the two a `status >= 500 || 408 || 429` test misses. A
 * transient 403 from a provider edge would otherwise throw straight out of
 * `fetchHead`, and `runtime.ts` exits the process on a generator throw -- a
 * worker restart where an EVM worker would have retried in place.
 */
const RETRYABLE_HTTP_STATUSES = new Set([403, 408, 413, 429]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

/** One attempt, classified into a value, a retry, or a throw. */
type Attempt<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "retry"; error: Error }
  | { outcome: "fail"; error: Error };

/**
 * A JSON-RPC client with the retry behaviour viem gives the EVM streams.
 *
 * Retries a transport failure, a timeout, a status the server says is
 * transient, a body that is not the JSON it claimed, and the JSON-RPC codes
 * above. Anything else is an answer, and is returned or thrown as one.
 */
export function createStarknetRpc(
  url: string,
  {
    retries = 3,
    retryDelayMs = 250,
    timeoutMs = 20_000,
  }: { retries?: number; retryDelayMs?: number; timeoutMs?: number } = {},
): StarknetRpc {
  // Split out of `request` so each half stays under the lint's complexity cap,
  // and so the classification can be read without the retry loop around it.
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
      // A 200 carrying a proxy or CDN error page rather than JSON. That is a
      // failure to answer, not an answer, so it is retried like one.
      return {
        outcome: "retry",
        error: new Error(
          `${method} returned an invalid JSON-RPC response: ${String(error).slice(0, 120)}`,
        ),
      };
    }

    if (body.error) {
      const failure = new Error(
        `${method} failed: ${body.error.message} (code ${body.error.code})`,
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
  options?: BlockStreamOptions & { chunkSize?: number; maxPages?: number };
}

/**
 * Yields the same messages the DNA stream did, so the runtime, the DAO and
 * every processor are untouched.
 */
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
    options,
  });
}
