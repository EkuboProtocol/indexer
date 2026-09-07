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
    // The other half of the same problem. A provider at its limit either
    // truncates silently (handled below) or refuses the range outright;
    // Alchemy does the latter, so on Alchemy this is the branch that runs.
    // Splitting is the only response that makes progress -- retrying the same
    // span would just fail again, and the worker would restart into it forever.
    //
    // Only when the server actually answered, though. A timeout or a 429 says
    // nothing about the range, and bisecting one would turn a single transient
    // failure into hundreds of requests aimed at an endpoint that just asked us
    // to slow down. A JSON-RPC error carries a numeric `code`; a transport
    // failure does not.
    const answered = typeof (error as { code?: unknown }).code === "number";
    if (!answered || fromBlock === toBlock) throw error;
    return splitRange(rpc, args);
  }

  if (logs.length < suspectLogCount) return logs;

  if (fromBlock === toBlock) {
    throw new Error(
      `eth_getLogs returned exactly ${logs.length} logs for the single block ${fromBlock}, which matches the configured provider cap. The response cannot be distinguished from a truncated one, so it is refused rather than indexed short.`,
    );
  }

  return splitRange(rpc, args);
}

/** Halves a span and reads both sides. */
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
  /** Highest finalized block already announced downstream, 0 before the first. */
  finalizedEmitted: number;
  lastHeartbeat: number;
  /** Hash of the head as of the last completed read, "" before the first. */
  lastHeadHash: string;
  /**
   * False until the first window has been read.
   *
   * `emitted` starts empty because nothing has been observed yet, not because
   * the chain is empty, so the first read seeds it instead of diffing against
   * it. Restart safety comes from the cursor hash check instead, which is both
   * cheaper and stronger: a block hash commits to its whole ancestry.
   */
  seeded: boolean;
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
  // Never start above the cursor. `earliest` is an optimisation -- a finalized
  // block cannot reorg, so there is no point re-reading below it -- but on a
  // chain that finalises in under a second it can overtake a cursor that fell a
  // few blocks behind, and letting it raise `from` would skip those blocks
  // silently.
  const start = nearHead
    ? Math.min(
        state.cursorBlock + 1,
        Math.max(earliest, head - opts.reorgWindowBlocks),
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
  state.finalized = finalized;

  // Never announce a finalized block ahead of the cursor. The runtime's own
  // recovery path resets the cursor to the last finalized one, so a finalized
  // cursor past ours would move it *forward* on the next unhandled error and
  // skip every block in between. Holding it back only ever costs a re-index.
  if (
    finalized.number > state.cursorBlock ||
    finalized.number <= state.finalizedEmitted
  ) {
    return null;
  }

  state.finalizedEmitted = finalized.number;
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

/**
 * True when this poll's head is the one the last read already covered.
 *
 * An identical head means an identical chain, so the window cannot have changed
 * and re-reading it would buy nothing. This is where the cost stops scaling with
 * block time: on a 12 s chain polled every 2 s it skips five reads in six, and
 * `eth_getLogs` is 60 of the 80 compute units a poll costs.
 */
function headUnchanged(state: StreamState, head: LatestBlock): boolean {
  return (
    state.seeded &&
    head.number === state.cursorBlock &&
    head.hash === state.lastHeadHash
  );
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
 * Reconciles a freshly read window against what was already emitted.
 *
 * The first read is adopted as the baseline; every read after it is a diff, and
 * a disagreement at or below the cursor is a reorg to undo.
 */
function reconcileWindow(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  plan: { from: number; to: number },
  opts: Resolved,
): StreamMessage | null {
  if (!state.seeded) {
    seedWindow(state, digests);
    return null;
  }
  return maybeRollback(state, digests, plan, opts);
}

/**
 * Adopts the first window read as the baseline rather than diffing against it.
 *
 * Only blocks at or below the cursor are taken; anything above is new and is
 * recorded as it is emitted. Without this, a restart within the reorg window
 * would find every log-bearing block in it "missing" from an empty map and roll
 * the chain back on every deploy.
 */
function seedWindow(
  state: StreamState,
  digests: Map<number, BlockDigest>,
): void {
  for (const [blockNumber, digest] of digests) {
    if (blockNumber <= state.cursorBlock) state.emitted.set(blockNumber, digest);
  }
  state.seeded = true;
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
  state: StreamState,
  fresh: StreamBlock[],
  plan: { to: number; head: LatestBlock },
): Promise<StreamMessage | null> {
  // Once caught up, the span ends where the cursor already is. Emitting it
  // again would cost a write transaction per poll on every chain forever,
  // moving nothing.
  if (plan.to <= state.cursorBlock) return null;

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
      finalizedEmitted: 0,
      lastHeartbeat: Date.now(),
      lastHeadHash: "",
      seeded: false,
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
  plan: { to: number; head: LatestBlock },
  opts: Resolved,
): void {
  state.cursorBlock = plan.to;
  state.lastHeadHash = plan.head.hash;
  const earliest = (state.finalized?.number ?? 0) + 1;
  forgetBelow(
    state,
    Math.max(earliest, state.cursorBlock - opts.reorgWindowBlocks),
  );
}

/**
 * Rolls back when the block the stored cursor names is no longer canonical.
 *
 * The stream this replaces checked this on every start, and the runtime's
 * reorg-retry loop exists to catch its failure. A log diff cannot replace it: a
 * reorg during downtime leaves nothing to disagree with, since the window is
 * seeded from whatever the chain says now. One `eth_getBlockByNumber` at
 * startup settles it for the whole ancestry, because a block hash commits to
 * every block beneath it.
 */
async function checkStartingCursor(
  rpc: RpcLike,
  state: StreamState,
  startingCursor: IndexerCursor,
  opts: Resolved,
): Promise<StreamMessage | null> {
  const expected = startingCursor.uniqueKey;
  if (typeof expected !== "string" || state.cursorBlock <= 0) return null;

  const block = await fetchBlockByNumber(rpc, state.cursorBlock);
  // An absent block is a pruned or lagging node answering, not a reorg. Reading
  // forward from an unverified cursor is the safe failure: it re-reads.
  if (!block) return null;

  // The stored key round-trips through a numeric column, so leading zeroes are
  // gone by the time it comes back. Compare the values, not the strings.
  if (BigInt(block.hash) === BigInt(expected)) return null;

  // A finalized block cannot be the reorg point, so there is no reason to
  // rewind past one -- and every reason not to, since the rows below it are
  // settled. Costs one request, and only on the branch that already found a
  // mismatch.
  const finalized = await fetchBlockByTag(rpc, "finalized");
  const floor = finalized ? finalized.number + 1 : 1;
  // Never past the cursor itself: if even the finalized block disagrees, the
  // least we can do is re-read the block we are standing on rather than skip it.
  const target = Math.min(
    state.cursorBlock,
    Math.max(floor, 1, state.cursorBlock - opts.reorgWindowBlocks),
  );
  opts.onWarning?.("stored cursor is not canonical; rolling back", {
    block: state.cursorBlock,
    expected,
    found: block.hash,
    rollbackTo: target - 1,
  });
  return rollbackTo(state, target);
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

  const notCanonical = await checkStartingCursor(
    rpc,
    state,
    args.startingCursor,
    opts,
  );
  if (notCanonical) yield notCanonical;

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

    if (headUnchanged(state, plan.head)) {
      await sleep(opts.pollIntervalMs);
      continue;
    }

    const { blocks, digests } = await readWindow(
      rpc,
      { from: plan.from, to: plan.to, addresses },
      filters,
      opts,
    );

    const rollback = reconcileWindow(state, digests, plan, opts);
    if (rollback) {
      yield rollback;
      continue;
    }

    const fresh = blocks.filter(
      (block) => Number(block.header.blockNumber) > state.cursorBlock,
    );
    await requireTimestamps(rpc, fresh);
    yield* emitFresh(state, fresh);

    const tail = await tailMessage(rpc, state, fresh, plan);
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
