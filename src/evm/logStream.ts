/**
 * A log-driven EVM stream.
 *
 * The stream this replaces asked the chain for one block header per block the
 * chain produced, so its cost scaled with block time rather than with how much
 * we actually index. On a 0.3 s chain that was ~9.7 requests per two-second
 * poll to deliver, almost always, nothing.
 *
 * Nothing in a header is needed to do this job. `eth_getLogs` already returns
 * `blockHash` and `blockTimestamp` on every log, which are the only two header
 * fields the runtime persists (`base_fee_per_gas` is written but read by
 * nothing, and rows for blocks with no events are deleted within a day by
 * `delete_old_empty_blocks`). So a poll is two requests regardless of block
 * rate: one `eth_getBlockByNumber("latest")` to learn the head and to give the
 * cursor a real hash, and one `eth_getLogs` over everything since the last one.
 *
 * Correctness notes, since missing an event is the failure that matters:
 *
 * - A range query is self-describing in a way a subscription is not. It either
 *   answers for the blocks asked for or it errors; a dropped WebSocket frame
 *   looks like silence. That is why this polls.
 * - The one way a range query lies is silent truncation: a provider that caps
 *   results and returns exactly the cap is indistinguishable from one that
 *   found exactly that many. `fetchLogsChecked` refuses to believe a response
 *   that lands on the cap and splits the range instead.
 * - Reorgs are detected by re-reading a window at the head every poll and
 *   diffing it against what was emitted, so a block whose hash changed or whose
 *   logs disappeared is caught even though no header was fetched. A reorg that
 *   touches no log of ours changes nothing we store, so it is not looked for.
 */
import type { Address, Hex, PublicClient } from "viem";
import { hexToBigInt, hexToNumber, numberToHex } from "viem";
import type { IndexerCursor } from "../_shared/dao";

/** A single processor's log filter, mirroring the shape the entrypoint builds. */
export interface LogStreamFilter {
  /** 1-based, matching the `filterIds` the block processors index into. */
  id: number;
  address: Address;
  topics: (Hex | null)[];
  /** When set, the log must carry exactly `topics.length` topics. */
  strict: boolean;
}

export interface LogStreamOptions {
  /** How long to wait after catching up to the head before polling again. */
  pollIntervalMs?: number;
  /** Widest block span to ask for in one `eth_getLogs`. */
  maxLogRangeBlocks?: number;
  /**
   * How far back to re-read at the head to notice a reorg. Must be at least the
   * deepest reorg the chain can produce; the cost of being generous is one
   * wider `eth_getLogs`, the cost of being stingy is a missed event.
   */
  reorgWindowBlocks?: number;
  /**
   * A log count that is suspected of being a provider's cap rather than a real
   * result. Set it to the provider's documented `eth_getLogs` limit.
   */
  suspectLogCount?: number;
  /** How often to re-read the `finalized` tag. */
  finalizedRefreshIntervalMs?: number;
  heartbeatIntervalMs?: number;
  onWarning?: (message: string, detail: Record<string, unknown>) => void;
}

const DEFAULTS = {
  pollIntervalMs: 2_000,
  maxLogRangeBlocks: 1_000,
  reorgWindowBlocks: 64,
  suspectLogCount: 10_000,
  finalizedRefreshIntervalMs: 30_000,
  heartbeatIntervalMs: 10_000,
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

/** The block shape the runtime's `parseEvmBlockHeader` expects. */
export interface StreamBlock {
  header: {
    blockNumber: bigint;
    blockHash: Hex;
    timestamp: Date;
    baseFeePerGas: bigint | null;
  };
  logs: {
    address: Address;
    topics: Hex[];
    data: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
    filterIds: number[];
  }[];
}

export type StreamMessage =
  | { _tag: "heartbeat" }
  | { _tag: "finalize"; finalize: { cursor: IndexerCursor } }
  | { _tag: "invalidate"; invalidate: { cursor: IndexerCursor } }
  | {
      _tag: "data";
      data: { endCursor: IndexerCursor; data: StreamBlock[] };
    };

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

/** Identity of a block as far as this stream is concerned. */
type BlockDigest = { hash: Hex; logCount: number };

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
  const byBlock = new Map<number, { block: StreamBlock; order: number[] }>();

  for (const log of logs) {
    if (log.removed) continue;

    const blockNumber = hexToNumber(log.blockNumber);
    const filterIds = matchingFilterIds(log, filters);
    if (filterIds.length === 0) continue;

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
        order: [],
      };
      byBlock.set(blockNumber, entry);
    }

    entry.block.logs.push({
      address: log.address,
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      transactionIndex: hexToNumber(log.transactionIndex),
      logIndex: hexToNumber(log.logIndex),
      filterIds,
    });
    entry.order.push(hexToNumber(log.logIndex));
  }

  return [...byBlock.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      entry.block.logs.sort((a, b) => a.logIndex - b.logIndex);
      return entry.block;
    });
}

/** Which blocks in a range carry logs, and under which hash. */
export function digestBlocks(blocks: StreamBlock[]): Map<number, BlockDigest> {
  const digests = new Map<number, BlockDigest>();
  for (const block of blocks) {
    digests.set(Number(block.header.blockNumber), {
      hash: block.header.blockHash,
      logCount: block.logs.length,
    });
  }
  return digests;
}

/**
 * The lowest block at which `next` disagrees with `previous`, or undefined when
 * they agree.
 *
 * Disagreement is a block that changed hash, a block that lost its logs, or a
 * block that gained logs it did not have. Only blocks inside `[from, to]` are
 * compared, because anything outside was not re-read.
 */
export function firstDivergentBlock(
  previous: Map<number, BlockDigest>,
  next: Map<number, BlockDigest>,
  from: number,
  to: number,
): number | undefined {
  let lowest: number | undefined;

  const consider = (blockNumber: number) => {
    if (blockNumber < from || blockNumber > to) return;
    const before = previous.get(blockNumber);
    const after = next.get(blockNumber);
    const same =
      before === undefined
        ? after === undefined
        : after !== undefined &&
          before.hash.toLowerCase() === after.hash.toLowerCase() &&
          before.logCount === after.logCount;
    if (!same && (lowest === undefined || blockNumber < lowest)) {
      lowest = blockNumber;
    }
  };

  for (const blockNumber of previous.keys()) consider(blockNumber);
  for (const blockNumber of next.keys()) consider(blockNumber);

  return lowest;
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

  const logs = (await rpc.request({
    method: "eth_getLogs",
    params: [
      {
        fromBlock: numberToHex(BigInt(fromBlock)),
        toBlock: numberToHex(BigInt(toBlock)),
        address: addresses,
      },
    ],
  } as never)) as unknown as RawLog[];

  if (logs.length < suspectLogCount) return logs;

  if (fromBlock === toBlock) {
    throw new Error(
      `eth_getLogs returned exactly ${logs.length} logs for the single block ${fromBlock}, which matches the configured provider cap. The response cannot be distinguished from a truncated one, so it is refused rather than indexed short.`,
    );
  }

  const middle = fromBlock + Math.floor((toBlock - fromBlock) / 2);
  const [left, right] = await Promise.all([
    fetchLogsChecked(rpc, { ...args, fromBlock, toBlock: middle }),
    fetchLogsChecked(rpc, { ...args, fromBlock: middle + 1, toBlock }),
  ]);
  return [...left, ...right];
}

type LatestBlock = {
  number: number;
  hash: Hex;
  timestamp: Date;
  baseFeePerGas: bigint | null;
};

async function fetchBlockByTag(
  rpc: RpcLike,
  tag: "latest" | "finalized",
): Promise<LatestBlock | null> {
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

export interface CreateLogStreamArgs {
  rpc: RpcLike;
  filters: LogStreamFilter[];
  startingCursor: IndexerCursor;
  options?: LogStreamOptions;
}

/** Everything the loop carries between iterations. */
interface StreamState {
  cursorBlock: number;
  /**
   * Digests of the log-bearing blocks inside the reorg window.
   *
   * Only blocks that carried logs belong here. A block with none has no
   * representation in an `eth_getLogs` response, so recording one would make it
   * look like it had disappeared on the very next re-read.
   */
  emitted: Map<number, BlockDigest>;
  finalized: LatestBlock | null;
  lastFinalizedRefresh: number;
  lastHeartbeat: number;
}

type Resolved = Required<Omit<LogStreamOptions, "onWarning">> &
  Pick<LogStreamOptions, "onWarning">;

/** The span to re-read: back into the window when near the head, else forward. */
function windowFor(
  state: StreamState,
  head: number,
  opts: Resolved,
): { from: number; to: number } {
  const nearHead = head - state.cursorBlock <= opts.reorgWindowBlocks;
  const earliest = (state.finalized?.number ?? 0) + 1;
  const start = nearHead
    ? Math.max(
        earliest,
        Math.min(state.cursorBlock + 1, head - opts.reorgWindowBlocks),
      )
    : state.cursorBlock + 1;
  const from = Math.max(1, start);
  return { from, to: Math.min(head, from + opts.maxLogRangeBlocks - 1) };
}

/** Drops window entries the re-read no longer covers. */
function forgetBelow(state: StreamState, keepFrom: number): void {
  for (const key of [...state.emitted.keys()]) {
    if (key < keepFrom) state.emitted.delete(key);
  }
}

function rollbackTo(state: StreamState, block: number): StreamMessage {
  for (const key of [...state.emitted.keys()]) {
    if (key >= block) state.emitted.delete(key);
  }
  state.cursorBlock = block - 1;
  return {
    _tag: "invalidate",
    invalidate: { cursor: { orderKey: BigInt(block - 1) } },
  };
}

function dataMessage(block: StreamBlock): StreamMessage {
  return {
    _tag: "data",
    data: {
      endCursor: {
        orderKey: block.header.blockNumber,
        uniqueKey: block.header.blockHash,
      },
      data: [block],
    },
  };
}

/**
 * Re-reads the `finalized` tag, at most once per configured interval.
 *
 * A finalized block never moves backwards, so an answer that does is a stale
 * view rather than a change to the chain. The stream this replaces threw on
 * that and crash-looped a worker roughly every eighty seconds.
 */
async function refreshFinalized(
  rpc: RpcLike,
  state: StreamState,
  opts: Resolved,
  now: number,
): Promise<StreamMessage | null> {
  if (now - state.lastFinalizedRefresh < opts.finalizedRefreshIntervalMs) {
    return null;
  }
  state.lastFinalizedRefresh = now;

  const finalized = await fetchBlockByTag(rpc, "finalized");
  if (!finalized) return null;

  if (state.finalized && finalized.number < state.finalized.number) {
    opts.onWarning?.("finalized block moved backwards; ignoring", {
      seen: finalized.number,
      held: state.finalized.number,
    });
    return null;
  }
  if (state.finalized && finalized.number === state.finalized.number) {
    return null;
  }

  state.finalized = finalized;
  return {
    _tag: "finalize",
    finalize: {
      cursor: { orderKey: BigInt(finalized.number), uniqueKey: finalized.hash },
    },
  };
}

/** Fills in a timestamp for the rare provider that omits `blockTimestamp`. */
async function requireTimestamps(
  rpc: RpcLike,
  blocks: StreamBlock[],
): Promise<void> {
  for (const block of blocks) {
    if (block.header.timestamp.getTime() !== 0) continue;
    const filled = await fetchBlockByNumber(
      rpc,
      Number(block.header.blockNumber),
    );
    if (!filled) {
      throw new Error(
        `Log for block ${block.header.blockNumber} carried no blockTimestamp and the block could not be read`,
      );
    }
    block.header.timestamp = filled.timestamp;
    block.header.baseFeePerGas = filled.baseFeePerGas;
  }
}

/** Reads a span of logs and summarises which blocks in it carry them. */
async function readWindow(
  rpc: RpcLike,
  args: { from: number; to: number; addresses: Address[] },
  filters: LogStreamFilter[],
  opts: Resolved,
): Promise<{ blocks: StreamBlock[]; digests: Map<number, BlockDigest> }> {
  const logs = await fetchLogsChecked(rpc, {
    fromBlock: args.from,
    toBlock: args.to,
    addresses: args.addresses,
    suspectLogCount: opts.suspectLogCount,
  });
  const blocks = groupLogsByBlock(logs, filters);
  return { blocks, digests: digestBlocks(blocks) };
}

function heartbeatIfDue(
  state: StreamState,
  opts: Resolved,
  now: number,
): StreamMessage | null {
  if (now - state.lastHeartbeat < opts.heartbeatIntervalMs) return null;
  state.lastHeartbeat = now;
  return { _tag: "heartbeat" };
}

/** The span to read this tick, or null when there is nothing to do yet. */
async function planRead(
  rpc: RpcLike,
  state: StreamState,
  opts: Resolved,
): Promise<{ from: number; to: number; head: LatestBlock } | null> {
  const head = await fetchBlockByTag(rpc, "latest");
  if (!head) return null;
  const { from, to } = windowFor(state, head.number, opts);
  return from > to ? null : { from, to, head };
}

/**
 * A rollback message when the re-read disagrees with what was already emitted.
 *
 * Divergence above the cursor is just a block being seen for the first time,
 * so only a disagreement at or below it is a reorg that needs undoing.
 */
function maybeRollback(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  plan: { from: number; to: number },
  opts: Resolved,
): StreamMessage | null {
  const divergent = firstDivergentBlock(
    state.emitted,
    digests,
    plan.from,
    plan.to,
  );
  if (divergent === undefined || divergent > state.cursorBlock) return null;
  opts.onWarning?.("reorg detected", { block: divergent });
  return rollbackTo(state, divergent);
}

/**
 * The trailing block that moves the cursor to the end of the span.
 *
 * Without it a quiet chain would re-read the same blocks forever, since the
 * runtime only advances its cursor on a data message. The head's own header is
 * already in hand; any other endpoint costs one read.
 */
async function tailMessage(
  rpc: RpcLike,
  fresh: StreamBlock[],
  plan: { to: number; head: LatestBlock },
): Promise<StreamMessage | null> {
  const last = fresh.at(-1);
  if (last && Number(last.header.blockNumber) >= plan.to) return null;

  const tail =
    plan.to === plan.head.number
      ? plan.head
      : await fetchBlockByNumber(rpc, plan.to);
  if (!tail) return null;

  return dataMessage({
    header: {
      blockNumber: BigInt(tail.number),
      blockHash: tail.hash,
      timestamp: tail.timestamp,
      baseFeePerGas: tail.baseFeePerGas,
    },
    logs: [],
  });
}

function initStream({
  filters,
  startingCursor,
  options = {},
}: Omit<CreateLogStreamArgs, "rpc">): {
  opts: Resolved;
  addresses: Address[];
  state: StreamState;
} {
  const addresses = [
    ...new Set(filters.map((f) => f.address.toLowerCase() as Address)),
  ];
  if (addresses.length === 0) {
    throw new Error("createLogStream requires at least one filter");
  }

  return {
    opts: { ...DEFAULTS, ...options },
    addresses,
    state: {
      cursorBlock: Number(startingCursor.orderKey),
      emitted: new Map(),
      finalized: null,
      lastFinalizedRefresh: 0,
      lastHeartbeat: Date.now(),
    },
  };
}

/** Records each block in the reorg window and yields it downstream. */
async function* emitFresh(
  state: StreamState,
  fresh: StreamBlock[],
): AsyncGenerator<StreamMessage> {
  for (const block of fresh) {
    state.emitted.set(Number(block.header.blockNumber), {
      hash: block.header.blockHash,
      logCount: block.logs.length,
    });
    state.lastHeartbeat = Date.now();
    yield dataMessage(block);
  }
}

/** Advances the cursor and forgets what the reorg window no longer covers. */
function finishTick(
  state: StreamState,
  plan: { to: number },
  opts: Resolved,
): void {
  state.cursorBlock = plan.to;
  const earliest = (state.finalized?.number ?? 0) + 1;
  forgetBelow(
    state,
    Math.max(earliest, state.cursorBlock - opts.reorgWindowBlocks),
  );
}

/**
 * Yields the same messages the previous stream did, so the runtime, the DAO and
 * every processor are untouched.
 */
export async function* createLogStream(
  args: CreateLogStreamArgs,
): AsyncGenerator<StreamMessage> {
  const { rpc, filters } = args;
  const { opts, addresses, state } = initStream(args);

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  while (true) {
    const now = Date.now();

    const heartbeat = heartbeatIfDue(state, opts, now);
    if (heartbeat) yield heartbeat;

    const finalize = await refreshFinalized(rpc, state, opts, now);
    if (finalize) yield finalize;

    const plan = await planRead(rpc, state, opts);
    if (!plan) {
      await sleep(opts.pollIntervalMs);
      continue;
    }

    const { blocks, digests } = await readWindow(
      rpc,
      { from: plan.from, to: plan.to, addresses },
      filters,
      opts,
    );

    const rollback = maybeRollback(state, digests, plan, opts);
    if (rollback) {
      yield rollback;
      continue;
    }

    const fresh = blocks.filter(
      (block) => Number(block.header.blockNumber) > state.cursorBlock,
    );
    await requireTimestamps(rpc, fresh);
    yield* emitFresh(state, fresh);

    const tail = await tailMessage(rpc, fresh, plan);
    if (tail) yield tail;

    finishTick(state, plan, opts);

    if (plan.to >= plan.head.number) await sleep(opts.pollIntervalMs);
  }
}

async function fetchBlockByNumber(
  rpc: RpcLike,
  blockNumber: number,
): Promise<LatestBlock | null> {
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
