import type { Hex } from "viem";
import type { IndexerCursor } from "./dao";
import {
  readSnapshot,
  requireHeader,
  sameHash,
  StaleSnapshotError,
} from "./blockSnapshot";
import { commonStoredCursor, type LoadPreviousCursor } from "./cursorRecovery";

export type ChainHead = {
  number: number;
  hash: Hex;
  timestamp: Date;
  baseFeePerGas: bigint | null;
};

export type BlockDigest = { hash: Hex; logCount: number };

export interface StreamBlock<TEvent> {
  header: {
    blockNumber: bigint;
    blockHash: Hex;
    timestamp: Date;
    baseFeePerGas: bigint | null;
  };
  logs: TEvent[];
}

export type StreamMessage<TEvent> =
  | { _tag: "heartbeat" }
  | { _tag: "finalize"; finalize: { cursor: IndexerCursor } }
  | { _tag: "invalidate"; invalidate: { cursor: IndexerCursor } }
  | {
      _tag: "data";
      data: { endCursor: IndexerCursor; data: StreamBlock<TEvent>[] };
    };

export interface ChainAdapter<TEvent> {
  readonly label: string;

  fetchHead(): Promise<ChainHead | null>;

  fetchBlock(blockNumber: number): Promise<ChainHead | null>;

  fetchFinalized(): Promise<ChainHead | null>;

  /**
   * Every event we match in `[from, to]`, grouped into blocks in ascending
   * block order, events within a block in the order they were emitted.
   *
   * Must refuse rather than truncate. Blocks carrying no matched event must be
   * omitted entirely -- a block with none has no representation in a filtered
   * range read, so recording one would make it look like it had disappeared on
   * the very next re-read.
   */
  readRange(
    from: number,
    to: number,
    endHash?: Hex,
  ): Promise<StreamBlock<TEvent>[]>;

  /**
   * Fills in whatever `readRange` could not carry, for fresh blocks only.
   *
   * Must not change how many events a block holds. The diff compares the count
   * recorded when a block was emitted against the count the next `readRange`
   * reports, so a completion step that added or dropped one would manufacture a
   * reorg on every single poll.
   */
  completeFresh(blocks: StreamBlock<TEvent>[], head: ChainHead): Promise<void>;
}

export interface TickSignal {
  cursorBlock: number;
  lastReadFailed: boolean;
  lastHead: ChainHead | null;
}

export interface EndpointSelector {
  beforeTick(signal: TickSignal): Promise<boolean>;
}

export interface BlockStreamOptions {
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  quietPollsBeforeBackoff?: number;
  maxLogRangeBlocks?: number;
  reorgWindowSeconds?: number;
  finalizedRefreshIntervalMs?: number;
  heartbeatIntervalMs?: number;
  providerOutageBudgetMs?: number;
  onWarning?: (message: string, detail: Record<string, unknown>) => void;
}

export const BLOCK_STREAM_DEFAULTS = {
  pollIntervalMs: 2_000,
  maxPollIntervalMs: 30_000,
  quietPollsBeforeBackoff: 30,
  maxLogRangeBlocks: 1_000,
  reorgWindowSeconds: 120,
  finalizedRefreshIntervalMs: 30_000,
  heartbeatIntervalMs: 10_000,
  providerOutageBudgetMs: 10 * 60_000,
} as const;

export type Resolved = Required<Omit<BlockStreamOptions, "onWarning">> &
  Pick<BlockStreamOptions, "onWarning">;

export interface StreamState {
  cursorBlock: number;
  cursorHash: string | null;
  /**
   * Digests of the event-bearing blocks inside the reorg window.
   *
   * Only blocks that carried events belong here. A block with none has no
   * representation in a filtered range read, so recording one would make it
   * look like it had disappeared on the very next re-read.
   */
  emitted: Map<number, BlockDigest>;
  finalized: ChainHead | null;
  pendingFinalized: ChainHead | null;
  lastFinalizedRefresh: number;
  finalizedEmitted: number;
  lastHeartbeat: number;
  lastHeadHash: string;
  quietPolls: number;
  blockRate: number | null;
  rateSample: { number: number; timeSec: number } | null;
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
  staleSnapshots: number;
  failedReads: number;
  failingSince: number | null;
  lastReadFailed: boolean;
  lastHead: ChainHead | null;
}

export const MAX_EVENT_INDEX = 65_536;

/**
 * Fails loudly, and early, on an event index `compute_event_id` cannot hold.
 *
 * `compute_event_id` packs the index into 16 bits and raises above 65,535, so a
 * block whose numbering reaches that cannot be indexed under this scheme at
 * all. Which number is being packed differs by chain -- EVM uses the block-wide
 * log index, Starknet the index within its transaction -- and that difference
 * is inherited from the streams these replace, not introduced here. Re-basing
 * `event_id` is a migration, not a stream change.
 *
 * What this does is convert a confusing failure deep in a Postgres function
 * into one that names the cause at the point of origin.
 */
export function requireRepresentableIndex(
  eventIndex: number,
  blockNumber: number,
  numbering: string,
): number {
  if (
    !Number.isSafeInteger(eventIndex) ||
    eventIndex < 0 ||
    eventIndex >= MAX_EVENT_INDEX
  ) {
    throw new Error(
      `Block ${blockNumber} contains an event at index ${eventIndex}, which compute_event_id cannot represent (the limit is ${MAX_EVENT_INDEX}). event_index is ${numbering}, so a block reaching that many cannot be indexed without re-basing event_id.`,
    );
  }
  return eventIndex;
}

export function digestBlocks<TEvent>(
  blocks: StreamBlock<TEvent>[],
): Map<number, BlockDigest> {
  const digests = new Map<number, BlockDigest>();
  for (const block of blocks) {
    digests.set(Number(block.header.blockNumber), {
      hash: block.header.blockHash,
      logCount: block.logs.length,
    });
  }
  return digests;
}

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

export const MIN_RATE_SAMPLE_SECONDS = 30;

export function observeBlockRate(
  state: StreamState,
  head: Pick<ChainHead, "number" | "timestamp">,
): void {
  const timeSec = Math.floor(head.timestamp.getTime() / 1000);
  const sample = state.rateSample;
  if (!sample) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  const elapsed = timeSec - sample.timeSec;
  const advanced = head.number - sample.number;
  if (elapsed < 0 || advanced < 0) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  if (elapsed < MIN_RATE_SAMPLE_SECONDS) {
    // Rise-only, and only against a rate already trusted. A short baseline can
    // prove the chain is at least this fast -- blocks did arrive -- but cannot
    // prove it is slow, because the interval may simply have been rounded.
    if (state.blockRate !== null && elapsed > 0 && advanced > 0) {
      const witnessed = advanced / elapsed;
      if (witnessed > state.blockRate) state.blockRate = witnessed;
    }
    return;
  }

  // A full baseline that saw no blocks is a halted chain, not a rate of zero.
  // Treating it as zero would make every derived window infinite.
  if (advanced <= 0) {
    state.rateSample = { number: head.number, timeSec };
    return;
  }

  state.blockRate = advanced / elapsed;
  state.rateSample = { number: head.number, timeSec };
}

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
 * Before the rate is known the window is that cap. Erring wide is free -- a
 * range read is billed per request, so a wider span is the same cost -- and
 * erring narrow needs more stored-history recovery, so the unmeasured case takes the widest
 * window on offer and narrows as the chain is observed.
 */
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

function warnIfWindowCapped(state: StreamState, opts: Resolved): void {
  const rate = state.blockRate;
  if (rate === null) return;

  const cap = maxReorgWindowBlocks(opts);
  const wanted = Math.max(1, Math.ceil(rate * opts.reorgWindowSeconds));
  if (wanted <= cap) return;

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
  // else. It costs no compute units -- a range read is billed per request, so
  // a wider span is the same price -- and slows a backfill by the window as
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

function forgetBelow(state: StreamState, keepFrom: number): void {
  for (const key of [...state.emitted.keys()]) {
    if (key < keepFrom) state.emitted.delete(key);
  }
  state.retainedFrom = Math.max(state.retainedFrom, keepFrom);
}

function rollbackTo<TEvent>(
  state: StreamState,
  block: number,
): StreamMessage<TEvent> {
  for (const key of [...state.emitted.keys()]) {
    if (key >= block) state.emitted.delete(key);
  }
  state.cursorBlock = block - 1;

  // Carry the hash when the block we land on is one we recorded. Without it the
  // stored cursor has no `unique_key`, and a restart in the window between this
  // rollback and the next data message would skip the canonicality check
  // entirely -- right after the one event that makes it worth doing. Only
  // event-bearing blocks are in `emitted`, so this is best-effort by nature.
  const landing = state.emitted.get(block - 1);
  state.cursorHash = landing?.hash ?? null;

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

function dataMessage<TEvent>(
  block: StreamBlock<TEvent>,
): StreamMessage<TEvent> {
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
 * Re-reads the finalized block, at most once per configured interval.
 *
 * A finalized block never moves backwards, so an answer that does is a stale
 * view rather than a change to the chain. The stream this replaces threw on
 * that and crash-looped a worker roughly every eighty seconds.
 */
async function refreshFinalized<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  opts: Resolved,
  now: number,
): Promise<void> {
  // Scaled by the effective poll interval, not fixed. At the floor this is the
  // configured thirty seconds; at a thirty-second backoff a fixed interval
  // would fire on every single poll, and its compute units would be a
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

  const finalized = await adapter.fetchFinalized().catch((error: unknown) => {
    opts.onWarning?.("could not read the finalized block", {
      error: String(error).slice(0, 200),
    });
    return null;
  });
  if (!finalized) return;

  const held = state.pendingFinalized ?? state.finalized;
  if (held && finalized.number < held.number) {
    opts.onWarning?.("finalized block moved backwards; ignoring", {
      seen: finalized.number,
      held: held.number,
    });
    return;
  }
  state.pendingFinalized = finalized;
}

/**
 * Accept observed finality only after reconciling with the previous read floor.
 * A block may have reorged before becoming finalized between two polls. Using
 * the new floor to plan that read would hide the divergence permanently.
 * Also hold it back while catching up, until its history has been indexed.
 */
async function* announceFinalized<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  reconciledThrough: number,
): AsyncGenerator<StreamMessage<TEvent>> {
  const pending = state.pendingFinalized;
  if (
    pending &&
    pending.number <= state.cursorBlock &&
    reconciledThrough >= state.cursorBlock
  ) {
    const canonical = requireHeader(
      await adapter.fetchBlock(pending.number),
      pending.number,
    );
    if (!sameHash(canonical.hash, pending.hash))
      throw new Error("Finalized block disagrees with the canonical chain");
    state.finalized = pending;
    state.pendingFinalized = null;
  }
  const message = finalizeIfDue<TEvent>(state);
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
function finalizeIfDue<TEvent>(
  state: StreamState,
): StreamMessage<TEvent> | null {
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

function* heartbeatIfDue<TEvent>(
  state: StreamState,
  opts: Resolved,
  now: number,
): Generator<StreamMessage<TEvent>> {
  if (now - state.lastHeartbeat < opts.heartbeatIntervalMs) return;
  state.lastHeartbeat = now;
  yield { _tag: "heartbeat" };
}

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
  // range read can actually drain.
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
    rate !== null && rate > 0
      ? (drain / rate) * 1_000
      : Number.POSITIVE_INFINITY;
  const ceiling = Math.max(
    floor,
    Math.min(opts.maxPollIntervalMs, drainCeiling),
  );

  const over = state.quietPolls - opts.quietPollsBeforeBackoff;
  if (over <= 0) return floor;
  // Cap the exponent before it is applied. `2 ** 1024` is Infinity, and a
  // chain quiet for a week would get there; `Math.min` would still return the
  // ceiling, but the intermediate is a trap for anyone reworking this line.
  const doubled = floor * 2 ** Math.min(over, 32);
  return Math.min(ceiling, doubled);
}

function headUnchanged(state: StreamState, head: ChainHead): boolean {
  return (
    state.seeded &&
    head.number === state.cursorBlock &&
    head.hash === state.lastHeadHash
  );
}

async function planRead<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  opts: Resolved,
): Promise<{ from: number; to: number; head: ChainHead } | null> {
  const head = await adapter.fetchHead();
  if (!head) return null;
  state.lastHead = head;
  observeBlockRate(state, head);
  warnIfWindowCapped(state, opts);
  const { from, to } = windowFor(state, head.number, opts);
  return from > to ? null : { from, to, head };
}

function maybeRollback<TEvent>(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  plan: { from: number; to: number },
  opts: Resolved,
): StreamMessage<TEvent> | null {
  // Never diff below what `emitted` still holds.
  //
  // "I have no record of this block" and "this block is new" are the same
  // observation to `firstDivergentBlock` -- `before === undefined,
  // after !== undefined` -- and one of them is a reorg while the other is
  // bookkeeping. The scan can reach below the retention floor whenever the
  // cursor moves *down*, which is exactly what `rollbackTo` does: it skips
  // `finishTick`, so a real reorg lowers the cursor without lowering the floor,
  // and the next cursor-anchored scan starts a full window below where the last
  // prune assumed. Every event-bearing block in the gap then reads as diverged,
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
  return rollbackTo<TEvent>(state, divergent);
}

async function reconcileWindow<TEvent>(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  plan: { from: number; to: number },
  opts: Resolved,
  loadStoredBlocks?: LoadStoredBlocks,
): Promise<StreamMessage<TEvent> | null> {
  if (!state.seeded) {
    seedWindow(state, digests, plan.from);
    return loadStoredBlocks
      ? verifySeedAgainstStore<TEvent>(
          state,
          digests,
          plan,
          opts,
          loadStoredBlocks,
        )
      : null;
  }
  return maybeRollback<TEvent>(state, digests, plan, opts);
}

/**
 * Event-bearing blocks the consumer has durably stored, by hash, and the lowest
 * block that answer is authoritative for.
 *
 * `from` exists because a store only vouches for what it indexed: below the
 * operator's starting boundary the chain has events the store never took, and
 * reading that as a gap would rewind a fresh database past its own start.
 */
export type LoadStoredBlocks = (
  from: number,
  to: number,
) => Promise<{ from: number; hashes: Map<number, string> }>;

/**
 * The lowest block at or below the cursor that carries events on chain but is
 * missing from the store, or stored under another hash.
 *
 * One-sided on purpose. A stored block the chain no longer reports is also
 * what removing an address from the filters looks like, and rolling back on
 * that would delete history for a configuration change. An orphan the chain
 * *does* report is caught by the hash comparison.
 */
export function firstUnstoredBlock(
  digests: Map<number, BlockDigest>,
  stored: Map<number, string>,
  from: number,
  to: number,
): number | undefined {
  let lowest: number | undefined;
  for (const [blockNumber, digest] of digests) {
    if (blockNumber < from || blockNumber > to) continue;
    const hash = stored.get(blockNumber);
    if (hash !== undefined && sameHash(hash, digest.hash)) continue;
    if (lowest === undefined || blockNumber < lowest) lowest = blockNumber;
  }
  return lowest;
}

/**
 * Checks the seed read against what the consumer actually stored.
 *
 * `seedWindow` adopts the chain's view of the window as "already emitted",
 * which is right for a stream that emitted it and wrong for one that did not.
 * A block that was never written -- a provider whose log index lagged its head
 * for one read, a process that died between the miss and the re-read that
 * would have caught it -- is indistinguishable from an emitted one after a
 * restart, and the gap becomes permanent. The cursor-hash check cannot see it
 * either: the cursor is canonical, only a block beneath it is absent.
 *
 * Ethereum block 25739240 was lost this way under the stream this replaced,
 * whose empty head header advanced the stored cursor without advancing its
 * own. Comparing against the store on every start is what makes any such gap
 * inside the window self-healing instead of silent.
 */
async function verifySeedAgainstStore<TEvent>(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  plan: { from: number; to: number },
  opts: Resolved,
  loadStoredBlocks: LoadStoredBlocks,
): Promise<StreamMessage<TEvent> | null> {
  const to = Math.min(plan.to, state.cursorBlock);
  if (to < plan.from) return null;
  const stored = await loadStoredBlocks(plan.from, to);
  const missing = firstUnstoredBlock(
    digests,
    stored.hashes,
    Math.max(plan.from, stored.from),
    to,
  );
  if (missing === undefined) return null;
  opts.onWarning?.(
    "stored history is missing an event-bearing block; rolling back",
    {
      block: missing,
      cursor: state.cursorBlock,
    },
  );
  return rollbackTo<TEvent>(state, missing);
}

function seedWindow(
  state: StreamState,
  digests: Map<number, BlockDigest>,
  from: number,
): void {
  for (const [blockNumber, digest] of digests) {
    if (blockNumber <= state.cursorBlock)
      state.emitted.set(blockNumber, digest);
  }
  state.retainedFrom = from;
  state.seeded = true;
}

function tailMessage<TEvent>(
  state: StreamState,
  fresh: StreamBlock<TEvent>[],
  anchor: ChainHead,
): StreamMessage<TEvent> | null {
  if (anchor.number <= state.cursorBlock) return null;
  const last = fresh.at(-1);
  if (last && Number(last.header.blockNumber) === anchor.number) return null;
  return dataMessage<TEvent>({
    header: {
      blockNumber: BigInt(anchor.number),
      blockHash: anchor.hash,
      timestamp: anchor.timestamp,
      baseFeePerGas: anchor.baseFeePerGas,
    },
    logs: [],
  });
}

export function initStreamState(
  startingCursor: IndexerCursor,
  options: BlockStreamOptions = {},
): { opts: Resolved; state: StreamState } {
  const opts: Resolved = { ...BLOCK_STREAM_DEFAULTS, ...options };

  for (const [name, value] of Object.entries(opts)) {
    if (name === "onWarning") continue;
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  const cursorNumber = Number(startingCursor.orderKey);
  if (!Number.isSafeInteger(cursorNumber) || cursorNumber < 0) {
    throw new Error("Starting cursor must be a non-negative safe integer");
  }

  if (opts.maxLogRangeBlocks < 2) {
    throw new Error(
      `GET_LOGS_RANGE_SIZE (${opts.maxLogRangeBlocks}) must be at least 2, otherwise a poll cannot both re-read a block and read a new one.`,
    );
  }

  return {
    opts,
    state: {
      cursorBlock: Number(startingCursor.orderKey),
      cursorHash:
        typeof startingCursor.uniqueKey === "string"
          ? startingCursor.uniqueKey
          : null,
      emitted: new Map(),
      finalized: null,
      pendingFinalized: null,
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
      staleSnapshots: 0,
      failedReads: 0,
      failingSince: null,
      lastReadFailed: false,
      lastHead: null,
    },
  };
}

async function* emitFresh<TEvent>(
  state: StreamState,
  fresh: StreamBlock<TEvent>[],
): AsyncGenerator<StreamMessage<TEvent>> {
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

function finishTick(
  state: StreamState,
  plan: { to: number; head: ChainHead },
  opts: Resolved,
): void {
  // Never backwards. An endpoint that momentarily answers with a head behind
  // the cursor yields a valid-looking plan that ends below it, and assigning
  // that would rewind the in-memory cursor with no `invalidate` and no warning,
  // re-emitting blocks already indexed. A rollback is the only thing allowed to
  // move the cursor back, and it says so.
  state.cursorBlock = Math.max(state.cursorBlock, plan.to);
  if (plan.to >= state.cursorBlock) state.cursorHash = plan.head.hash;
  state.lastHeadHash = state.cursorHash ?? "";
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
  // only event-bearing blocks, so the extra entries cost nothing.
  forgetBelow(
    state,
    Math.max(earliest, state.cursorBlock - maxReorgWindowBlocks(opts)),
  );
}

async function checkStartingCursor<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  startingCursor: IndexerCursor,
  opts: Resolved,
  loadPreviousCursor?: LoadPreviousCursor,
): Promise<StreamMessage<TEvent> | null> {
  if (state.cursorBlock <= 0) return null;
  const expected = startingCursor.uniqueKey;
  if (typeof expected !== "string" && !loadPreviousCursor) return null;
  const block = await adapter.fetchBlock(state.cursorBlock);
  if (!block || block.number !== state.cursorBlock) {
    throw new Error(
      `Could not verify the stored cursor at block ${state.cursorBlock}`,
    );
  }
  if (typeof expected === "string" && BigInt(block.hash) === BigInt(expected))
    return null;

  const cursor = await commonStoredCursor(
    adapter,
    state.cursorBlock + 1,
    loadPreviousCursor,
  );
  opts.onWarning?.(
    "stored cursor is not canonical; rolling back to verified history",
    {
      block: state.cursorBlock,
      expected,
      found: block.hash,
      rollbackTo: Number(cursor.orderKey),
    },
  );
  rollbackTo<TEvent>(state, Number(cursor.orderKey) + 1);
  state.cursorHash =
    typeof cursor.uniqueKey === "string" ? cursor.uniqueKey : null;
  return { _tag: "invalidate", invalidate: { cursor } };
}

async function reconcileSnapshot<T>(
  args: CreateBlockStreamArgs<T>,
  state: StreamState,
  snapshot: { blocks: StreamBlock<T>[]; cursorChanged: boolean },
  plan: { from: number; to: number },
  opts: Resolved,
): Promise<StreamMessage<T> | null> {
  const digests = digestBlocks(snapshot.blocks);
  if (!snapshot.cursorChanged) {
    return reconcileWindow<T>(
      state,
      digests,
      plan,
      opts,
      args.loadStoredBlocks,
    );
  }

  // A matching stored block proves the whole ancestry beneath it, even when
  // the actual fork point is deeper than the configured polling window.
  const common = [...state.emitted.entries()]
    .reverse()
    .find(([number, old]) => {
      const next = digests.get(number);
      return (
        next && sameHash(old.hash, next.hash) && old.logCount === next.logCount
      );
    });
  if (common) return rollbackTo<T>(state, common[0] + 1);

  const cursor = await commonStoredCursor(
    args.adapter,
    state.cursorBlock + 1,
    args.loadPreviousCursor,
    state.finalized,
  );
  rollbackTo<T>(state, Number(cursor.orderKey) + 1);
  state.cursorHash =
    typeof cursor.uniqueKey === "string" ? cursor.uniqueKey : null;
  return { _tag: "invalidate", invalidate: { cursor } };
}

export const MAX_STALE_SNAPSHOTS = 30;

/**
 * `readSnapshot`, or null when the snapshot went stale and should be re-planned.
 *
 * Nothing from a stale snapshot has been emitted, so re-planning from a fresh
 * head is the whole recovery. Exiting instead restarted the Starknet worker
 * about once a minute at the tip. A streak this long is not the tip, though.
 */
async function readFreshSnapshot<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  plan: { from: number; to: number; head: ChainHead },
  opts: Resolved,
): Promise<Awaited<ReturnType<typeof readSnapshot<TEvent>>> | null> {
  try {
    const snapshot = await readSnapshot(adapter, plan, {
      number: state.cursorBlock,
      hash: state.cursorHash,
    });
    state.staleSnapshots = 0;
    return snapshot;
  } catch (error) {
    if (
      !(error instanceof StaleSnapshotError) ||
      ++state.staleSnapshots > MAX_STALE_SNAPSHOTS
    ) {
      throw error;
    }
    opts.onWarning?.("retrying a stale snapshot", {
      head: plan.head.number,
      attempt: state.staleSnapshots,
      reason: error.message,
    });
    return null;
  }
}

function backOffAfterReadFailure(
  state: StreamState,
  opts: Resolved,
  error: unknown,
  context: Record<string, unknown>,
): number {
  if (error instanceof StaleSnapshotError) throw error;
  const now = Date.now();
  state.failingSince ??= now;
  if (now - state.failingSince > opts.providerOutageBudgetMs) throw error;
  state.failedReads++;
  state.lastReadFailed = true;
  const delay = Math.max(
    opts.pollIntervalMs,
    Math.min(
      opts.maxPollIntervalMs,
      opts.pollIntervalMs * 2 ** Math.min(state.failedReads - 1, 32),
    ),
  );
  opts.onWarning?.("provider read failed; backing off", {
    ...context,
    attempt: state.failedReads,
    failingForMs: now - state.failingSince,
    retryInMs: delay,
    error: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
  });
  return delay;
}

function clearReadFailures(state: StreamState): void {
  state.failedReads = 0;
  state.failingSince = null;
  state.lastReadFailed = false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function planOrWait<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  opts: Resolved,
): Promise<{ from: number; to: number; head: ChainHead } | null> {
  try {
    const plan = await planRead(adapter, state, opts);
    // An unreadable head is not evidence the chain is quiet, so this does not
    // count towards backoff -- but it must not poll a struggling endpoint
    // faster than a healthy one either, so it sleeps for the interval already
    // in force.
    if (!plan) await sleep(pollIntervalFor(state, opts));
    return plan;
  } catch (error) {
    await sleep(
      backOffAfterReadFailure(state, opts, error, {
        read: "head",
        cursor: state.cursorBlock,
      }),
    );
    return null;
  }
}

async function snapshotOrWait<TEvent>(
  adapter: ChainAdapter<TEvent>,
  state: StreamState,
  plan: { from: number; to: number; head: ChainHead },
  opts: Resolved,
): Promise<Awaited<ReturnType<typeof readSnapshot<TEvent>>> | null> {
  try {
    const snapshot = await readFreshSnapshot(adapter, state, plan, opts);
    if (!snapshot) await sleep(opts.pollIntervalMs);
    return snapshot;
  } catch (error) {
    await sleep(
      backOffAfterReadFailure(state, opts, error, {
        read: "range",
        from: plan.from,
        to: plan.to,
        head: plan.head.number,
        cursor: state.cursorBlock,
      }),
    );
    return null;
  }
}

/**
 * Lets the selector switch endpoints, and forgets what only the old one said.
 *
 * `lastReadFailed` described the old endpoint, so it is cleared too; the
 * failure streak and its budget carry on, since the outage has not ended just
 * because the endpoint changed.
 */
async function selectEndpoint<TEvent>(
  args: CreateBlockStreamArgs<TEvent>,
  state: StreamState,
): Promise<void> {
  if (!args.endpoints) return;
  const switched = await args.endpoints.beforeTick({
    cursorBlock: state.cursorBlock,
    lastReadFailed: state.lastReadFailed,
    lastHead: state.lastHead,
  });
  if (switched) {
    state.lastHead = null;
    state.lastReadFailed = false;
  }
}

async function verifiedStart<TEvent>(
  args: CreateBlockStreamArgs<TEvent>,
  state: StreamState,
  opts: Resolved,
): Promise<StreamMessage<TEvent> | null> {
  for (;;) {
    await selectEndpoint(args, state);
    try {
      const message = await checkStartingCursor(
        args.adapter,
        state,
        args.startingCursor,
        opts,
        args.loadPreviousCursor,
      );
      clearReadFailures(state);
      return message;
    } catch (error) {
      await sleep(
        backOffAfterReadFailure(state, opts, error, {
          read: "starting cursor",
          cursor: state.cursorBlock,
        }),
      );
    }
  }
}

export interface CreateBlockStreamArgs<TEvent> {
  adapter: ChainAdapter<TEvent>;
  endpoints?: EndpointSelector;
  startingCursor: IndexerCursor;
  loadPreviousCursor?: LoadPreviousCursor;
  loadStoredBlocks?: LoadStoredBlocks;
  options?: BlockStreamOptions;
}

export async function* createBlockStream<TEvent>(
  args: CreateBlockStreamArgs<TEvent>,
): AsyncGenerator<StreamMessage<TEvent>> {
  const { adapter } = args;
  const { opts, state } = initStreamState(args.startingCursor, args.options);

  const notCanonical = await verifiedStart(args, state, opts);
  if (notCanonical) yield notCanonical;

  while (true) {
    await selectEndpoint(args, state);
    const now = Date.now();

    yield* heartbeatIfDue<TEvent>(state, opts, now);

    await refreshFinalized(adapter, state, opts, now);

    const plan = await planOrWait(adapter, state, opts);
    if (!plan) continue;

    if (headUnchanged(state, plan.head)) {
      // The head has not moved, so there is provably nothing new to index: a
      // head hash commits to its whole ancestry. That is a quiet poll in the
      // sense that matters, and counting it is what lets a chain with a block
      // time longer than the poll interval back off at all.
      clearReadFailures(state);
      yield* announceFinalized<TEvent>(adapter, state, plan.head.number);
      state.quietPolls++;
      await sleep(pollIntervalFor(state, opts));
      continue;
    }

    const snapshot = await snapshotOrWait(adapter, state, plan, opts);
    if (!snapshot) continue;
    clearReadFailures(state);
    const rollback = await reconcileSnapshot(args, state, snapshot, plan, opts);
    if (rollback) {
      yield rollback;
      state.quietPolls = 0;
      // An endpoint serving two views alternately would otherwise rollback,
      // re-read and rollback again with no pause between, one DB transaction per
      // turn. Back off exactly as the caught-up path does.
      await sleep(opts.pollIntervalMs);
      continue;
    }

    const { fresh, anchor } = snapshot;
    const completedPlan = { ...plan, head: anchor };
    const tail = tailMessage(state, fresh, anchor);
    yield* emitFresh(state, fresh);
    if (tail) yield tail;

    finishTick(state, completedPlan, opts);

    yield* announceFinalized<TEvent>(adapter, state, plan.to);

    if (plan.to >= plan.head.number) {
      if (fresh.length === 0) state.quietPolls++;
      await sleep(pollIntervalFor(state, opts));
    }
  }
}
