import type { Bytes, Cursor } from "../common";
import type { DataFinality } from "../stream";
import { sleep } from "./helpers";

export type FetchBlockRangeArgs<TFilter> = {
  startBlock: bigint;
  maxBlock: bigint;
  force: boolean;
  clampAllowed: boolean;
  filter: TFilter;
};

export type FetchBlockRangeResult<TBlock> = {
  startBlock: bigint;
  endBlock: bigint;
  data: FetchBlockResult<TBlock>[];
};

export type FetchBlockRangeManyArgs<TFilter> = Omit<
  FetchBlockRangeArgs<TFilter>,
  "filter"
> & {
  filters: readonly TFilter[];
};

/**
 * Result of fetching a range for multiple filters.
 *
 * `blocks` is positionally aligned with the requested filters. A null entry
 * means that the corresponding filter did not match the block.
 */
export type FetchBlockRangeManyResult<TBlock> = {
  startBlock: bigint;
  endBlock: bigint;
  data: FetchBlockManyResult<TBlock>[];
};

export type FetchBlockManyResult<TBlock> = {
  blocks: (TBlock | null)[];
  cursor: Cursor | undefined;
  endCursor: Cursor;
};

export type FetchBlockResult<TBlock> = {
  block: TBlock | null;
  cursor: Cursor | undefined;
  endCursor: Cursor;
};

export type BlockInfo = {
  blockNumber: bigint;
  blockHash: Bytes;
  parentBlockHash: Bytes;
};

export type FetchBlockByHashArgs<TFilter> = {
  blockHash: Bytes;
};

export type FetchBlockByHashResult<TBlock> = {
  data: FetchBlockResult<TBlock>;
  blockInfo: BlockInfo;
};

export type FetchHeaderByHashManyArgs<TFilter> =
  FetchBlockByHashArgs<TFilter> & {
    filters: readonly TFilter[];
  };

export type FetchHeaderByHashManyResult<TBlock> = {
  data: FetchBlockManyResult<TBlock>;
  blockInfo: BlockInfo;
};

export type FetchPendingBlocksResult<TBlock> = {
  /** Stable identifier for the current mutable snapshot. */
  revision: string;
  /** Blocks positionally aligned with the requested filters. */
  blocks: (TBlock | null)[];
  /** Ephemeral pre-confirmed cursor. It must not be persisted as canonical. */
  endCursor: Cursor;
};

export type FetchCursorRangeArgs = {
  startBlockNumber: bigint;
  endBlockNumber: bigint;
};

export type FetchCursorArgs =
  | {
      blockTag: "latest" | "finalized";
      blockNumber?: undefined;
      blockHash?: undefined;
    }
  | {
      blockTag?: undefined;
      blockNumber: bigint;
      blockHash?: undefined;
    }
  | {
      blockTag?: undefined;
      blockNumber?: undefined;
      blockHash: Bytes;
    };

export type ValidateFilterResult =
  | {
      valid: true;
      error?: undefined;
    }
  | {
      valid: false;
      error: string;
    };

export abstract class RpcStreamConfig<TFilter, TBlock> {
  abstract headRefreshIntervalMs(): number;
  abstract finalizedRefreshIntervalMs(): number;

  pendingRefreshIntervalMs(): number {
    return this.headRefreshIntervalMs();
  }

  async waitForHeadChange(timeoutMs: number): Promise<void> {
    await sleep(timeoutMs);
  }

  abstract fetchCursorRange(args: FetchCursorRangeArgs): Promise<BlockInfo[]>;
  abstract fetchCursor(args: FetchCursorArgs): Promise<BlockInfo | null>;

  abstract validateFilter(filter: TFilter): ValidateFilterResult;

  /**
   * Perform asynchronous request validation and capability discovery.
   * Implementations may use this to fail before the first stream item.
   *
   * Pending finality is unsupported by default. Implementations that support
   * pending data must override this method and explicitly accept the request.
   */
  async initializeRequest(
    _filters: readonly TFilter[],
    finality: DataFinality,
  ): Promise<void> {
    if (finality === "pending") {
      throw new Error("RPC stream does not support pending finality");
    }
  }

  abstract fetchBlockRange(
    args: FetchBlockRangeArgs<TFilter>,
  ): Promise<FetchBlockRangeResult<TBlock>>;

  abstract fetchHeaderByHash(
    args: FetchBlockByHashArgs<TFilter>,
  ): Promise<FetchBlockByHashResult<TBlock>>;

  /**
   * Fetch a range for multiple filters. The default implementation preserves
   * backwards compatibility by calling `fetchBlockRange` once per filter and
   * aligning results by cursor.
   */
  async fetchBlockRangeMany(
    args: FetchBlockRangeManyArgs<TFilter>,
  ): Promise<FetchBlockRangeManyResult<TBlock>> {
    const { filters, ...range } = args;
    const results = await Promise.all(
      filters.map((filter) => this.fetchBlockRange({ ...range, filter })),
    );

    if (results.length === 0) {
      return {
        startBlock: args.startBlock,
        endBlock: args.maxBlock,
        data: [],
      };
    }

    // The stream driver only ever re-fetches the suffix after `endBlock`, so a
    // result starting after the requested block would create a permanent gap.
    // Reject it instead of silently dropping blocks.
    for (const result of results) {
      if (result.startBlock > args.startBlock) {
        throw new Error(
          `fetchBlockRange must cover the requested start block: requested ${args.startBlock}, got ${result.startBlock}`,
        );
      }
    }
    const startBlock = args.startBlock;
    // Filters may cover ranges of different lengths (e.g. per-filter clamping).
    // Only the prefix covered by *all* filters can be emitted; the caller
    // re-fetches everything after `endBlock` on the next iteration.
    const endBlock = results.reduce(
      (value, result) => (result.endBlock < value ? result.endBlock : value),
      results[0].endBlock,
    );
    const byCursor = new Map<
      string,
      {
        cursor: Cursor | undefined;
        endCursor: Cursor;
        blocks: (TBlock | null)[];
      }
    >();

    for (let filterIndex = 0; filterIndex < results.length; filterIndex++) {
      for (const item of results[filterIndex].data) {
        if (
          item.endCursor.orderKey < startBlock ||
          item.endCursor.orderKey > endBlock
        ) {
          continue;
        }
        const key = `${item.endCursor.orderKey}:${item.endCursor.uniqueKey ?? ""}`;
        const aligned = byCursor.get(key) ?? {
          cursor: item.cursor,
          endCursor: item.endCursor,
          blocks: Array.from<TBlock | null>({ length: filters.length }).fill(
            null,
          ),
        };
        aligned.blocks[filterIndex] = item.block;
        byCursor.set(key, aligned);
      }
    }

    return {
      startBlock,
      endBlock,
      data: [...byCursor.values()].sort((a, b) =>
        a.endCursor.orderKey < b.endCursor.orderKey ? -1 : 1,
      ),
    };
  }

  /**
   * Fetch an empty/header projection for multiple filters. Implementations can
   * override this to share the raw header request.
   */
  async fetchHeaderByHashMany(
    args: FetchHeaderByHashManyArgs<TFilter>,
  ): Promise<FetchHeaderByHashManyResult<TBlock>> {
    const results = await Promise.all(
      args.filters.map(() => this.fetchHeaderByHash(args)),
    );
    const first = results[0];
    if (!first) {
      throw new Error("Cannot fetch a header for an empty filter list");
    }
    return {
      blockInfo: first.blockInfo,
      data: {
        cursor: first.data.cursor,
        endCursor: first.data.endCursor,
        blocks: results.map((result) => result.data.block),
      },
    };
  }

  /**
   * Fetch a mutable pre-confirmed snapshot. Implementations that support
   * `pending` finality override this hook.
   */
  async fetchPendingBlocks(
    _filters: readonly TFilter[],
  ): Promise<FetchPendingBlocksResult<TBlock> | null> {
    return null;
  }
}
