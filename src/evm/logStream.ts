import type { Address, Hex, PublicClient } from "viem";
import { hexToBigInt, hexToNumber, numberToHex } from "viem";
import type { DiscoveredAddressSource, IndexerCursor } from "../_shared/dao";
import {
  recordEventIdentity,
  requireBlockInRange,
} from "../_shared/rpcRecords";
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
  type EndpointSelector,
  type LoadStoredBlocks,
  type StreamBlock as SharedStreamBlock,
  type StreamMessage as SharedStreamMessage,
} from "../_shared/blockStream";

export {
  digestBlocks,
  firstDivergentBlock,
  maxReorgWindowBlocks,
  observeBlockRate,
  pollIntervalFor,
  reorgWindowBlocksFor,
};

export interface LogStreamFilter {
  id: number;
  address: Address;
  topics: (Hex | null)[];
  strict: boolean;
  /**
   * When set, the filter matches logs of every address this source names,
   * instead of logs of `address`.
   */
  discoveredBy?: DiscoveredAddressSource;
}

/** Lower-case addresses named so far, per source key. */
export type DiscoveredAddresses = ReadonlyMap<string, ReadonlySet<string>>;

export type LoadDiscoveredAddresses = (
  source: DiscoveredAddressSource,
) => Promise<Address[]>;

export const discoveredAddressSourceKey = (
  source: DiscoveredAddressSource,
): string => `${source.kind}:${source.address.toLowerCase()}`;

/** The address a log names for `source`, if it is that source's event. */
function namedAddress(
  log: Pick<RawLog, "address" | "topics">,
  source: DiscoveredAddressSource,
): string | undefined {
  if (log.address.toLowerCase() !== source.address.toLowerCase()) return;
  if (log.topics[0]?.toLowerCase() !== source.topic0.toLowerCase()) return;
  const topic = log.topics[source.topicIndex];
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : undefined;
}

function discoverySources(
  filters: LogStreamFilter[],
): DiscoveredAddressSource[] {
  const sources = new Map<string, DiscoveredAddressSource>();
  for (const { discoveredBy } of filters)
    if (discoveredBy)
      sources.set(discoveredAddressSourceKey(discoveredBy), discoveredBy);
  return [...sources.values()];
}

/**
 * `known` plus every address the logs name. The whole batch is scanned before
 * any log is matched: a contract's first logs can precede, in the same
 * transaction, the event that names it.
 */
export function discoverAddresses(
  logs: Pick<RawLog, "address" | "topics" | "removed">[],
  filters: LogStreamFilter[],
  known: DiscoveredAddresses = new Map(),
): DiscoveredAddresses {
  const result = new Map<string, Set<string>>();
  for (const source of discoverySources(filters)) {
    const key = discoveredAddressSourceKey(source);
    const addresses = new Set(known.get(key));
    for (const log of logs) {
      if (log.removed) continue;
      const named = namedAddress(log, source);
      if (named) addresses.add(named);
    }
    result.set(key, addresses);
  }
  return result;
}

export interface LogStreamOptions extends BlockStreamOptions {
  suspectLogCount?: number | (() => number);
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

export interface StreamLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  filterIds: number[];
}

export type StreamBlock = SharedStreamBlock<StreamLog>;
export type StreamMessage = SharedStreamMessage<StreamLog>;

function addressMatches(
  address: Address,
  filter: LogStreamFilter,
  discovered: DiscoveredAddresses | undefined,
): boolean {
  if (!filter.discoveredBy)
    return address.toLowerCase() === filter.address.toLowerCase();
  return (
    discovered
      ?.get(discoveredAddressSourceKey(filter.discoveredBy))
      ?.has(address.toLowerCase()) ?? false
  );
}

export function logMatchesFilter(
  log: Pick<RawLog, "address" | "topics">,
  filter: LogStreamFilter,
  discovered?: DiscoveredAddresses,
): boolean {
  if (!addressMatches(log.address, filter, discovered)) return false;

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
  discovered?: DiscoveredAddresses,
): number[] {
  const ids: number[] = [];
  for (const filter of filters) {
    if (logMatchesFilter(log, filter, discovered)) ids.push(filter.id);
  }
  return ids;
}

/**
 * Groups the logs matching `filters` by block. Filters with `discoveredBy`
 * match the `known` addresses and those named anywhere in `logs`.
 */
export function groupLogsByBlock(
  logs: RawLog[],
  filters: LogStreamFilter[],
  known?: DiscoveredAddresses,
): StreamBlock[] {
  const byBlock = new Map<number, { block: StreamBlock }>();
  const seen = new Map<string, string>();
  const discovered = discoverAddresses(logs, filters, known);

  for (const log of logs) {
    if (log.removed) continue;

    const blockNumber = hexToNumber(log.blockNumber);
    const filterIds = matchingFilterIds(log, filters, discovered);
    if (filterIds.length === 0) continue;

    recordEventIdentity(
      seen,
      blockNumber,
      log.blockHash,
      String(hexToNumber(log.logIndex)),
    );
    let entry = byBlock.get(blockNumber);
    if (!entry) {
      entry = {
        block: {
          header: {
            blockNumber: BigInt(blockNumber),
            blockHash: log.blockHash,
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
        hexToNumber(log.transactionIndex),
        blockNumber,
        "the transaction index",
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
    //
    // Failing the read is not failing the worker: the block stream backs off
    // and re-reads (`backOffAfterReadFailure`), and exits only once the
    // provider has been failing for longer than its outage budget.
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

async function completeBlocks(
  rpc: RpcLike,
  blocks: StreamBlock[],
  head: ChainHead,
): Promise<void> {
  for (const block of blocks) {
    const number = Number(block.header.blockNumber);
    if (
      number !== head.number &&
      Number.isFinite(block.header.timestamp.getTime()) &&
      block.header.timestamp.getTime() > 0
    )
      continue;
    const filled =
      number === head.number ? head : await fetchBlockByNumber(rpc, number);
    if (!filled) {
      throw new Error(
        `Could not verify event-bearing block ${block.header.blockNumber}`,
      );
    }
    if (
      filled.number !== Number(block.header.blockNumber) ||
      filled.hash.toLowerCase() !== block.header.blockHash.toLowerCase()
    ) {
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
  loadStoredBlocks?: LoadStoredBlocks;
  /** Required when a filter has `discoveredBy`: the addresses already indexed. */
  loadDiscoveredAddresses?: LoadDiscoveredAddresses;
  endpoints?: EndpointSelector;
  options?: LogStreamOptions;
}

/** Addresses per eth_getLogs request; a longer list is read in chunks. */
export const MAX_ADDRESSES_PER_GET_LOGS = 1_000;

async function fetchLogsForAddresses(
  rpc: RpcLike,
  args: {
    fromBlock: number;
    toBlock: number;
    addresses: Address[];
    suspectLogCount: number;
  },
): Promise<RawLog[]> {
  const logs: RawLog[] = [];
  for (let i = 0; i < args.addresses.length; i += MAX_ADDRESSES_PER_GET_LOGS) {
    logs.push(
      ...(await fetchLogsChecked(rpc, {
        ...args,
        addresses: args.addresses.slice(i, i + MAX_ADDRESSES_PER_GET_LOGS),
      })),
    );
  }
  for (const log of logs) {
    requireBlockInRange(
      hexToNumber(log.blockNumber),
      args.fromBlock,
      args.toBlock,
    );
    if (log.removed)
      throw new Error("eth_getLogs returned a removed log in a numbered range");
  }
  return logs;
}

const allDiscovered = (discovered: DiscoveredAddresses) =>
  [
    ...new Set([...discovered.values()].flatMap((set) => [...set])),
  ] as Address[];

/**
 * Addresses `after` holds that `before` does not, with the first block of
 * `logs` that names any of them.
 */
function newlyDiscovered(
  logs: RawLog[],
  filters: LogStreamFilter[],
  before: DiscoveredAddresses,
  after: DiscoveredAddresses,
): { addresses: Address[]; fromBlock: number } | undefined {
  const known = new Set(allDiscovered(before));
  const addresses = allDiscovered(after).filter((a) => !known.has(a));
  if (addresses.length === 0) return undefined;
  const fresh = new Set<string>(addresses);
  const sources = discoverySources(filters);
  const fromBlock = Math.min(
    ...logs
      .filter((log) =>
        sources.some((source) => fresh.has(namedAddress(log, source) ?? "")),
      )
      .map((log) => hexToNumber(log.blockNumber)),
  );
  return { addresses, fromBlock };
}

/**
 * Filters with `discoveredBy` follow contracts created on chain. Their
 * addresses join every range read: the indexed ones, loaded once, and those
 * named by a log the stream reads. An address named inside the range is read
 * again from the block that names it, which also captures its logs that
 * precede the naming event in that transaction.
 */
export async function loadKnownAddresses(
  filters: LogStreamFilter[],
  load: LoadDiscoveredAddresses | undefined,
): Promise<DiscoveredAddresses> {
  const sources = discoverySources(filters);
  if (sources.length === 0) return new Map();
  if (!load)
    throw new Error(
      "A log stream filter follows discovered addresses, but no loadDiscoveredAddresses was given to load those already indexed",
    );
  const loaded = new Map<string, Set<string>>();
  for (const source of sources)
    loaded.set(
      discoveredAddressSourceKey(source),
      new Set((await load(source)).map((a) => a.toLowerCase())),
    );
  return loaded;
}

function createDiscoveryTracker(
  filters: LogStreamFilter[],
  load: LoadDiscoveredAddresses | undefined,
) {
  let known: DiscoveredAddresses | undefined;
  return {
    async addresses(): Promise<DiscoveredAddresses> {
      return (known ??= await loadKnownAddresses(filters, load));
    },
    /** Monotonic: an address named on a later-orphaned block emits nothing. */
    remember(discovered: DiscoveredAddresses) {
      known = discovered;
    },
  };
}

export function createEvmAdapter(
  rpc: RpcLike,
  filters: LogStreamFilter[],
  suspectLogCount: number | (() => number),
  loadDiscoveredAddresses?: LoadDiscoveredAddresses,
): ChainAdapter<StreamLog> {
  const addresses = [
    ...new Set(
      filters
        .filter((f) => !f.discoveredBy)
        .map((f) => f.address.toLowerCase() as Address),
    ),
  ];
  if (addresses.length === 0) {
    throw new Error("createLogStream requires at least one filter");
  }
  const discovery = createDiscoveryTracker(filters, loadDiscoveredAddresses);
  const cap = () =>
    typeof suspectLogCount === "function" ? suspectLogCount() : suspectLogCount;

  return {
    label: "evm",
    fetchHead: () => fetchBlockByTag(rpc, "latest"),
    fetchFinalized: () => fetchBlockByTag(rpc, "finalized"),
    fetchBlock: (blockNumber) => fetchBlockByNumber(rpc, blockNumber),
    async readRange(from, to) {
      const known = await discovery.addresses();
      const logs = await fetchLogsForAddresses(rpc, {
        fromBlock: from,
        toBlock: to,
        addresses: [...addresses, ...allDiscovered(known)],
        suspectLogCount: cap(),
      });
      const discovered = discoverAddresses(logs, filters, known);
      const fresh = newlyDiscovered(logs, filters, known, discovered);
      if (fresh)
        logs.push(
          ...(await fetchLogsForAddresses(rpc, {
            fromBlock: fresh.fromBlock,
            toBlock: to,
            addresses: fresh.addresses,
            suspectLogCount: cap(),
          })),
        );
      const blocks = groupLogsByBlock(logs, filters, discovered);
      discovery.remember(discovered);
      return blocks;
    },
    async completeFresh(blocks, head) {
      await completeBlocks(rpc, blocks, head);
    },
  };
}

export function createLogStream(
  args: CreateLogStreamArgs,
): AsyncGenerator<StreamMessage> {
  const { suspectLogCount = EVM_DEFAULTS.suspectLogCount, ...options } =
    args.options ?? {};

  return createBlockStream<StreamLog>({
    adapter: createEvmAdapter(
      args.rpc,
      args.filters,
      suspectLogCount,
      args.loadDiscoveredAddresses,
    ),
    startingCursor: args.startingCursor,
    loadPreviousCursor: args.loadPreviousCursor,
    loadStoredBlocks: args.loadStoredBlocks,
    endpoints: args.endpoints,
    options,
  });
}
