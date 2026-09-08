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
 * What that leaves is a cost that no longer scales with block time but still
 * scales with nothing at all: eighty compute units per poll on every chain,
 * whether it produced an event or has produced none in four months. Most of the
 * chains we index are the latter, so `pollIntervalFor` backs the interval off
 * while a chain indexes nothing and snaps it back to the floor the moment it
 * does. Backing off is a delay and never a miss -- a range query asked less
 * often reads a wider range, not a narrower one.
 *
 * Nothing here is sized in blocks. A block is not a unit of time and the chains
 * we index run from 10 s to 0.09 s apart, so any constant expressed as a block
 * count means something different on each one -- the 64-block reorg window this
 * used to carry bought Ethereum 640 s of protection and Robinhood, the busiest
 * chain we run, six. The window is configured in seconds and converted per
 * chain from a block rate measured off the head reads the poll already makes
 * (`observeBlockRate`), and the backoff ceiling is bounded by what one
 * `eth_getLogs` can actually drain at that rate. The only block count left is
 * `maxLogRangeBlocks`, which is a real provider limit rather than a guess about
 * the chain.
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
  /**
   * The ceiling `pollIntervalMs` backs off to on a chain that is producing
   * nothing we index. Set it equal to `pollIntervalMs` to disable backoff.
   */
  maxPollIntervalMs?: number;
  /**
   * How many consecutive polls may find nothing before the interval starts
   * growing. This is the latency guarantee: a chain that indexed anything
   * within the last `pollIntervalMs * quietPollsBeforeBackoff` keeps polling at
   * full rate.
   */
  quietPollsBeforeBackoff?: number;
  /** Widest block span to ask for in one `eth_getLogs`. */
  maxLogRangeBlocks?: number;
  /**
   * How far back to re-read at the head to notice a reorg, in seconds of chain
   * time. Must be at least as long as the deepest reorg the chain can produce;
   * the cost of being generous is one wider `eth_getLogs`, which is free, and
   * the cost of being stingy is a missed event.
   *
   * In seconds rather than blocks because a block is not a unit of anything.
   * The chains we index run from 10 s to 0.09 s a block, so one block count
   * means two very different amounts of history: at the 64 blocks this used to
   * default to, Ethereum got 640 s of protection and Robinhood -- the busiest
   * chain we run -- got 6. The equivalent block count is derived per chain from
   * the observed block rate.
   */
  reorgWindowSeconds?: number;
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
  maxPollIntervalMs: 30_000,
  quietPollsBeforeBackoff: 30,
  maxLogRangeBlocks: 1_000,
  reorgWindowSeconds: 120,
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
  const byBlock = new Map<number, { block: StreamBlock }>();

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
      };
      byBlock.set(blockNumber, entry);
    }

    entry.block.logs.push({
      address: log.address,
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      transactionIndex: hexToNumber(log.transactionIndex),
      logIndex: requireRepresentableIndex(
        hexToNumber(log.logIndex),
        blockNumber,
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

/** Packed into 16 bits by `compute_event_id`, so this is a hard ceiling. */
const MAX_EVENT_INDEX = 65_536;

/**
 * Fails loudly, and early, on a log index `compute_event_id` cannot represent.
 *
 * `evm.ts` uses a log's block-wide `logIndex` as its `event_index`, because the
 * apibara RPC stream this replaces never populated `logIndexInTransaction`
 * either. `compute_event_id` packs that index into 16 bits and raises above
 * 65,535, so a block carrying more logs than that -- counting every contract's,
 * not only ours -- cannot be indexed under this scheme at all.
 *
 * That limitation is inherited, not introduced here, and this deliberately does
 * not change the numbering: `event_id` is a primary key that other tables order
 * on, so re-basing it belongs in its own change rather than riding along with a
 * stream rewrite. What this does is convert a confusing failure deep in a
 * Postgres function into one that names the cause at the point of origin.
 */
function requireRepresentableIndex(logIndex: number, blockNumber: number) {
  if (logIndex >= MAX_EVENT_INDEX) {
    throw new Error(
      `Block ${blockNumber} contains a log at index ${logIndex}, which compute_event_id cannot represent (the limit is ${MAX_EVENT_INDEX}). event_index is the block-wide log index, so a block with more than that many logs in total cannot be indexed without re-basing event_id onto a per-transaction index.`,
    );
  }
  return logIndex;
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
   * Consecutive caught-up polls that indexed nothing, which is what the poll
   * interval backs off on. Reset to 0 by anything worth being fast for.
   */
  quietPolls: number;
  /**
   * Observed blocks per second, or null until enough of the chain has gone by
   * to measure it. Every sizing decision that would otherwise be a block count
   * goes through this.
   */
  blockRate: number | null;
  /** The older end of the interval `blockRate` is measured over. */
  rateSample: { number: number; timeSec: number } | null;
  /** Effective window last warned about, so the cap is reported once. */
  warnedCapSeconds: number | null;
  /**
   * Lowest block `emitted` is authoritative for.
   *
   * Below this the map is silent because entries were pruned, not because the
   * chain had nothing -- and those two are indistinguishable to a diff.
   */
  retainedFrom: number;
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

/**
 * Chain time that must elapse before a block-rate sample is believed.
 *
 * Block timestamps have one-second resolution, and Robinhood produces eleven
 * blocks inside one of those, so a short baseline measures rounding rather than
 * the chain. Thirty seconds is long enough that the quantisation is noise on
 * every chain we index and short enough to be learnt within one backoff cycle.
 */
const MIN_RATE_SAMPLE_SECONDS = 30;

/**
 * Updates the observed block rate from a head this poll already fetched.
 *
 * Free: `eth_getBlockByNumber("latest")` returns the number and the timestamp
 * together, and the stream reads it every poll anyway. No request is made for
 * this, which is the only reason it is worth measuring continuously rather than
 * configuring per chain.
 */
export function observeBlockRate(state: StreamState, head: LatestBlock): void {
  const timeSec = Math.floor(head.timestamp.getTime() / 1000);
  const sample = state.rateSample;

  if (!sample) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  const elapsed = timeSec - sample.timeSec;
  const advanced = head.number - sample.number;

  // A head that went backwards, or a timestamp that did, means the sample is
  // measuring a different view of the chain rather than its rate. Start over.
  if (elapsed < 0 || advanced < 0) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  if (elapsed < MIN_RATE_SAMPLE_SECONDS) {
    // A partial baseline is too short to measure the rate, but it can still
    // *witness* a chain going faster than the stored rate says -- and adopting
    // that early is free while waiting is not. Everything the rate sizes is
    // safe wide and unsafe narrow: the window re-reads more blocks (one
    // `eth_getLogs` either way) and the backoff sleeps less. So a rise is taken
    // on the spot and only a fall waits for a full baseline.
    //
    // Without this the stream keeps a stale, lower rate for up to
    // MIN_RATE_SAMPLE_SECONDS after a chain speeds up -- a sequencer catching
    // up after downtime is the realistic case -- and blocks emitted in that
    // window can land further below the cursor than the window reaches.
    // `advanced > 0` matters: a null rate makes the comparison below adopt
    // anything, so a tip replaced at the same height by a block with a later
    // timestamp would store a rate of zero and collapse the window to a single
    // block. This branch only ever wants to raise the rate; zero is not a rise.
    // Only ever a *rise*, and only against a rate we already trust.
    //
    // Adopting a short sample when the rate is unset would be a narrowing, not
    // a rise: an unset rate already sizes the window at the cap, the widest
    // available. A first sample quantised to one second on an eleven-block
    // chain can read half the true rate, which would halve the window for the
    // next thirty seconds on exactly the argument that short samples cannot be
    // trusted.
    if (state.blockRate !== null && elapsed > 0 && advanced > 0) {
      const witnessed = advanced / elapsed;
      if (witnessed > state.blockRate) state.blockRate = witnessed;
    }
    return;
  }

  // A full baseline that saw no blocks is a halted chain, not a rate of zero.
  // Dividing anyway stores 0, and `reorgWindowBlocksFor` turns that into a
  // one-block window -- so the poll that has to reconcile the reorg that
  // *resumes* the chain would re-read a single block. Keep the last known rate
  // and start a fresh sample.
  if (advanced <= 0) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  state.blockRate = advanced / elapsed;
  state.rateSample = { number: head.number, timeSec };
}

/**
 * How many blocks `reorgWindowSeconds` is worth on this chain right now.
 *
 * Capped at half `maxLogRangeBlocks`, which is what makes an unusable
 * configuration unreachable rather than merely rejected. A read span no wider
 * than the window it re-reads cannot reach past it: nothing is emitted, the
 * cursor never advances, and because the span never reaches the head the loop
 * never sleeps -- it spins at CPU speed issuing two requests a turn while
 * looking perfectly healthy. Holding the window at half the span guarantees at
 * least half the span is forward progress, whatever the chain does.
 *
 * Before the rate is known the window is that cap. Erring wide is free -- one
 * `eth_getLogs` is 60 compute units for any span it accepts -- and erring
 * narrow silently loses events, so the unmeasured case takes the widest window
 * on offer and narrows as the chain is observed.
 */
/**
 * The widest window `reorgWindowBlocksFor` can ever return for this span.
 *
 * Half the span, which is what guarantees the other half is forward progress.
 * Load-bearing beyond sizing a read: it is also how far back `emitted` has to
 * be retained, since a window that grows must not scan blocks the last tick
 * forgot.
 */
export function maxReorgWindowBlocks(
  opts: Pick<Resolved, "maxLogRangeBlocks">,
): number {
  return Math.max(1, Math.floor(opts.maxLogRangeBlocks / 2));
}

export function reorgWindowBlocksFor(
  state: Pick<StreamState, "blockRate">,
  opts: Pick<Resolved, "reorgWindowSeconds" | "maxLogRangeBlocks">,
): number {
  const cap = maxReorgWindowBlocks(opts);
  if (state.blockRate === null) return cap;
  return Math.min(
    cap,
    Math.max(1, Math.ceil(state.blockRate * opts.reorgWindowSeconds)),
  );
}

/**
 * Says once, not every poll, that the span is holding the window narrower than
 * `reorgWindowSeconds` asked for.
 *
 * Deliberately separate from `reorgWindowBlocksFor`, which several call sites
 * hit more than once per tick -- `windowFor`, `finishTick`, `pollIntervalFor`
 * and the finalized refresh all size themselves from it. A warning in there is
 * four identical lines per poll forever on any chain where the cap binds, which
 * is how a real signal becomes noise nobody reads.
 *
 * Not an error: the stream is still correct, just protected for less history
 * than requested. Worth saying at all because the remedy is one env var --
 * GET_LOGS_RANGE_SIZE bounds it, and raising it is free up to the provider's
 * own range limit.
 */
function warnIfWindowCapped(state: StreamState, opts: Resolved): void {
  const rate = state.blockRate;
  if (rate === null) return;

  const cap = maxReorgWindowBlocks(opts);
  const wanted = Math.max(1, Math.ceil(rate * opts.reorgWindowSeconds));
  if (wanted <= cap) return;

  // Re-warn only when the shortfall actually changes, so a chain whose rate
  // drifts says so again while a steady one says it once.
  const effectiveSeconds = Math.round(cap / rate);
  if (state.warnedCapSeconds === effectiveSeconds) return;
  state.warnedCapSeconds = effectiveSeconds;

  opts.onWarning?.("reorg window capped by the log range size", {
    wantedBlocks: wanted,
    cappedToBlocks: cap,
    effectiveSeconds,
    reorgWindowSeconds: opts.reorgWindowSeconds,
    maxLogRangeBlocks: opts.maxLogRangeBlocks,
  });
}

/** The span to re-read: back into the reorg window, or forward when behind it. */
function windowFor(
  state: StreamState,
  head: number,
  opts: Resolved,
): { from: number; to: number } {
  const earliest = (state.finalized?.number ?? 0) + 1;
  // The window hangs below the cursor, not below the head, and it is re-read
  // unconditionally. Both of those matter once the poll interval can grow.
  //
  // This used to read back from `head - reorgWindowBlocks`, and only when the
  // head was within that distance of the cursor; otherwise it read straight
  // forward from the cursor. The reasoning was that a cursor further back than
  // the window is catching up and has nothing recently emitted to protect. At a
  // two-second poll that held on every chain we index -- the head is always a
  // few blocks ahead -- so the forward-only branch belonged to backfill alone.
  //
  // Backing off to thirty seconds breaks the assumption in both parts. An L2 at
  // four blocks a second advances ~120 blocks between polls, so a caught-up
  // stream is permanently "further back than the window": it would take the
  // forward branch forever and never re-read a block it had already emitted,
  // silently giving up reorg detection on exactly the chains whose finality
  // lags furthest behind their head. Anchoring to the head instead of the
  // cursor has the same hole, because `head - reorgWindowBlocks` then sits
  // above the cursor and the `min` below collapses to `cursorBlock + 1`.
  //
  // Anchoring to the cursor is what actually re-reads the blocks at risk: they
  // are the ones *we emitted*, which is a fact about the cursor and nothing
  // else. It costs no compute units -- `eth_getLogs` is billed per request, so
  // a wider span is the same 60 units -- and slows a backfill by the window as
  // a fraction of the span, since each read now overlaps the last by the width
  // of the window. That fraction is at most a half, and is whatever
  // `reorgWindowSeconds` works out to on this chain once the rate is known.
  //
  // Never start above the cursor. `earliest` is an optimisation -- a finalized
  // block cannot reorg, so there is no point re-reading below it -- but on a
  // chain that finalises in under a second it can overtake a cursor that fell a
  // few blocks behind, and letting it raise `from` would skip those blocks
  // silently.
  const from = Math.max(
    1,
    Math.min(
      state.cursorBlock + 1,
      Math.max(
        earliest,
        state.cursorBlock + 1 - reorgWindowBlocksFor(state, opts),
      ),
    ),
  );
  return { from, to: Math.min(head, from + opts.maxLogRangeBlocks - 1) };
}

/** Drops window entries the re-read no longer covers. */
function forgetBelow(state: StreamState, keepFrom: number): void {
  for (const key of [...state.emitted.keys()]) {
    if (key < keepFrom) state.emitted.delete(key);
  }
  // Only ever rises. What was pruned cannot be un-pruned, so this is the record
  // of how far down the map can still be trusted.
  state.retainedFrom = Math.max(state.retainedFrom, keepFrom);
}

function rollbackTo(state: StreamState, block: number): StreamMessage {
  for (const key of [...state.emitted.keys()]) {
    if (key >= block) state.emitted.delete(key);
  }
  state.cursorBlock = block - 1;

  // Carry the hash when the block we land on is one we recorded. Without it the
  // stored cursor has no `unique_key`, and a restart in the window between this
  // rollback and the next data message would skip the canonicality check
  // entirely -- right after the one event that makes it worth doing. Only
  // log-bearing blocks are in `emitted`, so this is best-effort by nature.
  const landing = state.emitted.get(block - 1);

  return {
    _tag: "invalidate",
    invalidate: {
      cursor: {
        orderKey: BigInt(block - 1),
        ...(landing ? { uniqueKey: landing.hash } : {}),
      },
    },
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
): Promise<void> {
  // Scaled by the effective poll interval, not fixed. At the floor this is the
  // configured thirty seconds; at a thirty-second backoff a fixed interval
  // would fire on every single poll, and its twenty compute units would be a
  // fifth of what a quiet chain costs -- turning a 93% saving into a 76% one.
  // A staler finalized block on a dormant chain buys back nothing worth having:
  // it only widens the re-read, which is free, and slows `finalized_order_key`,
  // which nothing on such a chain is waiting for.
  const due = Math.max(
    opts.finalizedRefreshIntervalMs,
    pollIntervalFor(state, opts) * 4,
  );
  if (now - state.lastFinalizedRefresh < due) {
    return;
  }
  state.lastFinalizedRefresh = now;

  // Tolerated, not fatal. The finalized block is an optimisation here -- a floor
  // on the re-read and a cursor to announce -- so a node that cannot answer for
  // it should cost us that optimisation, not the worker. Without this catch the
  // `withNullBlockRetry` wrapper turns a null answer into a throw that escapes
  // the generator every thirty seconds and exits the process.
  const finalized = await fetchBlockByTag(rpc, "finalized").catch(
    (error: unknown) => {
      opts.onWarning?.("could not read the finalized block", {
        error: String(error).slice(0, 200),
      });
      return null;
    },
  );
  if (!finalized) return;

  if (state.finalized && finalized.number < state.finalized.number) {
    opts.onWarning?.("finalized block moved backwards; ignoring", {
      seen: finalized.number,
      held: state.finalized.number,
    });
    return;
  }
  state.finalized = finalized;
}

/**
 * Refreshes the finalized block when due, then announces it if the cursor has
 * reached it. `now` of null skips the refresh and only re-checks.
 */
async function* announceFinalized(
  rpc: RpcLike,
  state: StreamState,
  opts: Resolved,
  now: number | null,
): AsyncGenerator<StreamMessage> {
  if (now !== null) await refreshFinalized(rpc, state, opts, now);
  const message = finalizeIfDue(state);
  if (message) yield message;
}

/**
 * Announces the finalized block, once the cursor has actually reached it.
 *
 * Never ahead of the cursor: the runtime's recovery path resets the cursor to
 * the last finalized one, so a finalized cursor past ours would move it
 * *forward* on the next unhandled error and skip everything between.
 *
 * Which is why this is a separate step rather than part of the refresh. The
 * refresh happens at the top of a tick, when the cursor still holds last tick's
 * value; on a chain that finalises within a block or two of the head, that stale
 * cursor is always behind the finalized block and the message would be
 * suppressed forever, leaving `finalized_order_key` frozen and the runtime with
 * nothing to recover to. Checking after the cursor advances is what makes the
 * hold-back a delay rather than a permanent mute.
 */
function finalizeIfDue(state: StreamState): StreamMessage | null {
  const finalized = state.finalized;
  if (
    !finalized ||
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
 * How long to sleep before the next poll, given how long the chain has been
 * quiet.
 *
 * The cost of this stream is polls times eighty compute units, and it does not
 * care whether a poll found anything: `eth_getLogs` is billed per request, so a
 * chain that has never emitted an event costs exactly what the busiest one
 * does. That is the whole bill on a deployment like ours, where most chains are
 * indexed for completeness rather than volume.
 *
 * So the interval tracks whether the chain is doing anything we index. It holds
 * at the floor for `quietPollsBeforeBackoff` consecutive empty polls -- the
 * latency guarantee, and the reason a busy chain never notices this exists --
 * then doubles per empty poll up to `maxPollIntervalMs`. Anything worth being
 * fast for puts it straight back to the floor.
 *
 * Backing off is only ever a delay, never a miss: `eth_getLogs` answers for a
 * block range, so a wider gap between polls means a wider range, not a gap in
 * what is read. The worst case is noticing the first event on a dormant chain
 * up to `maxPollIntervalMs` late, after which the chain is at the floor again
 * for at least `quietPollsBeforeBackoff` polls.
 */
export function pollIntervalFor(
  state: Pick<StreamState, "quietPolls" | "blockRate">,
  opts: Pick<
    Resolved,
    | "pollIntervalMs"
    | "maxPollIntervalMs"
    | "quietPollsBeforeBackoff"
    | "maxLogRangeBlocks"
    | "reorgWindowSeconds"
  >,
): number {
  const floor = opts.pollIntervalMs;

  // The ceiling is whichever is lower: what was configured, and what one
  // `eth_getLogs` can actually drain.
  //
  // A poll has to read every block produced since the last one, and it can only
  // ask for `maxLogRangeBlocks` at a time, of which the reorg window is re-read
  // rather than new. Sleep for longer than the remainder takes to accumulate
  // and the stream never catches up in a single read: it stops sleeping, reads
  // spans back to back, and pays more compute units than it saved. Where that
  // line falls is a fact about the chain's block rate, so it is derived from
  // the measured one rather than assumed -- 30 s is 3 blocks on Ethereum and
  // 329 on Robinhood.
  const drain = opts.maxLogRangeBlocks - reorgWindowBlocksFor(state, opts);
  const rate = state.blockRate;
  const drainCeiling =
    rate !== null && rate > 0 ? (drain / rate) * 1_000 : Number.POSITIVE_INFINITY;
  const ceiling = Math.max(floor, Math.min(opts.maxPollIntervalMs, drainCeiling));

  const over = state.quietPolls - opts.quietPollsBeforeBackoff;
  if (over <= 0) return floor;
  // Cap the exponent before it is applied. `2 ** 1024` is Infinity, and a
  // chain quiet for a week would get there; `Math.min` would still return the
  // ceiling, but the intermediate is a trap for anyone reworking this line.
  const doubled = floor * 2 ** Math.min(over, 32);
  return Math.min(ceiling, doubled);
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
  // Before `windowFor`, which sizes itself from the rate this updates.
  observeBlockRate(state, head);
  warnIfWindowCapped(state, opts);
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
  // Never diff below what `emitted` still holds.
  //
  // "I have no record of this block" and "this block is new" are the same
  // observation to `firstDivergentBlock` -- `before === undefined,
  // after !== undefined` -- and one of them is a reorg while the other is
  // bookkeeping. The scan can reach below the retention floor whenever the
  // cursor moves *down*, which is exactly what `rollbackTo` does: it skips
  // `finishTick`, so a real reorg lowers the cursor without lowering the floor,
  // and the next cursor-anchored scan starts a full window below where the last
  // prune assumed. Every log-bearing block in the gap then reads as diverged,
  // `rollbackTo` clears the remainder of the map, and the next tick diffs
  // against nothing -- the cursor walks down to `earliest` on a chain that
  // reorged exactly once.
  //
  // Flooring the comparison is what makes that structurally impossible, rather
  // than merely unlikely at the current window widths. Blocks below the floor
  // are older than a full window beneath a cursor we have already passed, which
  // is the depth this stream does not claim to protect anyway.
  const divergent = firstDivergentBlock(
    state.emitted,
    digests,
    Math.max(plan.from, state.retainedFrom),
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
    seedWindow(state, digests, plan.from);
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
  from: number,
): void {
  for (const [blockNumber, digest] of digests) {
    if (blockNumber <= state.cursorBlock) state.emitted.set(blockNumber, digest);
  }
  // The seed read is the first thing `emitted` knows anything about, so it is
  // where the authoritative range begins.
  state.retainedFrom = from;
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

  const opts: Resolved = { ...DEFAULTS, ...options };

  // The window used to be a block count that could be configured wider than the
  // span that has to contain it, which spins the loop -- so the constructor
  // refused it. `reorgWindowBlocksFor` now caps the window at half the span, so
  // there is no such configuration to refuse: forward progress is at least half
  // of `maxLogRangeBlocks` whatever the chain's block rate turns out to be.
  // What remains is the degenerate span, which no cap can rescue.
  if (opts.maxLogRangeBlocks < 2) {
    throw new Error(
      `GET_LOGS_RANGE_SIZE (${opts.maxLogRangeBlocks}) must be at least 2, otherwise a poll cannot both re-read a block and read a new one.`,
    );
  }

  return {
    opts,
    addresses,
    state: {
      cursorBlock: Number(startingCursor.orderKey),
      emitted: new Map(),
      finalized: null,
      lastFinalizedRefresh: 0,
      finalizedEmitted: 0,
      lastHeartbeat: Date.now(),
      lastHeadHash: "",
      quietPolls: 0,
      blockRate: null,
      rateSample: null,
      warnedCapSeconds: null,
      retainedFrom: 0,
      seeded: false,
    },
  };
}

/**
 * Gives the head block its own base fee, which this poll already fetched.
 *
 * `eth_getLogs` carries no base fee, so a log-derived block has none. That is
 * honest for blocks below the head -- we genuinely do not know theirs, and
 * nothing stores it now that 00127 drops `blocks.base_fee_per_gas`; the DAO
 * coalesces a null rather than blanking the head column with it.
 *
 * The head is the exception: when the last block read is the head itself, this
 * poll's `eth_getBlockByNumber("latest")` already holds its real base fee, so
 * the block can carry its true value at no cost. That is what keeps
 * `indexer_cursor.head_base_fee_per_gas` -- which quoter-service reads to price
 * gas -- both fresh and never null.
 */
function stampHeadBaseFee(blocks: StreamBlock[], head: LatestBlock): void {
  for (const block of blocks) {
    if (Number(block.header.blockNumber) === head.number) {
      block.header.baseFeePerGas = head.baseFeePerGas;
    }
  }
}

/** Records each block in the reorg window and yields it downstream. */
async function* emitFresh(
  state: StreamState,
  fresh: StreamBlock[],
): AsyncGenerator<StreamMessage> {
  // Any matched log means the chain is in use, so drop straight back to the
  // floor. `groupLogsByBlock` keeps only blocks carrying a log one of our
  // filters matched, so a non-empty `fresh` is exactly "we indexed something".
  if (fresh.length > 0) state.quietPolls = 0;

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
  // Never backwards. An endpoint that momentarily answers `latest` with a block
  // behind the cursor yields a valid-looking plan that ends below it, and
  // assigning that would rewind the in-memory cursor with no `invalidate` and no
  // warning, re-emitting blocks already indexed. A rollback is the only thing
  // allowed to move the cursor back, and it says so.
  state.cursorBlock = Math.max(state.cursorBlock, plan.to);
  state.lastHeadHash = plan.head.hash;
  const earliest = (state.finalized?.number ?? 0) + 1;
  // Retain to the widest window any later tick could scan, not to this tick's.
  //
  // The window is measured, so it grows when the chain speeds up. Forgetting to
  // the current width means the next tick -- whose `windowFor` may have just
  // re-measured wider -- scans blocks that were dropped from `emitted` a moment
  // ago. `firstDivergentBlock` cannot tell "I forgot this" from "this block is
  // new below my cursor": it sees `before === undefined, after !== undefined`
  // and reports a reorg. `rollbackTo` then clears every remaining entry, so the
  // next tick diffs against an empty map and rolls back again, walking the
  // cursor backwards a window at a time until `earliest` floors it. Measured on
  // a chain whose hashes were pure functions of block number, so nothing ever
  // reorged: 34 invalidates, ~30 blocks each. Ethereum at 640 s is squarely in
  // range -- one missed slot inside a sample swings the window by ~18 blocks.
  //
  // `reorgWindowBlocksFor` is bounded by half the span, so that bound is the
  // widest scan possible and retaining to it is sufficient. `emitted` holds
  // only log-bearing blocks, so the extra entries cost nothing.
  forgetBelow(
    state,
    Math.max(earliest, state.cursorBlock - maxReorgWindowBlocks(opts)),
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

  // An absent or unreadable block is a pruned or lagging node answering, not a
  // reorg, and `withNullBlockRetry` surfaces the null case as a throw. Reading
  // forward from an unverified cursor is the safe failure -- it re-reads -- and
  // is far better than crash-looping a worker whose node cannot serve the block.
  const block = await fetchBlockByNumber(rpc, state.cursorBlock).catch(
    (error: unknown) => {
      opts.onWarning?.("could not verify the stored cursor", {
        block: state.cursorBlock,
        error: String(error).slice(0, 200),
      });
      return null;
    },
  );
  if (!block) return null;

  // The stored key round-trips through a numeric column, so leading zeroes are
  // gone by the time it comes back. Compare the values, not the strings.
  if (BigInt(block.hash) === BigInt(expected)) return null;

  // A finalized block cannot be the reorg point, so there is no reason to
  // rewind past one -- and every reason not to, since the rows below it are
  // settled. Costs one request, and only on the branch that already found a
  // mismatch.
  // Tolerated the same way `refreshFinalized` tolerates it, and for a sharper
  // reason: this line is only reached once the cursor is already known to be
  // non-canonical. Letting it throw would exit before the `invalidate` is
  // emitted, and the restart would land on this same branch again -- a crash
  // loop precisely where recovery is what is needed.
  const finalized = await fetchBlockByTag(rpc, "finalized").catch(
    (error: unknown) => {
      opts.onWarning?.("could not read the finalized block while rolling back", {
        error: String(error).slice(0, 200),
      });
      return null;
    },
  );
  // Seed the rate from the two blocks already in hand, at no extra cost.
  //
  // This runs before the loop, so without it `state.blockRate` is null here and
  // the window is the half-span cap -- 500 blocks by default and 2500 on
  // Arbitrum and Robinhood, against the 64 this used to rewind. `finalized + 1`
  // floors it, so that only bites on a node that cannot serve the finalized tag
  // (which this function already tolerates), but there it means deleting and
  // reprocessing thousands of blocks on a cursor that moved by one.
  //
  // The cursor block and the finalized block are separated by the chain's
  // finality lag, which is a far longer baseline than the loop's 30 s sample
  // ever gets.
  if (finalized) {
    const elapsedSec = Math.floor(
      (block.timestamp.getTime() - finalized.timestamp.getTime()) / 1000,
    );
    const advanced = block.number - finalized.number;
    if (elapsedSec >= MIN_RATE_SAMPLE_SECONDS && advanced > 0) {
      state.blockRate = advanced / elapsedSec;
    }
  }

  const floor = finalized ? finalized.number + 1 : 1;
  // Never past the cursor itself: if even the finalized block disagrees, the
  // least we can do is re-read the block we are standing on rather than skip it.
  const target = Math.min(
    state.cursorBlock,
    Math.max(floor, 1, state.cursorBlock - reorgWindowBlocksFor(state, opts)),
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

    yield* announceFinalized(rpc, state, opts, now);

    const plan = await planRead(rpc, state, opts);
    if (!plan) {
      // An unreadable head is not evidence the chain is quiet, so this does not
      // count towards backoff -- but it must not poll a struggling endpoint
      // faster than a healthy one either, so it sleeps for the interval already
      // in force.
      await sleep(pollIntervalFor(state, opts));
      continue;
    }

    if (headUnchanged(state, plan.head)) {
      // The head has not moved, so there is provably nothing new to index: a
      // head hash commits to its whole ancestry. That is a quiet poll in the
      // sense that matters, and counting it is what lets a chain with a block
      // time longer than the poll interval back off at all.
      state.quietPolls++;
      await sleep(pollIntervalFor(state, opts));
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
      // A reorg is the last moment to be slow: the blocks being rolled back
      // have to be re-read and re-emitted before the chain is correct again.
      state.quietPolls = 0;
      // An endpoint serving two views alternately would otherwise rollback,
      // re-read and rollback again with no pause between, one DB transaction per
      // turn. Back off exactly as the caught-up path does.
      await sleep(opts.pollIntervalMs);
      continue;
    }

    const fresh = blocks.filter(
      (block) => Number(block.header.blockNumber) > state.cursorBlock,
    );
    await requireTimestamps(rpc, fresh);
    stampHeadBaseFee(fresh, plan.head);
    yield* emitFresh(state, fresh);

    const tail = await tailMessage(rpc, state, fresh, plan);
    if (tail) yield tail;

    finishTick(state, plan, opts);

    // Now that the cursor has moved, the finalized block may be behind it.
    yield* announceFinalized(rpc, state, opts, null);

    // Only a caught-up poll can be a quiet one. While catching up the loop does
    // not sleep at all, and counting those polls would let a long backfill --
    // which is all empty ranges until it reaches the interesting blocks -- back
    // the stream off just as it arrives at the head.
    if (plan.to >= plan.head.number) {
      if (fresh.length === 0) state.quietPolls++;
      await sleep(pollIntervalFor(state, opts));
    }
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
