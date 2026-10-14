import type { DAO, IndexerCursor } from "./dao";
import { logger } from "./logger";

/*
 * Refuses rollbacks that no legitimate reorg can produce.
 *
 * Every rollback deletes the `blocks` rows above its target, and the cascade
 * takes every event with them. The target comes from the stream, which believes
 * the provider. Window rollbacks are bounded by the re-read window, but stored-
 * history recovery is not: a provider answering for the wrong chain or with
 * corrupt hashes fails every stored block and lands on the initial boundary --
 * the whole chain's history, deleted in one transaction.
 *
 * Two bounds:
 *
 * - Persisted finality, always, on the stored-history walk. `finalized_order_key`
 *   is written only after the stream reconciled and indexed the history beneath
 *   it, so a stored block at or below it that no longer verifies means the
 *   provider is wrong, or finality itself failed; either needs a person, not a
 *   DELETE. This is not the provider's *current* finalized block: rows orphaned
 *   while the worker was down can sit below that and must still be removed.
 *   Only the walk is bounded this way, because only the walk is a pure hash
 *   comparison. A window rollback can legitimately delete canonical finalized
 *   rows to re-index them -- a block the store missed, or events a newly added
 *   filter address now matches -- and the first window after a restart is not
 *   yet floored at finality, which on chains finalizing in a few blocks puts it
 *   below the persisted cursor's finalized block.
 * - `MAX_REORG_DEPTH`, when the operator sets one, in blocks below the persisted
 *   cursor, on the walk and on every delete. Unset by default: the right number
 *   is chain- and operator-specific, and it must be at least the re-read window
 *   or a filter change could never be re-indexed.
 *
 * A refusal throws before anything is deleted. The worker exits, and every
 * restart re-derives the same rollback from the same provider answer and
 * refuses again until the provider is fixed or an operator intervenes.
 */
export type RollbackRefusalReason =
  | "finalized_history_not_canonical"
  | "exceeds_max_reorg_depth";

export type RollbackRefusal = {
  reason: RollbackRefusalReason;
  /** Persisted cursor block the rollback starts from. */
  fromBlock: number;
  /** Rows above this block would be deleted; null while recovery is still walking. */
  toBlock: number | null;
  depth: number;
  finalizedBlock: number | null;
  /** The stored block at or below finality that failed to verify. */
  failedFinalizedBlock: number | null;
  maxReorgDepth: number | null;
};

export class RollbackRefusedError extends Error {
  constructor(readonly refusal: RollbackRefusal) {
    super(
      `Refusing rollback (${refusal.reason}) from block ${refusal.fromBlock}` +
        `${refusal.toBlock === null ? "" : ` to block ${refusal.toBlock}`}, depth at least ${refusal.depth}` +
        `; finalized block ${refusal.finalizedBlock ?? "unknown"}, MAX_REORG_DEPTH ${refusal.maxReorgDepth ?? "unset"}.` +
        " Nothing was deleted. Check the RPC endpoint before any manual recovery.",
    );
    this.name = "RollbackRefusedError";
  }
}

export type RollbackGuardDao = Pick<DAO, "loadFinalizedCursor">;

/** `MAX_REORG_DEPTH`: null when unset, otherwise a positive block count. */
export function parseMaxReorgDepth(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`MAX_REORG_DEPTH must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function refuse(chainId: bigint, refusal: RollbackRefusal): never {
  logger.error({ evt: "rollback_refused", chainId, ...refusal });
  throw new RollbackRefusedError(refusal);
}

/**
 * Throws when deleting every stored block above `to` is deeper than
 * `MAX_REORG_DEPTH` below `from`. Call before the delete.
 */
export function assertRollbackDepthAllowed(
  args: { chainId: bigint; from: IndexerCursor; to: number; maxReorgDepth: number | null },
): void {
  if (args.maxReorgDepth === null) return;
  const fromBlock = Number(args.from.orderKey);
  const depth = fromBlock - args.to;
  if (depth <= args.maxReorgDepth) return;
  refuse(args.chainId, {
    reason: "exceeds_max_reorg_depth", fromBlock, toBlock: args.to, depth,
    finalizedBlock: null, failedFinalizedBlock: null, maxReorgDepth: args.maxReorgDepth,
  });
}

/**
 * Stops the stored-history walk as soon as its outcome is refused.
 *
 * Recovery asks for the stored block below `before` only after the block at
 * `before` failed to verify. Once that failed block is at or below persisted
 * finality, or the walk is already deeper than `MAX_REORG_DEPTH`, it ends in a
 * rollback no reorg explains; without this it first spends one RPC read per
 * stored block, all the way to the start of the chain.
 */
export async function assertRecoveryWalkAllowed(
  dao: RollbackGuardDao,
  args: { chainId: bigint; from: IndexerCursor; before: number; maxReorgDepth: number | null },
): Promise<void> {
  const fromBlock = Number(args.from.orderKey);
  // The first lookup starts above the cursor; nothing has failed yet.
  if (args.before > fromBlock) return;

  // Every block from `before` up is already known to be rolled back.
  const depth = fromBlock - args.before + 1;
  const finalized = await dao.loadFinalizedCursor();
  const finalizedBlock = finalized ? Number(finalized.orderKey) : null;
  const base = {
    fromBlock, toBlock: null, depth, finalizedBlock,
    failedFinalizedBlock: null, maxReorgDepth: args.maxReorgDepth,
  };

  if (finalizedBlock !== null && args.before <= finalizedBlock) {
    refuse(args.chainId, {
      ...base, reason: "finalized_history_not_canonical", failedFinalizedBlock: args.before,
    });
  }
  if (args.maxReorgDepth !== null && depth > args.maxReorgDepth) {
    refuse(args.chainId, { ...base, reason: "exceeds_max_reorg_depth" });
  }
}
