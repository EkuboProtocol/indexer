/**
 * EVM range adapter. Logs provide event identities and usually timestamps;
 * headers are fetched only when timestamps are missing. The snapshot reader
 * verifies the cursor and ending header before committing the range.
 */
import type { Address, Hex, PublicClient } from "viem";
import { hexToBigInt, hexToNumber, numberToHex } from "viem";
import type { IndexerCursor } from "../_shared/dao";
import { recordEventIdentity, requireBlockInRange } from "../_shared/rpcRecords";
import {
  createBlockStream,
  digestBlocks,
  firstDivergentBlock,
  maxReorgWindowBlocks,
  observeBlockRate,
  pollIntervalFor,
  reorgWindowBlocksFor,
  requireRepresentableIndex,
  type BlockStreamOptions,
  type ChainAdapter,
  type ChainHead,
  type StreamBlock as SharedStreamBlock,
  type StreamMessage as SharedStreamMessage,
} from "../_shared/blockStream";

// Re-exported so this module stays the one place EVM code imports the stream
// from, whether the piece it needs is EVM-specific or shared.
export {
  digestBlocks,
  firstDivergentBlock,
  maxReorgWindowBlocks,
  observeBlockRate,
  pollIntervalFor,
  reorgWindowBlocksFor,
};

/** A single processor's log filter, mirroring the shape the entrypoint builds. */
export interface LogStreamFilter {
  /** 1-based, matching the `filterIds` the block processors index into. */
  id: number;
  address: Address;
  topics: (Hex | null)[];
  /** When set, the log must carry exactly `topics.length` topics. */
  strict: boolean;
}

export interface LogStreamOptions extends BlockStreamOptions {
  /**
   * A log count that is suspected of being a provider's cap rather than a real
   * result. Set it to the provider's documented `eth_getLogs` limit.
   */
  suspectLogCount?: number;
}

const EVM_DEFAULTS = {
  suspectLogCount: 10_000,
} as const;

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed?: boolean;
}

/** One log, as the runtime's processors consume it. */
export interface StreamLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  filterIds: number[];
}

/** The block shape the runtime's `parseEvmBlockHeader` expects. */
export type StreamBlock = SharedStreamBlock<StreamLog>;
export type StreamMessage = SharedStreamMessage<StreamLog>;

/**
 * True when `log` satisfies `filter`.
 *
 * Positional topic match with `null` as a wildcard. A non-strict filter matches
 * a log that carries more topics than the filter names, which is what lets a
 * filter on `topic0` alone match every event of that signature.
 */
export function logMatchesFilter(
  log: Pick<RawLog, "address" | "topics">,
  filter: LogStreamFilter,
): boolean {
  if (log.address.toLowerCase() !== filter.address.toLowerCase()) return false;

  if (filter.strict) {
    if (log.topics.length !== filter.topics.length) return false;
  } else if (log.topics.length < filter.topics.length) {
    return false;
  }

  for (let i = 0; i < filter.topics.length; i++) {
    const expected = filter.topics[i];
    if (expected === null || expected === undefined) continue;
    if (log.topics[i]?.toLowerCase() !== expected.toLowerCase()) return false;
  }

  return true;
}

export function matchingFilterIds(
  log: Pick<RawLog, "address" | "topics">,
  filters: LogStreamFilter[],
): number[] {
  const ids: number[] = [];
  for (const filter of filters) {
    if (logMatchesFilter(log, filter)) ids.push(filter.id);
  }
  return ids;
}

/**
 * Groups logs into blocks, in ascending block order, with logs inside a block
 * ordered by log index. `eth_getLogs` is specified to return logs in order, but
 * ordering the emitted stream is the whole contract with the runtime, so it is
 * enforced here rather than assumed.
 */
export function groupLogsByBlock(
  logs: RawLog[],
  filters: LogStreamFilter[],
): StreamBlock[] {
  const byBlock = new Map<number, { block: StreamBlock }>();
  const seen = new Map<string, string>();

  for (const log of logs) {
    if (log.removed) continue;

    const blockNumber = hexToNumber(log.blockNumber);
    const filterIds = matchingFilterIds(log, filters);
    if (filterIds.length === 0) continue;

    recordEventIdentity(seen, blockNumber, log.blockHash, String(hexToNumber(log.logIndex)));
    let entry = byBlock.get(blockNumber);
    if (!entry) {
      entry = {
        block: {
          header: {
            blockNumber: BigInt(blockNumber),
            blockHash: log.blockHash,
            // Present on every chain we index; `requireTimestamps` below is what
            // handles a provider that omits it rather than a silent zero date.
            timestamp: new Date(
              log.blockTimestamp ? hexToNumber(log.blockTimestamp) * 1000 : 0,
            ),
            baseFeePerGas: null,
          },
          logs: [],
        },
      };
      byBlock.set(blockNumber, entry);
    }

    entry.block.logs.push({
      address: log.address,
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      transactionIndex: requireRepresentableIndex(
        hexToNumber(log.transactionIndex), blockNumber, "the transaction index",
      ),
      // `evm.ts` uses a log's block-wide `logIndex` as its `event_index`,
      // because the apibara RPC stream this replaces never populated
      // `logIndexInTransaction` either.
      logIndex: requireRepresentableIndex(
        hexToNumber(log.logIndex),
        blockNumber,
        "the block-wide log index",
      ),
      filterIds,
    });
  }

  return [...byBlock.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      entry.block.logs.sort((a, b) => a.logIndex - b.logIndex);
      return entry.block;
    });
}

export interface RpcLike {
  request: PublicClient["request"];
}

/**
 * Reads logs for a block range, refusing a response that might have been
 * silently truncated.
 *
 * A provider that caps results and answers with exactly the cap returns
 * something a caller cannot distinguish from a complete answer, and believing
 * it means dropping every event past the cap with nothing to show for it. So a
 * response landing exactly on `suspectLogCount` is not believed: the range is
 * halved and re-read, and a single block that still lands on the cap throws
 * rather than delivering something that might be short.
 */
export async function fetchLogsChecked(
  rpc: RpcLike,
  args: {
    fromBlock: number;
    toBlock: number;
    addresses: Address[];
    suspectLogCount: number;
  },
): Promise<RawLog[]> {
  const { fromBlock, toBlock, addresses, suspectLogCount } = args;

  let logs: RawLog[];
  try {
    logs = (await rpc.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: numberToHex(BigInt(fromBlock)),
          toBlock: numberToHex(BigInt(toBlock)),
          address: addresses,
        },
      ],
    } as never)) as unknown as RawLog[];
  } catch (error) {
    // Fail fast. An earlier version tried to recognise "the range was too wide"
    // from the error text and recover by splitting, but every provider words
    // that differently and any of them can reword it in a release. A match list
    // that silently stops matching turns recovery into a crash loop, and nothing
    // would notice until it happened in production -- so the classification is
    // the liability, not the thing being classified.
    //
    // Nothing is lost by refusing here. viem's transport already retries the
    // errors worth retrying, with backoff: HTTP 403/408/413/429/500/502/503 and
    // JSON-RPC -1, -32005, -32603 and 429 (Alchemy reports a compute-unit
    // overage as an HTTP 200 carrying code 429, which viem handles by name).
    // Anything reaching here has already survived that, so it is a real error,
    // and the range is ours to choose: GET_LOGS_RANGE_SIZE is the knob.
    throw new Error(
      `eth_getLogs failed for blocks ${fromBlock}..${toBlock} (${
        toBlock - fromBlock + 1
      } blocks, ${addresses.length} addresses). If this is the provider refusing the span rather than a transient fault, lower GET_LOGS_RANGE_SIZE. Cause: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  // Only a count landing *exactly* on the cap is ambiguous. More than the cap
  // proves no cap was applied, so the response is complete and believing it is
  // correct -- and inside Alchemy's block-range limit there is no result cap at
  // all, so this is reachable. Treating "over" like "at" would stall a chain on
  // any single block genuinely carrying that many logs.
  if (logs.length !== suspectLogCount) return logs;

  if (fromBlock === toBlock) {
    throw new Error(
      `eth_getLogs returned exactly ${logs.length} logs for the single block ${fromBlock}, which matches the configured provider cap (SUSPECT_LOG_COUNT). The response cannot be distinguished from a truncated one, so it is refused rather than indexed short.`,
    );
  }

  return splitRange(rpc, args);
}

/**
 * Halves a span and reads both sides, one after the other.
 *
 * Only ever reached from the truncation guard, which fires on a *successful*
 * response whose count lands exactly on the configured cap. That is a decision
 * about a number we were handed, not about text a provider chose, so it cannot
 * rot the way error matching does.
 *
 * Sequentially, deliberately. Bisecting concurrently would turn one oversized
 * range into an exponentially widening burst of in-flight requests, which is a
 * good way to convert a size limit into a rate limit.
 */
async function splitRange(
  rpc: RpcLike,
  args: {
    fromBlock: number;
    toBlock: number;
    addresses: Address[];
    suspectLogCount: number;
  },
): Promise<RawLog[]> {
  const { fromBlock, toBlock } = args;
  const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2);
  const left = await fetchLogsChecked(rpc, {
    ...args,
    fromBlock,
    toBlock: middle,
  });
  const right = await fetchLogsChecked(rpc, {
    ...args,
    fromBlock: middle + 1,
    toBlock,
  });
  return [...left, ...right];
}

async function fetchBlockByTag(
  rpc: RpcLike,
  tag: "latest" | "finalized",
): Promise<ChainHead | null> {
  const block = (await rpc.request({
    method: "eth_getBlockByNumber",
    params: [tag, false],
  } as never)) as unknown as {
    number: Hex | null;
    hash: Hex | null;
    timestamp: Hex;
    baseFeePerGas?: Hex;
  } | null;

  if (!block || block.number === null || block.hash === null) return null;

  return {
    number: hexToNumber(block.number),
    hash: block.hash,
    timestamp: new Date(hexToNumber(block.timestamp) * 1000),
    baseFeePerGas: block.baseFeePerGas
      ? hexToBigInt(block.baseFeePerGas)
      : null,
  };
}

async function fetchBlockByNumber(
  rpc: RpcLike,
  blockNumber: number,
): Promise<ChainHead | null> {
  const block = (await rpc.request({
    method: "eth_getBlockByNumber",
    params: [numberToHex(BigInt(blockNumber)), false],
  } as never)) as unknown as {
    number: Hex | null;
    hash: Hex | null;
    timestamp: Hex;
    baseFeePerGas?: Hex;
  } | null;

  if (!block || block.number === null || block.hash === null) return null;

  return {
    number: hexToNumber(block.number),
    hash: block.hash,
    timestamp: new Date(hexToNumber(block.timestamp) * 1000),
    baseFeePerGas: block.baseFeePerGas
      ? hexToBigInt(block.baseFeePerGas)
      : null,
  };
}

/**
 * Trust timestamped logs under the provider consistency contract in README.md.
 * Reuse the anchor for the head fee; hash-check any missing-timestamp fallback.
 */
async function completeBlocks(
  rpc: RpcLike,
  blocks: StreamBlock[],
  head: ChainHead,
): Promise<void> {
  for (const block of blocks) {
    const number = Number(block.header.blockNumber);
    if (number !== head.number && Number.isFinite(block.header.timestamp.getTime()) && block.header.timestamp.getTime() > 0) continue;
    const filled = number === head.number ? head : await fetchBlockByNumber(rpc, number);
    if (!filled) {
      throw new Error(
        `Could not verify event-bearing block ${block.header.blockNumber}`,
      );
    }
    if (filled.number !== Number(block.header.blockNumber) || filled.hash.toLowerCase() !== block.header.blockHash.toLowerCase()) {
      throw new Error(
        `Block ${block.header.blockNumber} changed hash between the log read (${block.header.blockHash}) and the header read (${filled.hash}); refusing to timestamp its logs from a different block`,
      );
    }
    block.header.timestamp = filled.timestamp;
    block.header.baseFeePerGas = filled.baseFeePerGas;
  }
}

export interface CreateLogStreamArgs {
  rpc: RpcLike;
  filters: LogStreamFilter[];
  startingCursor: IndexerCursor;
  loadPreviousCursor?: (before: number) => Promise<IndexerCursor | null>;
  options?: LogStreamOptions;
}

export function createEvmAdapter(
  rpc: RpcLike,
  filters: LogStreamFilter[],
  suspectLogCount: number,
): ChainAdapter<StreamLog> {
  const addresses = [
    ...new Set(filters.map((f) => f.address.toLowerCase() as Address)),
  ];
  if (addresses.length === 0) {
    throw new Error("createLogStream requires at least one filter");
  }

  return {
    label: "evm",
    fetchHead: () => fetchBlockByTag(rpc, "latest"),
    fetchFinalized: () => fetchBlockByTag(rpc, "finalized"),
    fetchBlock: (blockNumber) => fetchBlockByNumber(rpc, blockNumber),
    async readRange(from, to) {
      const logs = await fetchLogsChecked(rpc, {
        fromBlock: from,
        toBlock: to,
        addresses,
        suspectLogCount,
      });
      for (const log of logs) {
        requireBlockInRange(hexToNumber(log.blockNumber), from, to);
        if (log.removed) throw new Error("eth_getLogs returned a removed log in a numbered range");
      }
      return groupLogsByBlock(logs, filters);
    },
    async completeFresh(blocks, head) {
      await completeBlocks(rpc, blocks, head);
    },
  };
}

/**
 * Yields the same messages the previous stream did, so the runtime, the DAO and
 * every processor are untouched.
 */
export function createLogStream(
  args: CreateLogStreamArgs,
): AsyncGenerator<StreamMessage> {
  const { suspectLogCount = EVM_DEFAULTS.suspectLogCount, ...options } =
    args.options ?? {};

  return createBlockStream<StreamLog>({
    adapter: createEvmAdapter(args.rpc, args.filters, suspectLogCount),
    startingCursor: args.startingCursor,
    loadPreviousCursor: args.loadPreviousCursor,
    options,
  });
}
