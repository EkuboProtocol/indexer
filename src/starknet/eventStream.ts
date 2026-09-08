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
import type { Hex } from "viem";
import type { IndexerCursor } from "../_shared/dao";
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
          blockHash: event.block_hash,
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

    block.logs.push({
      address: event.from_address,
      keys: event.keys,
      data: event.data,
      transactionHash: event.transaction_hash,
      transactionIndex: event.transaction_index,
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
    .map(([, block]) => block);
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
    hash: block.block_hash,
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

    async readRange(from, to) {
      const events: EmittedEvent[] = [];
      let continuationToken: string | undefined;
      let pages = 0;

      do {
        if (++pages > maxPages) {
          throw new Error(
            `starknet_getEvents did not finish paginating blocks ${from}..${to} within ${maxPages} pages of ${chunkSize}. Lower GET_LOGS_RANGE_SIZE.`,
          );
        }

        const page = await rpc.request<{
          events: EmittedEvent[];
          continuation_token?: string;
        }>("starknet_getEvents", [
          {
            from_block: { block_number: from },
            to_block: { block_number: to },
            ...(keysPrefilter ? { keys: [keysPrefilter] } : {}),
            chunk_size: chunkSize,
            ...(continuationToken
              ? { continuation_token: continuationToken }
              : {}),
          },
        ]);

        events.push(...page.events);
        continuationToken = page.continuation_token;
      } while (continuationToken !== undefined);

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
        if (!feltEquals(header.hash, block.header.blockHash)) {
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
 * A JSON-RPC client with the retry behaviour viem gives the EVM streams.
 *
 * Retries only what is worth retrying -- a transport failure or a status the
 * server itself says is transient -- and never a JSON-RPC error, which is an
 * answer rather than a failure to answer.
 */
export function createStarknetRpc(
  url: string,
  { retries = 3, retryDelayMs = 250 }: { retries?: number; retryDelayMs?: number } = {},
): StarknetRpc {
  return {
    async request<T>(method: string, params: unknown): Promise<T> {
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)),
          );
        }

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params,
            }),
          });
        } catch (error) {
          lastError = error;
          continue;
        }

        if (
          response.status === 429 ||
          response.status === 408 ||
          response.status >= 500
        ) {
          lastError = new Error(`${method} failed with HTTP ${response.status}`);
          continue;
        }

        if (!response.ok) {
          throw new Error(`${method} failed with HTTP ${response.status}`);
        }

        const body = (await response.json()) as {
          result?: T;
          error?: { code: number; message: string };
        };
        if (body.error) {
          throw new Error(
            `${method} failed: ${body.error.message} (code ${body.error.code})`,
          );
        }
        return body.result as T;
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
    options,
  });
}
