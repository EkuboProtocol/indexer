import type { Sql, TransactionSql } from "postgres";
import { type EventKey } from "./eventKey";
import postgres from "postgres";
import { pollForAdvisoryLock } from "./advisoryLockPoll";
import { logger } from "./logger";

export type NumericValue = bigint | number | `0x${string}`;
export type AddressValue = bigint | `0x${string}`;

export interface IndexerCursor {
  orderKey: bigint;
  uniqueKey?: `0x${string}`;
}

// The head of the chain, recorded on indexer_cursor. Blocks with no events get
// no blocks row at all (migration 00122), so for those this is the only record
// that the chain advanced.
export interface BlockHead {
  number: number;
  hash: bigint;
  time: Date;
  baseFeePerGas: bigint | null;
}

export interface NonfungibleTokenTransfer {
  id: bigint;
  from: AddressValue;
  to: AddressValue;
}

export interface OrderTransferInsert {
  id: bigint;
  from: AddressValue;
  to: AddressValue;
}

export interface PositionMintedWithReferrerInsert {
  tokenId: NumericValue;
  referrer: AddressValue;
}

export interface BoundsDescriptor {
  lower: number;
  upper: number;
}

export interface PositionUpdateParams {
  salt: NumericValue;
  bounds: BoundsDescriptor;
  liquidityDelta: NumericValue;
}

export interface PositionUpdatedInsert {
  locker: AddressValue;
  poolId: `0x${string}`;
  params: PositionUpdateParams;
  delta0: bigint;
  delta1: bigint;
}

export interface PositionKeyDescriptor {
  owner: AddressValue;
  salt: NumericValue;
  bounds: BoundsDescriptor;
}

export interface PositionFeesCollectedInsert {
  poolId: `0x${string}`;
  positionKey: PositionKeyDescriptor;
  amount0: NumericValue;
  amount1: NumericValue;
}

export interface PoolKeyInsert {
  token0: AddressValue;
  token1: AddressValue;
  fee: NumericValue;
  tickSpacing: number | null;
  extension: AddressValue;
  poolConfig?: bigint | null;
  poolConfigType?: "concentrated" | "stableswap";
  stableswapCenterTick?: number | null;
  stableswapAmplification?: number | null;
}

export interface PoolInitializedInsert {
  poolId: `0x${string}`;
  poolKey: PoolKeyInsert;
  tick: number;
  sqrtRatio: bigint;
  feeDenominator: bigint;
}

export interface ProtocolFeesWithdrawnInsert {
  recipient: AddressValue;
  token: AddressValue;
  amount: NumericValue;
}

export interface ProtocolFeesPaidInsert {
  poolId: `0x${string}`;
  locker: AddressValue;
  salt: NumericValue;
  bounds: BoundsDescriptor;
  delta0: bigint;
  delta1: bigint;
}

export interface PositionFeesWithheldInsert {
  poolId: `0x${string}`;
  locker: AddressValue;
  salt: NumericValue;
  bounds: BoundsDescriptor;
  amount0: bigint;
  amount1: bigint;
}

export interface PositionWithdrawalFeesWithheldInsert extends Omit<
  PositionFeesWithheldInsert,
  "amount0" | "amount1"
> {
  amount0: bigint;
  amount1: bigint;
  withdrawalProtocolFeeDivisor: bigint;
}

export interface ExtensionRegisteredInsert {
  extension: AddressValue;
}

export interface FeesAccumulatedInsert {
  poolId: `0x${string}`;
  amount0: NumericValue;
  amount1: NumericValue;
}

export interface SwapEventInsert {
  locker: AddressValue;
  poolId: `0x${string}`;
  delta0: bigint;
  delta1: bigint;
  sqrtRatioAfter: bigint;
  tickAfter: number;
  liquidityAfter: bigint;
}

export interface TwammOrderKeyInsert {
  sellToken: AddressValue;
  buyToken: AddressValue;
  fee: NumericValue;
  startTime: bigint;
  endTime: bigint;
}

export interface TwammOrderUpdatedInsert {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
  orderKey: TwammOrderKeyInsert;
  saleRateDelta: bigint;
  owner: AddressValue;
  salt: NumericValue;
  is_selling_token1: boolean;
}

export interface TwammOrderProceedsWithdrawnInsert {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
  orderKey: TwammOrderKeyInsert;
  amount: NumericValue;
  owner: AddressValue;
  salt: NumericValue;
  is_selling_token1: boolean;
}

export interface TwammVirtualOrdersExecutedInsert {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
  saleRateToken0: bigint;
  saleRateToken1: bigint;
}

export interface BoostedFeesDonatedInsert {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
  donateRate0: bigint;
  donateRate1: bigint;
}

export interface BoostedFeesPoolBoostedInsert {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
  startTime: bigint;
  endTime: bigint;
  rate0: bigint;
  rate1: bigint;
}

export interface AuctionKeyInsert {
  token0: AddressValue;
  token1: AddressValue;
  config: NumericValue;
}

export interface AuctionCompletedInsert {
  tokenId: NumericValue;
  auctionKey: AuctionKeyInsert;
  creatorAmount: NumericValue;
  boostAmount: NumericValue;
}

export interface AuctionFundsAddedInsert {
  tokenId: NumericValue;
  auctionKey: AuctionKeyInsert;
  saleRate: NumericValue;
}

export interface AuctionBoostStartedInsert {
  auctionKey: AuctionKeyInsert;
  boostRate: NumericValue;
  boostEndTime: NumericValue;
}

export interface CreatorProceedsCollectedInsert {
  tokenId: NumericValue;
  auctionKey: AuctionKeyInsert;
  recipient: AddressValue;
  amount: NumericValue;
}

export interface OracleSnapshotInsert {
  token0: AddressValue;
  token1: AddressValue;
  timestamp: NumericValue;
  secondsPerLiquidityCumulative: NumericValue | null;
  tickCumulative: NumericValue;
}

export interface IncentivesKeyDescriptor {
  owner: AddressValue;
  token: AddressValue;
  root: AddressValue;
}

export interface IncentivesRefundedInsert {
  key: IncentivesKeyDescriptor;
  refundAmount: NumericValue;
}

export interface IncentivesFundedInsert {
  key: IncentivesKeyDescriptor;
  amountNext: NumericValue;
}

export interface TokenWrapperDeployedInsert {
  tokenWrapper: AddressValue;
  underlyingToken: AddressValue;
  unlockTime: NumericValue;
}

export interface StakeDescriptor {
  id: AddressValue;
  salt: NumericValue;
  endTime: NumericValue;
}

export interface Ve33PoolEventDescriptor {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
}

export interface Ve33StakeChangedInsert {
  owner: AddressValue;
  stake: StakeDescriptor;
  delta: bigint;
}

export interface Ve33VoteWeightAppliedInsert extends Ve33PoolEventDescriptor {
  owner: AddressValue;
  stake: StakeDescriptor;
  weight: NumericValue;
  votedSwapFee: NumericValue;
  swapFee: NumericValue;
}

export interface Ve33PoolFeesAccountedInsert extends Ve33PoolEventDescriptor {
  amount0: NumericValue;
  amount1: NumericValue;
}

export interface Ve33PoolFeesClaimedInsert extends Ve33PoolEventDescriptor {
  owner: AddressValue;
  stake: StakeDescriptor;
  amount0: NumericValue;
  amount1: NumericValue;
}

export interface Ve33EmissionsScheduledInsert {
  funder: AddressValue;
  startTime: NumericValue;
  endTime: NumericValue;
  rewardRate: NumericValue;
  amount: NumericValue;
}

export interface Ve33PoolEmissionsAccruedInsert extends Ve33PoolEventDescriptor {
  amount: NumericValue;
}

export interface Ve33RewardsClaimedInsert extends Ve33PoolEventDescriptor {
  owner: AddressValue;
  positionId: AddressValue;
  salt: NumericValue;
  bounds: BoundsDescriptor;
  amount: NumericValue;
}

export interface ZeroSeedLaunchEventDescriptor {
  coreAddress: `0x${string}`;
  poolId: `0x${string}`;
}

export interface ZeroSeedLaunchCreatedInsert extends ZeroSeedLaunchEventDescriptor {
  token: AddressValue;
  controller: AddressValue;
  /** LaunchParameters.quoteToken, the other token of the pool key; 0 is native ETH. */
  quoteToken: AddressValue;
  positionId: `0x${string}`;
  /** The installed liquidity the extension computed. */
  liquidity: bigint;
  /** LaunchParameters.supply: the token's totalSupply. */
  requestedSupply: bigint;
  name: string;
  symbol: string;
  decimals: number;
  askTick: number;
  upperTick: number;
  tickSpacing: number;
  tradingStart: NumericValue;
  feeDuration: number;
  initialFee: NumericValue;
  finalFee: NumericValue;
  salt: `0x${string}`;
}

export interface ZeroSeedLaunchSwappedInsert extends ZeroSeedLaunchEventDescriptor {
  locker: AddressValue;
  delta0: NumericValue;
  delta1: NumericValue;
  feeRate: NumericValue;
  feeAmount: NumericValue;
  feeIsToken1: boolean;
}

export interface ZeroSeedLaunchFeesClaimedInsert extends ZeroSeedLaunchEventDescriptor {
  controller: AddressValue;
  amount0: NumericValue;
  amount1: NumericValue;
}

/** Periphery events name the pool only; the extension comes from the pin. */
export interface ZeroSeedLaunchPeripheryEventDescriptor extends ZeroSeedLaunchEventDescriptor {
  extension: `0x${string}`;
}

export interface ZeroSeedLaunchOwnerChangedInsert extends ZeroSeedLaunchPeripheryEventDescriptor {
  previousOwner: AddressValue;
  newOwner: AddressValue;
}

export interface ZeroSeedLaunchFeesPaidInsert extends ZeroSeedLaunchPeripheryEventDescriptor {
  owner: AddressValue;
  recipient: AddressValue;
  amount0: NumericValue;
  amount1: NumericValue;
}

// Postgres text cannot hold NUL, and launch names and symbols are arbitrary
// creator input.
export function stripNul(value: string): string {
  return value.replaceAll("\u0000", "");
}

export interface TokenRegistrationInsert {
  address: AddressValue;
  name: NumericValue;
  symbol: NumericValue;
  decimals: number;
  totalSupply: NumericValue;
}

export interface TokenRegistrationV3Insert {
  address: AddressValue;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: NumericValue;
}

export interface StakerStakedInsert {
  from: AddressValue;
  amount: NumericValue;
  delegate: AddressValue;
}

export interface StakerWithdrawnInsert {
  from: AddressValue;
  amount: NumericValue;
  recipient: AddressValue;
  delegate: AddressValue;
}

export interface GovernorCallInsert {
  to: AddressValue;
  selector: NumericValue;
  calldata: NumericValue[];
}

export interface GovernorProposedInsert {
  proposal_id: NumericValue;
  proposer: AddressValue;
  configVersion: NumericValue | null;
  calls: GovernorCallInsert[];
}

export interface GovernorCanceledInsert {
  proposal_id: NumericValue;
}

export interface GovernorVotedInsert {
  proposal_id: NumericValue;
  voter: AddressValue;
  weight: NumericValue;
  yea: boolean;
}

export interface GovernorExecutedInsert {
  proposal_id: NumericValue;
  results: NumericValue[][];
}

export interface GovernorProposalDescribedInsert {
  proposal_id: NumericValue;
  description: string;
}

export interface GovernorReconfiguredInsert {
  version: NumericValue;
  votingStartDelay: NumericValue;
  votingPeriod: NumericValue;
  votingWeightSmoothingDuration: NumericValue;
  quorum: NumericValue;
  proposalCreationThreshold: NumericValue;
  executionDelay: NumericValue;
  executionWindow: NumericValue;
}

export interface LimitOrderPlacedInsert {
  poolId: `0x${string}`;
  locker: AddressValue;
  salt: NumericValue;
  token0: AddressValue;
  token1: AddressValue;
  tick: number;
  liquidity: NumericValue;
  amount: NumericValue;
}

export interface LimitOrderClosedInsert {
  poolId: `0x${string}`;
  locker: AddressValue;
  salt: NumericValue;
  token0: AddressValue;
  token1: AddressValue;
  tick: number;
  amount0: NumericValue;
  amount1: NumericValue;
}

export interface LiquidityUpdatedInsert {
  poolId: `0x${string}`;
  sender: AddressValue;
  liquidityFactor: NumericValue;
  shares: NumericValue;
  amount0: NumericValue;
  amount1: NumericValue;
  protocolFees0: NumericValue;
  protocolFees1: NumericValue;
}

export const NumericIntegerType: postgres.PostgresType<bigint> = {
  from: [1700],
  to: 1700,
  parse(v: string) {
    try {
      return BigInt(v);
    } catch (e) {
      throw new Error(`Failed to parse numeric integer type: "${v}"`);
    }
  },
  serialize(v: any) {
    if (typeof v === "string") {
      return v;
    }
    if (typeof v !== "bigint")
      throw new Error(`Unexpected numeric integer type: "${v}"`);
    return v.toString();
  },
};

type UnwrapPromiseArray<T> = T extends any[]
  ? {
      [k in keyof T]: T[k] extends Promise<infer R> ? R : T[k];
    }
  : T;

const LOCK_WAIT_LOG_INTERVAL_MS = 30_000;

export class DAO {
  private readonly chainId: bigint;
  private readonly sql:
    | Sql<{ numeric: bigint; bigint: bigint }>
    | TransactionSql<{ numeric: bigint; bigint: bigint }>;

  private constructor(
    sql:
      | Sql<{ numeric: bigint; bigint: bigint }>
      | TransactionSql<{ numeric: bigint; bigint: bigint }>,
    chainId: bigint,
  ) {
    this.chainId = chainId;
    this.sql = sql;
  }

  public static create(pgConnectionString: string, chainId: bigint): DAO {
    const sql = postgres(pgConnectionString, {
      connect_timeout: 5,
      idle_timeout: 0,
      max_lifetime: null,
      max: 1,
      connection: {
        application_name: `indexer-${chainId}`,
      },
      types: {
        bigint: postgres.BigInt,
        numeric: NumericIntegerType,
      },
      onclose(connId) {
        console.error("Connection closed unexpectedly: ", connId);
        process.exit(1);
      },
    });
    return new DAO(sql, chainId);
  }

  public async acquireLock(): Promise<void> {
    // Waiting here is normal: during a deploy the newcomer holds off until the
    // outgoing instance for this chain exits. pg_try_advisory_lock is used
    // rather than pg_advisory_lock so that waiting does not hold a snapshot and
    // pin the vacuum horizon. See advisoryLockPoll.ts.
    let nextLogAtMs = 0;

    await pollForAdvisoryLock(
      async () => {
        const [row] = await this.sql<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_lock(hashtext('ekubo-indexer-' || ${this.chainId})) AS acquired;`;
        return row?.acquired === true;
      },
      {
        onContended: (waitedMs) => {
          if (waitedMs < nextLogAtMs) return;
          nextLogAtMs = waitedMs + LOCK_WAIT_LOG_INTERVAL_MS;
          logger.info({
            message: `Waiting for the indexer lock for chain ID ${this.chainId}; another instance still holds it`,
            chainId: this.chainId.toString(),
            waitedMs,
          });
        },
      },
    );
  }

  public async releaseLock(): Promise<void> {
    const rows = await this
      .sql`SELECT pg_advisory_unlock(hashtext('ekubo-indexer-' || ${this.chainId}));`;
    if (!rows.length)
      throw new Error(`Failed to release lock for chain ID ${this.chainId}`);
  }

  public async begin<T>(
    cb: (dao: DAO) => T | Promise<T>,
  ): Promise<UnwrapPromiseArray<T>> {
    if (!("begin" in this.sql))
      throw new Error("Cannot begin a transaction inside a transaction");
    return this.sql.begin((sql) => {
      const dao = new DAO(sql, this.chainId);
      return cb(dao);
    });
  }

  public async end() {
    if (!("end" in this.sql))
      throw new Error("Cannot end the connection from inside a transaction");
    await this.sql.end({ timeout: 5 });
  }

  public async loadCursor(): Promise<IndexerCursor | null> {
    const [cursor] = await this.sql<
      { order_key: string; unique_key: string | null }[]
    >`SELECT order_key, unique_key FROM indexer_cursor WHERE chain_id = ${this.chainId};`;

    if (cursor) {
      const { order_key, unique_key } = cursor;

      return unique_key === null
        ? {
            orderKey: BigInt(order_key),
          }
        : {
            orderKey: BigInt(order_key),
            uniqueKey: `0x${BigInt(unique_key).toString(16)}`,
          };
    }

    return null;
  }

  public async loadPreviousBlockCursor(
    before: number,
  ): Promise<IndexerCursor | null> {
    const [block] = await this.sql<
      { block_number: string; block_hash: string }[]
    >`
      SELECT block_number, block_hash FROM blocks
      WHERE chain_id = ${this.chainId} AND block_number < ${before}
      ORDER BY block_number DESC LIMIT 1;
    `;
    return block
      ? {
          orderKey: BigInt(block.block_number),
          uniqueKey: `0x${BigInt(block.block_hash).toString(16)}`,
        }
      : null;
  }

  /**
   * Recomputes pool state, from full event history, for every pool with a swap
   * in the block. For backfilling a block below the head: `on_insert_swap`
   * assumes the inserted swap is the newest, so it overwrites current state.
   */
  public async refreshPoolStatesSwappedIn(
    blockNumber: number,
  ): Promise<string[]> {
    const rows = await this.sql<{ pool_key_id: string }[]>`
      SELECT DISTINCT pool_key_id FROM swaps
      WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber};
    `;
    for (const { pool_key_id } of rows) {
      await this.sql`SELECT refresh_pool_state(${pool_key_id}::int8);`;
    }
    return rows.map((row) => String(row.pool_key_id));
  }

  public async poolStatesSnapshot(): Promise<Map<string, string>> {
    const rows = await this.sql<{ pool_key_id: string; state: string }[]>`
      SELECT ps.pool_key_id,
             concat_ws(',', ps.sqrt_ratio, ps.tick, ps.liquidity, ps.last_event_id,
                       ps.last_position_update_event_id) AS state
      FROM pool_states ps JOIN pool_keys pk USING (pool_key_id)
      WHERE pk.chain_id = ${this.chainId};
    `;
    return new Map(rows.map((row) => [String(row.pool_key_id), row.state]));
  }

  public async rowsReferencingBlock(
    blockNumber: number,
  ): Promise<Record<string, number>> {
    const tables = await this.sql<{ table_name: string }[]>`
      SELECT DISTINCT cl.relname AS table_name
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE c.contype = 'f' AND c.confrelid = 'public.blocks'::regclass AND ns.nspname = 'public';
    `;
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const [row] = await this.sql<{ n: string }[]>`
        SELECT count(*) AS n FROM ${this.sql(table_name)}
        WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber};
      `;
      if (Number(row!.n) > 0) counts[table_name] = Number(row!.n);
    }
    return counts;
  }

  public async loadStoredBlockHashes(
    from: number,
    to: number,
  ): Promise<Map<number, string>> {
    const rows = await this.sql<{ block_number: string; block_hash: string }[]>`
      SELECT block_number, block_hash FROM blocks
      WHERE chain_id = ${this.chainId} AND block_number BETWEEN ${from} AND ${to};
    `;
    return new Map(
      rows.map((row) => [
        Number(row.block_number),
        `0x${BigInt(row.block_hash).toString(16)}`,
      ]),
    );
  }

  public async loadFinalizedCursor(): Promise<IndexerCursor | null> {
    const [cursor] = await this.sql<
      {
        finalized_order_key: string | null;
        finalized_unique_key: string | null;
      }[]
    >`SELECT finalized_order_key, finalized_unique_key FROM indexer_cursor WHERE chain_id = ${this.chainId} AND finalized_order_key IS NOT NULL AND finalized_order_key <= order_key;`;

    if (cursor?.finalized_order_key) {
      const { finalized_order_key, finalized_unique_key } = cursor;

      return finalized_unique_key === null
        ? {
            orderKey: BigInt(finalized_order_key),
          }
        : {
            orderKey: BigInt(finalized_order_key),
            uniqueKey: `0x${BigInt(finalized_unique_key).toString(16)}`,
          };
    }

    return null;
  }

  public async writeCursor(
    cursor: IndexerCursor,
    expectedCursor: IndexerCursor,
    head?: BlockHead,
  ): Promise<IndexerCursor> {
    const uniqueKey =
      typeof cursor.uniqueKey !== "string" ? null : BigInt(cursor.uniqueKey);
    const expectedUniqueKey =
      typeof expectedCursor.uniqueKey !== "string"
        ? null
        : BigInt(expectedCursor.uniqueKey);

    const [updatedCursor] = await this.sql<
      { order_key: string; unique_key: string | null }[]
    >`
      INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated,
                                  head_block_number, head_block_hash,
                                  head_block_time, head_base_fee_per_gas)
      VALUES (${this.chainId}, ${cursor.orderKey}, ${this.numeric(
        uniqueKey,
      )}, NOW(),
        ${head ? head.number : null},
        ${this.numeric(head ? head.hash : null)},
        ${head ? head.time : null},
        ${this.numeric(head ? head.baseFeePerGas : null)})
      ON CONFLICT (chain_id) DO UPDATE
        SET order_key = excluded.order_key,
            unique_key = excluded.unique_key,
            last_updated = NOW(),
            finalized_order_key = CASE WHEN indexer_cursor.finalized_order_key > excluded.order_key
              THEN NULL ELSE indexer_cursor.finalized_order_key END,
            finalized_unique_key = CASE WHEN indexer_cursor.finalized_order_key > excluded.order_key
              THEN NULL ELSE indexer_cursor.finalized_unique_key END,
            head_block_number = excluded.head_block_number,
            head_block_hash = excluded.head_block_hash,
            head_block_time = excluded.head_block_time,
            -- Keep the last known base fee rather than blanking it.
            --
            -- This is the only surviving consumer of a base fee anywhere:
            -- quoter-service reads it (shared-quoter-service/src/db.rs) to price
            -- gas into quotes, and 00127 drops blocks.base_fee_per_gas. A block
            -- derived from eth_getLogs has no base fee to report, so writing
            -- NULL through would blank the column on every block carrying
            -- events. A value one poll old prices gas fine; NULL does not.
            head_base_fee_per_gas = CASE WHEN excluded.head_block_number IS NULL THEN NULL
              ELSE COALESCE(excluded.head_base_fee_per_gas, indexer_cursor.head_base_fee_per_gas) END
        WHERE indexer_cursor.order_key = ${expectedCursor.orderKey}
          AND indexer_cursor.unique_key IS NOT DISTINCT FROM ${this.numeric(
            expectedUniqueKey,
          )}
      RETURNING order_key, unique_key;
    `;

    if (!updatedCursor) {
      throw new Error(
        `Refused to overwrite cursor because database state differed from expected (expected: ${this.describeCursor(
          expectedCursor,
        )})`,
      );
    }

    return cursor;
  }

  public async updateFinalizedCursor(
    expectedCursor: IndexerCursor,
    finalizedCursor: IndexerCursor,
  ): Promise<void> {
    const uniqueKey =
      typeof finalizedCursor.uniqueKey !== "string"
        ? null
        : BigInt(finalizedCursor.uniqueKey);

    const expectedUniqueKey =
      typeof expectedCursor.uniqueKey !== "string"
        ? null
        : BigInt(expectedCursor.uniqueKey);

    const { count } = await this.sql`
      UPDATE indexer_cursor
        SET finalized_order_key = ${
          finalizedCursor.orderKey
        }, finalized_unique_key = ${this.numeric(
          uniqueKey,
        )}, last_updated = NOW()
      WHERE chain_id = ${this.chainId}
        AND order_key = ${expectedCursor.orderKey}
        AND unique_key IS NOT DISTINCT FROM ${this.numeric(expectedUniqueKey)};
    `;

    if (!count) {
      throw new Error(
        `Failed to update finalized cursor, expected cursor: ${this.describeCursor(
          expectedCursor,
        )}, finalized: ${this.describeCursor(finalizedCursor)}`,
      );
    }
  }

  private describeCursor(cursor: IndexerCursor | null): string {
    if (!cursor) {
      return "null";
    }

    const uniqueKey = cursor.uniqueKey ?? "null";
    return `{orderKey: ${cursor.orderKey}, uniqueKey: ${uniqueKey}}`;
  }
  private numeric(value: NumericValue | null) {
    return this.sql.typed(value, 1700);
  }

  // A block with no events gets no blocks row. 85% of blocks are empty, and
  // every one that was written had to be deleted again a day later, paying all
  // 43 of the ON DELETE CASCADE lookups that hang off blocks despite never
  // having had a child row. The chain head is recorded on indexer_cursor
  // instead, by writeCursor. See migration 00122.
  public async insertBlock({
    number,
    hash,
    time,
    baseFeePerGas,
    numEvents,
  }: {
    number: number;
    hash: bigint;
    time: Date;
    baseFeePerGas: bigint | null;
    numEvents: number;
  }) {
    if (numEvents === 0) {
      return;
    }

    await this.sql`
      INSERT INTO blocks (chain_id, block_number, block_hash, block_time, num_events)
      VALUES (${this.chainId}, ${number}, ${this.numeric(
        hash,
      )}, ${time}, ${numEvents});
    `;
  }

  public async insertNonfungibleTokenTransferEvent(
    transfer: NonfungibleTokenTransfer,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO nonfungible_token_transfers
          (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_id, from_address, to_address)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(transfer.id)},
        ${this.numeric(transfer.from)},
        ${this.numeric(transfer.to)}
      );
    `;
  }

  public async insertPositionMintedWithReferrerEvent(
    event: PositionMintedWithReferrerInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO position_minted_with_referrer
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_id, referrer)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.tokenId)},
        ${this.numeric(event.referrer)}
      );
    `;
  }

  public async insertPositionUpdatedEvent(
    event: PositionUpdatedInsert,
    key: EventKey,
  ) {
    const {
      params: { salt, bounds, liquidityDelta },
      locker,
      poolId,
      delta0,
      delta1,
    } = event;
    const { lower, upper } = bounds;

    await this.sql`
      INSERT INTO position_updates
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, liquidity_delta, delta0, delta1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(locker)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        ${this.numeric(liquidityDelta)},
        ${this.numeric(delta0)},
        ${this.numeric(delta1)}
      );
    `;
  }

  // inserts a position updated event and also a protocol fees paid event that accounts for the shortfall in delta that is due to the withdrawal fee
  // assumes the amounts in delta0 and delta1 are after the withdrawal protocol fee is paid (not true of v3)
  public async insertPositionUpdatedEventWithSyntheticProtocolFeesPaid(
    event: PositionUpdatedInsert,
    key: EventKey,
  ) {
    const {
      params: { salt, bounds, liquidityDelta },
      locker,
      poolId,
      delta0,
      delta1,
    } = event;
    const { lower, upper } = bounds;

    await this.sql`
      WITH
        inserted_position_update AS (
          INSERT INTO position_updates
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, locker, salt, lower_bound, upper_bound, liquidity_delta, delta0, delta1)
          VALUES (
            ${this.chainId},
            ${key.blockNumber},
            ${key.transactionIndex},
            ${key.eventIndex},
            ${this.numeric(key.transactionHash)},
            ${this.numeric(key.emitter)},
            (
              SELECT pool_key_id
              FROM pool_keys
              WHERE chain_id = ${this.chainId}
                AND core_address = ${this.numeric(key.emitter)}
                AND pool_id = ${this.numeric(poolId)}
            ),
            ${this.numeric(locker)},
            ${this.numeric(salt)},
            ${lower},
            ${upper},
            ${this.numeric(liquidityDelta)},
            ${this.numeric(delta0)},
            ${this.numeric(delta1)}
          )
        )
      INSERT INTO protocol_fees_paid
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
      SELECT
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        pool_key_id,
        ${this.numeric(locker)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        FLOOR((${this.numeric(
          delta0,
        )} * fee_denominator) / (fee_denominator - fee)) - ${this.numeric(
          delta0,
        )},
        FLOOR((${this.numeric(
          delta1,
        )} * fee_denominator) / (fee_denominator - fee)) - ${this.numeric(
          delta1,
        )}
      FROM pool_keys
      WHERE chain_id = ${this.chainId}
        AND core_address = ${this.numeric(key.emitter)}
        AND pool_id = ${this.numeric(poolId)}
        AND fee != 0
        AND ${this.numeric(liquidityDelta)} < 0::NUMERIC;
    `;
  }

  public async insertPositionFeesCollectedEvent(
    event: PositionFeesCollectedInsert,
    key: EventKey,
  ) {
    const {
      poolId,
      positionKey: { owner, salt, bounds },
      amount0,
      amount1,
    } = event;
    const { lower, upper } = bounds;

    await this.sql`
      INSERT INTO position_fees_collected
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(owner)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        -${this.numeric(amount0)},
        -${this.numeric(amount1)}
      );
    `;
  }

  public async insertPoolInitializedEvent(
    newPool: PoolInitializedInsert,
    key: EventKey,
  ) {
    const {
      poolKey: {
        token0,
        token1,
        fee,
        tickSpacing,
        extension,
        poolConfig,
        poolConfigType,
        stableswapAmplification,
        stableswapCenterTick,
      },
      poolId,
      tick,
      sqrtRatio,
      feeDenominator,
    } = newPool;
    const configType = poolConfigType ?? "concentrated";

    await this.sql`
      WITH inserted AS (
        INSERT INTO pool_keys
          (chain_id, core_address, pool_id, token0, token1, fee, tick_spacing, pool_extension, fee_denominator,
          pool_config, pool_config_type, stableswap_center_tick, stableswap_amplification)
        VALUES (
          ${this.chainId},
          ${this.numeric(key.emitter)},
          ${this.numeric(poolId)},
          ${this.numeric(token0)},
          ${this.numeric(token1)},
          ${this.numeric(fee)},
          ${tickSpacing},
          ${this.numeric(extension)},
          ${this.numeric(feeDenominator)},
          ${this.numeric(poolConfig ?? null)},
          ${configType},
          ${stableswapCenterTick ?? null},
          ${stableswapAmplification ?? null}
        ) ON CONFLICT (chain_id, core_address, pool_id) DO NOTHING
        RETURNING pool_key_id
      ),
      pool_key AS (
        SELECT pool_key_id FROM inserted
        UNION ALL
        SELECT pk.pool_key_id
        FROM pool_keys pk
        WHERE pk.chain_id = ${this.chainId}
          AND pk.core_address = ${this.numeric(key.emitter)}
          AND pk.pool_id = ${this.numeric(poolId)}
        LIMIT 1
      )
      INSERT INTO pool_initializations
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_key_id, tick, sqrt_ratio)
      SELECT
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        pool_key.pool_key_id,
        ${tick},
        ${this.numeric(sqrtRatio)}
      FROM pool_key;
    `;
  }

  public async insertMEVCapturePoolKey(
    coreAddress: `0x${string}`,
    poolId: `0x${string}`,
  ) {
    await this.sql`
      INSERT INTO mev_capture_pool_keys (pool_key_id)
      (
        SELECT pool_key_id
        FROM pool_keys
        WHERE chain_id = ${this.chainId}
          AND core_address = ${this.numeric(coreAddress)}
          AND pool_id = ${this.numeric(poolId)}
      )
      ON CONFLICT DO NOTHING;
    `;
  }

  public async insertZeroSeedLaunchPoolKey(
    coreAddress: `0x${string}`,
    poolId: `0x${string}`,
  ) {
    await this.sql`
      INSERT INTO zero_seed_launch_pool_keys (pool_key_id)
      (
        SELECT pool_key_id
        FROM pool_keys
        WHERE chain_id = ${this.chainId}
          AND core_address = ${this.numeric(coreAddress)}
          AND pool_id = ${this.numeric(poolId)}
      )
      ON CONFLICT DO NOTHING;
    `;
  }

  /**
   * The pool key of a launch event. A launch event for a pool that Core did
   * not initialize with the configured extension is a decoder or config bug:
   * refuse it rather than store an unattributed row.
   */
  private async zeroSeedLaunchPoolKeyId(
    coreAddress: `0x${string}`,
    poolId: `0x${string}`,
    extension: `0x${string}`,
  ): Promise<bigint> {
    const [row] = await this.sql<{ pool_key_id: bigint }[]>`
      SELECT zslpk.pool_key_id
      FROM pool_keys pk
               JOIN zero_seed_launch_pool_keys zslpk USING (pool_key_id)
      WHERE pk.chain_id = ${this.chainId}
        AND pk.core_address = ${this.numeric(coreAddress)}
        AND pk.pool_id = ${this.numeric(poolId)}
        AND pk.pool_extension = ${this.numeric(extension)};
    `;
    if (!row)
      throw new Error(
        `Zero-seed launch event for pool ${poolId}, which is not a registered launch pool`,
      );
    return row.pool_key_id;
  }

  private eventKeyValues(key: EventKey) {
    return this.sql`
      ${this.chainId},
      ${key.blockNumber},
      ${key.transactionIndex},
      ${key.eventIndex},
      ${this.numeric(key.transactionHash)},
      ${this.numeric(key.emitter)}
    `;
  }

  /**
   * The launch-token amount Core took into the launch position: the token-side
   * delta of the Core PositionUpdated that installed it, earlier in the same
   * transaction (Core emits it inside updatePosition, before the extension
   * emits LaunchCreated, and logs are written in order). It must be the only
   * update of (extension, salt 0, launch bounds) there, add exactly the
   * LaunchCreated liquidity, take a positive amount of the launch token and
   * none of the quote, and not exceed the requested supply. Anything else is
   * refused: the installed supply is never guessed.
   */
  private async zeroSeedLaunchInstalledSupply(
    key: EventKey,
    poolKeyId: bigint,
    parsed: ZeroSeedLaunchCreatedInsert,
  ): Promise<bigint> {
    const tokenIs1 = BigInt(parsed.token) > BigInt(parsed.quoteToken);
    const [lower, upper] = tokenIs1
      ? [-parsed.upperTick, -parsed.askTick]
      : [parsed.askTick, parsed.upperTick];
    const rows = await this.sql<
      { liquidity_delta: bigint; delta0: bigint; delta1: bigint }[]
    >`
      SELECT liquidity_delta, delta0, delta1
      FROM position_updates
      WHERE chain_id = ${this.chainId}
        AND block_number = ${key.blockNumber}
        AND transaction_index = ${key.transactionIndex}
        AND event_index < ${key.eventIndex}
        AND emitter = ${this.numeric(parsed.coreAddress)}
        AND pool_key_id = ${poolKeyId}
        AND locker = ${this.numeric(key.emitter)}
        AND salt = 0
        AND lower_bound = ${lower}
        AND upper_bound = ${upper}`;
    const problem = (() => {
      if (rows.length !== 1)
        return `${rows.length} Core position updates of the launch position in its transaction`;
      const row = rows[0];
      const [tokenDelta, quoteDelta] = tokenIs1
        ? [BigInt(row.delta1), BigInt(row.delta0)]
        : [BigInt(row.delta0), BigInt(row.delta1)];
      if (BigInt(row.liquidity_delta) !== parsed.liquidity)
        return "Core liquidity delta != LaunchCreated.liquidity";
      if (quoteDelta !== 0n) return "Core took quote into the position";
      if (tokenDelta <= 0n || tokenDelta > parsed.requestedSupply)
        return "installed supply is outside 1..requested supply";
      return tokenDelta;
    })();
    if (typeof problem === "bigint") return problem;
    throw new Error(
      `Refusing LaunchCreated for pool ${parsed.poolId}: ${problem}`,
    );
  }

  // Launch writers insert with ON CONFLICT DO NOTHING so that a redelivered
  // log fires no ledger trigger. Swaps, claims, owner changes and payouts
  // without their LaunchCreated are refused by the state triggers.
  async insertZeroSeedLaunchCreatedEvent(
    key: EventKey,
    parsed: ZeroSeedLaunchCreatedInsert,
  ) {
    const poolKeyId = await this.zeroSeedLaunchPoolKeyId(
      parsed.coreAddress,
      parsed.poolId,
      key.emitter,
    );
    const installedSupply = await this.zeroSeedLaunchInstalledSupply(
      key,
      poolKeyId,
      parsed,
    );
    await this.sql`
      INSERT INTO zero_seed_launch_created
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, token, controller, quote_token, position_id, liquidity,
         requested_supply, installed_supply,
         name, symbol, decimals, ask_tick, upper_tick, tick_spacing, trading_start,
         fee_duration, initial_fee, final_fee, salt)
      VALUES (
        ${this.eventKeyValues(key)},
        ${poolKeyId},
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.token)},
        ${this.numeric(parsed.controller)},
        ${this.numeric(parsed.quoteToken)},
        ${this.numeric(parsed.positionId)},
        ${this.numeric(parsed.liquidity)},
        ${this.numeric(parsed.requestedSupply)},
        ${this.numeric(installedSupply)},
        ${stripNul(parsed.name)},
        ${stripNul(parsed.symbol)},
        ${parsed.decimals},
        ${parsed.askTick},
        ${parsed.upperTick},
        ${parsed.tickSpacing},
        ${this.numeric(parsed.tradingStart)},
        ${parsed.feeDuration},
        ${this.numeric(parsed.initialFee)},
        ${this.numeric(parsed.finalFee)},
        ${this.numeric(parsed.salt)}
      )
      ON CONFLICT (chain_id, event_id) DO NOTHING;
    `;
  }

  async insertZeroSeedLaunchSwappedEvent(
    key: EventKey,
    parsed: ZeroSeedLaunchSwappedInsert,
  ) {
    const poolKeyId = await this.zeroSeedLaunchPoolKeyId(
      parsed.coreAddress,
      parsed.poolId,
      key.emitter,
    );
    await this.sql`
      INSERT INTO zero_seed_launch_swapped
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, locker, delta0, delta1, fee_rate, fee_amount, fee_is_token1)
      VALUES (
        ${this.eventKeyValues(key)},
        ${poolKeyId},
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.locker)},
        ${this.numeric(parsed.delta0)},
        ${this.numeric(parsed.delta1)},
        ${this.numeric(parsed.feeRate)},
        ${this.numeric(parsed.feeAmount)},
        ${parsed.feeIsToken1}
      )
      ON CONFLICT (chain_id, event_id) DO NOTHING;
    `;
  }

  async insertZeroSeedLaunchFeesClaimedEvent(
    key: EventKey,
    parsed: ZeroSeedLaunchFeesClaimedInsert,
  ) {
    const poolKeyId = await this.zeroSeedLaunchPoolKeyId(
      parsed.coreAddress,
      parsed.poolId,
      key.emitter,
    );
    const launch = await this.zeroSeedLaunch(poolKeyId);
    if (BigInt(parsed.controller) !== launch.controller)
      throw new Error("Refusing zero-seed claim by another controller");
    await this.sql`
      INSERT INTO zero_seed_launch_fees_claimed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, controller, amount0, amount1)
      VALUES (
        ${this.eventKeyValues(key)},
        ${poolKeyId},
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.controller)},
        ${this.numeric(parsed.amount0)},
        ${this.numeric(parsed.amount1)}
      )
      ON CONFLICT (chain_id, event_id) DO NOTHING;
    `;
  }

  private async zeroSeedLaunch(poolKeyId: bigint) {
    const [row] = await this.sql<
      {
        controller: bigint;
        token0: bigint;
        token1: bigint;
        current_owner: bigint | null;
      }[]
    >`
      SELECT c.controller, pk.token0, pk.token1, s.current_owner
      FROM zero_seed_launch_created c
               JOIN pool_keys pk USING (pool_key_id)
               JOIN zero_seed_launch_states s USING (pool_key_id)
      WHERE c.pool_key_id = ${poolKeyId}`;
    if (!row) throw new Error("Zero-seed launch event without LaunchCreated");
    return row;
  }

  /**
   * Periphery LaunchOwnerChanged. Only the launch's own controller can record
   * owners, the first change comes from the zero address, and every later one
   * from the current owner; anything else is a decoder or pin bug.
   */
  async insertZeroSeedLaunchOwnerChangedEvent(
    key: EventKey,
    parsed: ZeroSeedLaunchOwnerChangedInsert,
  ) {
    const poolKeyId = await this.zeroSeedLaunchPoolKeyId(
      parsed.coreAddress,
      parsed.poolId,
      parsed.extension,
    );
    const launch = await this.zeroSeedLaunch(poolKeyId);
    const previous = BigInt(parsed.previousOwner);
    if (
      launch.controller !== BigInt(key.emitter) ||
      BigInt(parsed.newOwner) === 0n ||
      previous !== (launch.current_owner ?? 0n)
    ) {
      if (await this.zeroSeedLaunchEventExists("owner_changed", key)) return;
      throw new Error(
        `Refusing LaunchOwnerChanged for pool ${parsed.poolId}: not the controller or not from the current owner`,
      );
    }
    await this.sql`
      INSERT INTO zero_seed_launch_owner_changed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, previous_owner, new_owner)
      VALUES (
        ${this.eventKeyValues(key)},
        ${poolKeyId},
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.previousOwner)},
        ${this.numeric(parsed.newOwner)}
      )
      ON CONFLICT (chain_id, event_id) DO NOTHING;
    `;
  }

  /**
   * Periphery LaunchFeesClaimed: the payout of the extension claim earlier in
   * the same transaction. It is linked to that claim and never moves the
   * ledger again.
   */
  async insertZeroSeedLaunchFeesPaidEvent(
    key: EventKey,
    parsed: ZeroSeedLaunchFeesPaidInsert,
  ) {
    const poolKeyId = await this.zeroSeedLaunchPoolKeyId(
      parsed.coreAddress,
      parsed.poolId,
      parsed.extension,
    );
    if (await this.zeroSeedLaunchEventExists("fees_paid", key)) return;
    const launch = await this.zeroSeedLaunch(poolKeyId);
    const recipient = BigInt(parsed.recipient);
    if (
      launch.controller !== BigInt(key.emitter) ||
      BigInt(parsed.owner) !== launch.current_owner ||
      [
        0n,
        BigInt(parsed.coreAddress),
        BigInt(parsed.extension),
        BigInt(key.emitter),
        launch.token0,
        launch.token1,
      ].includes(recipient)
    )
      throw new Error(
        "Refusing zero-seed payout by another owner or to a sink recipient",
      );
    const [claim] = await this.sql<{ event_id: bigint }[]>`
      SELECT c.event_id
      FROM zero_seed_launch_fees_claimed c
      WHERE c.chain_id = ${this.chainId}
        AND c.pool_key_id = ${poolKeyId}
        AND c.block_number = ${key.blockNumber}
        AND c.transaction_index = ${key.transactionIndex}
        AND c.event_index < ${key.eventIndex}
        AND c.controller = ${this.numeric(key.emitter)}
        AND c.amount0 = ${this.numeric(parsed.amount0)}
        AND c.amount1 = ${this.numeric(parsed.amount1)}
        AND NOT EXISTS (SELECT 1 FROM zero_seed_launch_fees_paid p
                        WHERE p.chain_id = c.chain_id AND p.claimed_event_id = c.event_id)
      ORDER BY c.event_id DESC
      LIMIT 1`;
    if (!claim)
      throw new Error(
        `Zero-seed payout for pool ${parsed.poolId} without its extension claim`,
      );
    await this.sql`
      INSERT INTO zero_seed_launch_fees_paid
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, owner, recipient, amount0, amount1, claimed_event_id)
      VALUES (
        ${this.eventKeyValues(key)},
        ${poolKeyId},
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.owner)},
        ${this.numeric(parsed.recipient)},
        ${this.numeric(parsed.amount0)},
        ${this.numeric(parsed.amount1)},
        ${claim.event_id}
      )
      ON CONFLICT (chain_id, event_id) DO NOTHING;
    `;
  }

  /**
   * Why indexing a launch instance from `firstBlock` would miss events, or
   * undefined. Every extension event concerns a pool Core initialized with the
   * extension, so nothing is missed when the stream includes the deployment
   * block, or when this database indexed the deployment's ExtensionRegistered
   * and registered every launch pool Core initialized since.
   */
  async zeroSeedLaunchCatchUpProblem(
    coreAddress: `0x${string}`,
    extension: `0x${string}`,
    deploymentBlock: number,
    firstBlock: number,
  ): Promise<string | undefined> {
    if (firstBlock <= deploymentBlock) return undefined;
    const [row] = await this.sql<{ registered: boolean; missing: bigint }[]>`
      SELECT EXISTS (SELECT 1 FROM extension_registrations
                     WHERE chain_id = ${this.chainId}
                       AND emitter = ${this.numeric(coreAddress)}
                       AND pool_extension = ${this.numeric(extension)}) AS registered,
             (SELECT COUNT(*) FROM pool_keys pk
              WHERE pk.chain_id = ${this.chainId}
                AND pk.core_address = ${this.numeric(coreAddress)}
                AND pk.pool_extension = ${this.numeric(extension)}
                AND NOT EXISTS (SELECT 1 FROM zero_seed_launch_pool_keys z
                                WHERE z.pool_key_id = pk.pool_key_id)) AS missing`;
    if (row.registered && BigInt(row.missing) === 0n) return undefined;
    return `ZeroSeedLaunch ${extension} was deployed at block ${deploymentBlock} but indexing starts at block ${firstBlock} ${row.registered ? `with ${row.missing} launch pools initialized while launch support was off` : "without this database having indexed the deployment"}; roll the indexer back to block ${deploymentBlock - 1} and replay from the deployment block`;
  }

  /** A redelivered periphery log was already stored; its checks ran then. */
  private async zeroSeedLaunchEventExists(
    table: "owner_changed" | "fees_paid",
    key: EventKey,
  ): Promise<boolean> {
    const [row] = await this.sql<{ found: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ${this.sql(`zero_seed_launch_${table}`)}
        WHERE chain_id = ${this.chainId}
          AND block_number = ${key.blockNumber}
          AND transaction_index = ${key.transactionIndex}
          AND event_index = ${key.eventIndex}
      ) AS found`;
    return row.found;
  }

  // MEVCapture v2.1 (00139). The pool row is keyed on the pool initialization
  // block so a reorg that removes the initialization removes it too.
  public async insertMEVCaptureV21Pool(
    extension: `0x${string}`,
    poolId: `0x${string}`,
    key: EventKey,
  ) {
    const result = await this.sql`
      INSERT INTO mev_capture_v21_pools (pool_key_id, chain_id, extension, block_number)
      SELECT pool_key_id, ${this.chainId}, ${this.numeric(extension)}, ${key.blockNumber}
      FROM pool_keys
      WHERE chain_id = ${this.chainId}
        AND core_address = ${this.numeric(key.emitter)}
        AND pool_id = ${this.numeric(poolId)}
        AND pool_extension = ${this.numeric(extension)};
    `;
    if (result.count !== 1) {
      throw new Error(
        `v2.1 pool ${poolId} at block ${key.blockNumber} has no pool key on extension ${extension}`,
      );
    }
  }

  // Fails rather than dropping the event when the pool is not a v2.1 pool of
  // the emitting extension.
  public async insertMEVCaptureV21GateFailed(
    event: {
      coreAddress: `0x${string}`;
      poolId: `0x${string}`;
      lObs: number;
      eRef: number;
    },
    key: EventKey,
  ) {
    const result = await this.sql`
      INSERT INTO mev_capture_v21_gate_failures
        (chain_id, block_number, transaction_index, event_index, transaction_hash,
         emitter, pool_key_id, pool_id, l_obs, e_ref)
      SELECT ${this.chainId}, ${key.blockNumber}, ${key.transactionIndex},
             ${key.eventIndex}, ${this.numeric(key.transactionHash)},
             ${this.numeric(key.emitter)}, p.pool_key_id,
             ${this.numeric(event.poolId)}, ${event.lObs}, ${event.eRef}
      FROM pool_keys pk
      JOIN mev_capture_v21_pools p ON p.pool_key_id = pk.pool_key_id
      WHERE pk.chain_id = ${this.chainId}
        AND pk.core_address = ${this.numeric(event.coreAddress)}
        AND pk.pool_id = ${this.numeric(event.poolId)}
        AND p.extension = ${this.numeric(key.emitter)};
    `;
    if (result.count !== 1) {
      throw new Error(
        `AnchorGateFailed for pool ${event.poolId} at block ${key.blockNumber} does not match a v2.1 pool of ${key.emitter}`,
      );
    }
  }

  // Registers the pools of the extension whose initialization was indexed
  // before the worker was configured with it, keyed on that initialization
  // block. Returns only the pools it registered.
  public async registerIndexedMEVCaptureV21Pools(
    extension: `0x${string}`,
    coreAddress: `0x${string}`,
  ): Promise<{ poolKeyId: bigint; poolId: `0x${string}` }[]> {
    const rows = await this.sql<{ pool_key_id: bigint; pool_id: bigint }[]>`
      WITH registered AS (
        INSERT INTO mev_capture_v21_pools (pool_key_id, chain_id, extension, block_number)
        SELECT pk.pool_key_id, pk.chain_id, pk.pool_extension, pi.block_number
        FROM pool_keys pk
        JOIN pool_initializations pi
          ON pi.chain_id = pk.chain_id AND pi.pool_key_id = pk.pool_key_id
        WHERE pk.chain_id = ${this.chainId}
          AND pk.core_address = ${this.numeric(coreAddress)}
          AND pk.pool_extension = ${this.numeric(extension)}
        ON CONFLICT (pool_key_id) DO NOTHING
        RETURNING pool_key_id
      )
      SELECT r.pool_key_id, pk.pool_id
      FROM registered r
      JOIN pool_keys pk ON pk.pool_key_id = r.pool_key_id
      ORDER BY r.pool_key_id;
    `;
    return rows.map((row) => ({
      poolKeyId: BigInt(row.pool_key_id),
      poolId: `0x${BigInt(row.pool_id).toString(16).padStart(64, "0")}`,
    }));
  }

  public async getMEVCaptureV21PoolsTouchedInBlock(
    extension: `0x${string}`,
    coreAddress: `0x${string}`,
    blockNumber: number,
  ): Promise<{ poolKeyId: bigint; poolId: `0x${string}` }[]> {
    const rows = await this.sql<{ pool_key_id: bigint; pool_id: bigint }[]>`
      SELECT p.pool_key_id, pk.pool_id
      FROM mev_capture_v21_pools p
      JOIN pool_keys pk ON pk.pool_key_id = p.pool_key_id
      WHERE p.chain_id = ${this.chainId}
        AND p.extension = ${this.numeric(extension)}
        AND pk.core_address = ${this.numeric(coreAddress)}
        AND p.pool_key_id IN (
          SELECT pool_key_id FROM swaps
          WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber}
          UNION
          SELECT pool_key_id FROM position_updates
          WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber}
          UNION
          SELECT pool_key_id FROM pool_initializations
          WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber}
          UNION
          SELECT pool_key_id FROM mev_capture_v21_gate_failures
          WHERE chain_id = ${this.chainId} AND block_number = ${blockNumber}
        )
      ORDER BY p.pool_key_id;
    `;
    return rows.map((row) => ({
      poolKeyId: BigInt(row.pool_key_id),
      poolId: `0x${BigInt(row.pool_id).toString(16).padStart(64, "0")}`,
    }));
  }

  public async hasMEVCaptureV21Config(
    extension: `0x${string}`,
  ): Promise<boolean> {
    const rows = await this.sql`
      SELECT 1 FROM mev_capture_v21_configs
      WHERE chain_id = ${this.chainId} AND extension = ${this.numeric(extension)};
    `;
    return rows.length > 0;
  }

  public async insertMEVCaptureV21Config({
    extension,
    blockNumber,
    blockHash,
    config,
  }: {
    extension: `0x${string}`;
    blockNumber: number;
    blockHash: `0x${string}`;
    config: {
      halfLife: number;
      slopeK: number;
      segmentExp: number;
      segmentWidthMultiplier: number;
      jLin: number;
      maxFee: bigint;
      clampTicks: number;
      mGate: number;
    };
  }) {
    await this.sql`
      INSERT INTO mev_capture_v21_configs
        (chain_id, extension, block_number, block_hash, half_life, slope_k,
         segment_exp, segment_width_multiplier, j_lin, max_fee, clamp_ticks, m_gate)
      VALUES (${this.chainId}, ${this.numeric(extension)}, ${blockNumber},
              ${this.numeric(blockHash)}, ${config.halfLife}, ${config.slopeK},
              ${config.segmentExp}, ${config.segmentWidthMultiplier}, ${config.jLin},
              ${this.numeric(config.maxFee)}, ${config.clampTicks}, ${config.mGate});
    `;
  }

  // Groups the block's Swapped logs of v2.1 pools into forwarded swaps and
  // attributes every FeesAccumulated of those pools to the forwarded swap of
  // the Swapped log preceding it in the same transaction (see 00139). Throws
  // when a FeesAccumulated of a v2.1 pool has no such Swapped by the extension.
  public async insertMEVCaptureV21SwapSurcharges(
    extension: `0x${string}`,
    coreAddress: `0x${string}`,
    blockNumber: number,
  ): Promise<number> {
    const unattributed = await this.sql<{ event_id: bigint }[]>`
      SELECT fa.event_id
      FROM fees_accumulated fa
      JOIN mev_capture_v21_pools p ON p.pool_key_id = fa.pool_key_id
      JOIN pool_keys pk ON pk.pool_key_id = fa.pool_key_id
      LEFT JOIN LATERAL (
        SELECT s.locker
        FROM swaps s
        WHERE s.pool_key_id = fa.pool_key_id
          AND s.chain_id = fa.chain_id
          AND s.block_number = fa.block_number
          AND s.transaction_index = fa.transaction_index
          AND s.event_id < fa.event_id
        ORDER BY s.event_id DESC
        LIMIT 1
      ) prev ON true
      WHERE fa.chain_id = ${this.chainId}
        AND fa.block_number = ${blockNumber}
        AND p.extension = ${this.numeric(extension)}
        AND pk.core_address = ${this.numeric(coreAddress)}
        AND (prev.locker IS NULL OR prev.locker <> p.extension);
    `;
    if (unattributed.length > 0) {
      throw new Error(
        `FeesAccumulated of a v2.1 pool at block ${blockNumber} does not follow a Swapped of ${extension} in its transaction (event ids ${unattributed.map((r) => r.event_id).join(",")})`,
      );
    }
    const result = await this.sql`
      WITH v21 AS (
        SELECT p.pool_key_id, p.extension
        FROM mev_capture_v21_pools p
        JOIN pool_keys pk ON pk.pool_key_id = p.pool_key_id
        WHERE p.chain_id = ${this.chainId}
          AND p.extension = ${this.numeric(extension)}
          AND pk.core_address = ${this.numeric(coreAddress)}
      ), txs AS (
        SELECT DISTINCT s.transaction_index
        FROM swaps s
        JOIN v21 ON v21.pool_key_id = s.pool_key_id
        WHERE s.chain_id = ${this.chainId} AND s.block_number = ${blockNumber}
      ), ordered AS (
        SELECT s.transaction_index, s.transaction_hash, s.event_id, s.pool_key_id,
               s.locker, s.delta0, s.delta1,
               (lag(s.pool_key_id) OVER w IS DISTINCT FROM s.pool_key_id
                 OR lag(s.locker) OVER w IS DISTINCT FROM s.locker)::int4 AS starts
        FROM swaps s
        JOIN txs ON txs.transaction_index = s.transaction_index
        WHERE s.chain_id = ${this.chainId} AND s.block_number = ${blockNumber}
        WINDOW w AS (PARTITION BY s.transaction_index ORDER BY s.event_id)
      ), runs AS (
        SELECT o.*,
               sum(o.starts) OVER (PARTITION BY o.transaction_index ORDER BY o.event_id) AS run
        FROM ordered o
      ), calls AS (
        SELECT r.*
        FROM runs r
        JOIN v21 ON v21.pool_key_id = r.pool_key_id AND r.locker = v21.extension
      ), fees AS (
        SELECT prev.transaction_index, prev.run,
               count(*)::int4 AS charged, sum(fa.delta0) AS fee0, sum(fa.delta1) AS fee1
        FROM fees_accumulated fa
        JOIN v21 ON v21.pool_key_id = fa.pool_key_id
        CROSS JOIN LATERAL (
          SELECT c.transaction_index, c.run
          FROM calls c
          WHERE c.pool_key_id = fa.pool_key_id
            AND c.transaction_index = fa.transaction_index
            AND c.event_id < fa.event_id
          ORDER BY c.event_id DESC
          LIMIT 1
        ) prev
        WHERE fa.chain_id = ${this.chainId} AND fa.block_number = ${blockNumber}
        GROUP BY prev.transaction_index, prev.run
      )
      INSERT INTO mev_capture_v21_swap_surcharges
        (chain_id, block_number, transaction_index, transaction_hash, pool_key_id,
         first_event_id, last_event_id, core_calls, charged_calls,
         core_delta0, core_delta1, surcharge0, surcharge1)
      SELECT ${this.chainId}, ${blockNumber}, c.transaction_index,
             min(c.transaction_hash), min(c.pool_key_id),
             min(c.event_id), max(c.event_id), count(*)::int4,
             coalesce(min(f.charged), 0), sum(c.delta0), sum(c.delta1),
             coalesce(min(f.fee0), 0), coalesce(min(f.fee1), 0)
      FROM calls c
      LEFT JOIN fees f ON f.transaction_index = c.transaction_index AND f.run = c.run
      GROUP BY c.transaction_index, c.run;
    `;
    return result.count;
  }

  public async insertMEVCaptureV21AnchorState({
    poolKeyId,
    blockNumber,
    blockHash,
    anchor,
  }: {
    poolKeyId: bigint;
    blockNumber: number;
    blockHash: `0x${string}`;
    anchor: {
      lastUpdateTime: number;
      lRefTime: number;
      lastPosTime: number;
      lRefBits: number;
      snapBits: number;
      lRefRaiseTime: number;
      anchorX16: bigint;
    };
  }) {
    await this.sql`
      INSERT INTO mev_capture_v21_anchor_states
        (pool_key_id, block_number, chain_id, block_hash, last_update_time,
         l_ref_time, last_pos_time, l_ref_bits, snap_bits, l_ref_raise_time,
         anchor_x16)
      VALUES (${poolKeyId}, ${blockNumber}, ${this.chainId},
              ${this.numeric(blockHash)}, ${anchor.lastUpdateTime},
              ${anchor.lRefTime}, ${anchor.lastPosTime}, ${anchor.lRefBits},
              ${anchor.snapBits}, ${anchor.lRefRaiseTime}, ${anchor.anchorX16});
    `;
  }

  public async insertProtocolFeesWithdrawn(
    event: ProtocolFeesWithdrawnInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO protocol_fees_withdrawn
        (chain_id,
         block_number,
         transaction_index,
         event_index,
         transaction_hash,
         emitter,
         recipient,
         token,
         amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.recipient)},
        ${this.numeric(event.token)},
        ${this.numeric(event.amount)}
      );
    `;
  }

  public async insertProtocolFeesPaid(
    event: ProtocolFeesPaidInsert,
    key: EventKey,
  ) {
    const {
      locker,
      poolId,
      salt,
      bounds: { lower, upper },
      delta0,
      delta1,
    } = event;

    await this.sql`
      INSERT INTO protocol_fees_paid
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(locker)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        ${this.numeric(delta0)},
        ${this.numeric(delta1)}
      );
    `;
  }

  public async insertPositionFeesWithheld(
    event: PositionFeesWithheldInsert,
    key: EventKey,
  ) {
    const {
      locker,
      poolId,
      salt,
      bounds: { lower, upper },
      amount0,
      amount1,
    } = event;

    if (amount0 < 0n || amount1 < 0n) {
      throw new Error("position_fees_withheld amounts must be non-negative");
    }
    if (amount0 === 0n && amount1 === 0n) return;

    await this.sql`
      INSERT INTO position_fees_withheld
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, amount0, amount1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(locker)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        ${this.numeric(amount0)},
        ${this.numeric(amount1)}
      );
    `;
  }

  public async insertPositionWithdrawalFeesWithheld(
    event: PositionWithdrawalFeesWithheldInsert,
    key: EventKey,
  ) {
    const {
      locker,
      poolId,
      salt,
      bounds: { lower, upper },
      amount0,
      amount1,
      withdrawalProtocolFeeDivisor,
    } = event;

    if (withdrawalProtocolFeeDivisor === 0n) return;

    await this.sql`
      WITH pool_key AS (
        SELECT pool_key_id, fee, fee_denominator
        FROM pool_keys
        WHERE chain_id = ${this.chainId}
          AND core_address = ${this.numeric(key.emitter)}
          AND pool_id = ${this.numeric(poolId)}
      ),
      computed AS (
        SELECT
          pool_key_id,
          CASE
            WHEN ${this.numeric(amount0)} > 0
              THEN CEIL((${this.numeric(
                amount0,
              )} * fee) / (fee_denominator * ${this.numeric(
                withdrawalProtocolFeeDivisor,
              )}))
            ELSE 0
          END AS protocol_fee0,
          CASE
            WHEN ${this.numeric(amount1)} > 0
              THEN CEIL((${this.numeric(
                amount1,
              )} * fee) / (fee_denominator * ${this.numeric(
                withdrawalProtocolFeeDivisor,
              )}))
            ELSE 0
          END AS protocol_fee1
        FROM pool_key
      )
      INSERT INTO position_fees_withheld
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, amount0, amount1)
      SELECT
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        c.pool_key_id,
        ${this.numeric(locker)},
        ${this.numeric(salt)},
        ${lower},
        ${upper},
        c.protocol_fee0,
        c.protocol_fee1
      FROM computed c
      WHERE c.protocol_fee0 <> 0 OR c.protocol_fee1 <> 0;
    `;
  }

  public async insertExtensionRegistered(
    event: ExtensionRegisteredInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO extension_registrations
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_extension)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.extension)}
      );
    `;
  }

  public async insertStarknetExtensionCallPoints(
    event: { extension: AddressValue; callPoints: number },
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO starknet_extension_call_points
        (chain_id, block_number, transaction_index, event_index,
         transaction_hash, emitter, pool_extension, call_points)
      VALUES (${this.chainId}, ${key.blockNumber}, ${key.transactionIndex},
              ${key.eventIndex}, ${this.numeric(key.transactionHash)},
              ${this.numeric(key.emitter)}, ${this.numeric(event.extension)},
              ${event.callPoints});
    `;
  }

  public async insertRegistration(
    event: TokenRegistrationInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO token_registrations
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, address, name, symbol, decimals, total_supply)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.address)},
        ${this.numeric(event.name)},
        ${this.numeric(event.symbol)},
        ${event.decimals},
        ${this.numeric(event.totalSupply)}
      );
    `;
  }

  public async insertRegistrationV3(
    event: TokenRegistrationV3Insert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO token_registrations_v3
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, address, name, symbol, decimals, total_supply)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.address)},
        ${event.name},
        ${event.symbol},
        ${event.decimals},
        ${this.numeric(event.totalSupply)}
      );
    `;
  }

  public async insertStakerStakedEvent(
    event: StakerStakedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO staker_staked
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, from_address, amount, delegate)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.from)},
        ${this.numeric(event.amount)},
        ${this.numeric(event.delegate)}
      );
    `;
  }

  public async insertStakerWithdrawnEvent(
    event: StakerWithdrawnInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO staker_withdrawn
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, from_address, amount, recipient, delegate)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.from)},
        ${this.numeric(event.amount)},
        ${this.numeric(event.recipient)},
        ${this.numeric(event.delegate)}
      );
    `;
  }

  public async insertGovernorReconfiguredEvent(
    event: GovernorReconfiguredInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO governor_reconfigured
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, version, voting_start_delay, voting_period, voting_weight_smoothing_duration,
         quorum, proposal_creation_threshold, execution_delay, execution_window)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.version)},
        ${this.numeric(event.votingStartDelay)},
        ${this.numeric(event.votingPeriod)},
        ${this.numeric(event.votingWeightSmoothingDuration)},
        ${this.numeric(event.quorum)},
        ${this.numeric(event.proposalCreationThreshold)},
        ${this.numeric(event.executionDelay)},
        ${this.numeric(event.executionWindow)}
      );
    `;
  }

  public async insertGovernorProposedEvent(
    event: GovernorProposedInsert,
    key: EventKey,
  ) {
    const configVersion =
      event.configVersion === null ? 0n : BigInt(event.configVersion);
    const typedConfigVersion = this.numeric(configVersion);

    await this.sql`
      INSERT INTO governor_proposed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, proposer, config_version)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.proposal_id)},
        ${this.numeric(event.proposer)},
        ${typedConfigVersion}
      );
    `;

    for (let i = 0; i < event.calls.length; i++) {
      const call = event.calls[i];
      const calldata = call.calldata.map((value) => BigInt(value).toString());

      await this.sql`
        INSERT INTO governor_proposed_calls
          (chain_id, emitter, proposal_id, index, to_address, selector, calldata)
        VALUES (
          ${this.chainId},
          ${this.numeric(key.emitter)},
          ${this.numeric(event.proposal_id)},
          ${i},
          ${this.numeric(call.to)},
          ${this.numeric(call.selector)},
          ${calldata}
        );
      `;
    }
  }

  public async insertGovernorCanceledEvent(
    event: GovernorCanceledInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO governor_canceled
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.proposal_id)}
      )
      ON CONFLICT (chain_id, proposal_id) DO NOTHING;
    `;
  }

  public async insertGovernorVotedEvent(
    event: GovernorVotedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO governor_voted
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, voter, weight, yea)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.proposal_id)},
        ${this.numeric(event.voter)},
        ${this.numeric(event.weight)},
        ${event.yea}
      );
    `;
  }

  public async insertGovernorExecutedEvent(
    event: GovernorExecutedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO governor_executed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.proposal_id)}
      );
    `;

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i].map((value) => BigInt(value).toString());

      await this.sql`
        INSERT INTO governor_executed_results
          (chain_id, emitter, proposal_id, index, results)
        VALUES (
          ${this.chainId},
          ${this.numeric(key.emitter)},
          ${this.numeric(event.proposal_id)},
          ${i},
          ${result}
        );
      `;
    }
  }

  public async insertGovernorProposalDescribedEvent(
    event: GovernorProposalDescribedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO governor_proposal_described
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, description)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.proposal_id)},
        ${event.description}
      );
    `;
  }

  public async insertFeesAccumulatedEvent(
    event: FeesAccumulatedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO fees_accumulated
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_key_id, delta0, delta1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.amount0)},
        ${this.numeric(event.amount1)}
      );
    `;
  }

  public async insertSwappedEvent(event: SwapEventInsert, key: EventKey) {
    await this.sql`
      INSERT INTO swaps
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after, liquidity_after)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND core_address = ${this.numeric(key.emitter)}
            AND pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.locker)},
        ${this.numeric(event.delta0)},
        ${this.numeric(event.delta1)},
        ${this.numeric(event.sqrtRatioAfter)},
        ${event.tickAfter},
        ${this.numeric(event.liquidityAfter)}
      );
    `;
  }

  public async deleteOldBlockNumbers(invalidatedBlockNumber: number) {
    await this.sql`
      DELETE FROM blocks WHERE chain_id = ${this.chainId} AND block_number >= ${invalidatedBlockNumber};
    `;
  }

  public async insertTWAMMOrderUpdatedEvent(
    event: TwammOrderUpdatedInsert,
    key: EventKey,
  ) {
    const { orderKey, poolId, coreAddress } = event;

    const [sale_rate_delta0, sale_rate_delta1] = event.is_selling_token1
      ? [0, event.saleRateDelta]
      : [event.saleRateDelta, 0];

    await this.sql`
      INSERT INTO twamm_order_updates
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, sale_rate_delta0, sale_rate_delta1, start_time, end_time, is_selling_token1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(coreAddress)}
            AND pk.pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(BigInt(event.owner))},
        ${this.numeric(BigInt(event.salt))},
        ${this.numeric(BigInt(sale_rate_delta0))},
        ${this.numeric(BigInt(sale_rate_delta1))},
        ${new Date(Number(orderKey.startTime * 1000n))},
        ${new Date(Number(orderKey.endTime * 1000n))},
        ${event.is_selling_token1}
      );
    `;
  }

  public async insertTWAMMOrderProceedsWithdrawnEvent(
    event: TwammOrderProceedsWithdrawnInsert,
    key: EventKey,
  ) {
    const { orderKey, poolId } = event;

    const [amount0, amount1] = event.is_selling_token1
      ? [BigInt(event.amount), 0n]
      : [0n, BigInt(event.amount)];

    await this.sql`
      INSERT INTO twamm_proceeds_withdrawals
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, amount0, amount1, start_time, end_time, is_selling_token1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(event.coreAddress)}
            AND pk.pool_id = ${this.numeric(poolId)}
        ),
        ${this.numeric(BigInt(event.owner))},
        ${this.numeric(BigInt(event.salt))},
        ${this.numeric(amount0)},
        ${this.numeric(amount1)},
        ${new Date(Number(orderKey.startTime * 1000n))},
        ${new Date(Number(orderKey.endTime * 1000n))},
        ${event.is_selling_token1}
      );
    `;
  }

  public async insertTWAMMVirtualOrdersExecutedEvent(
    event: TwammVirtualOrdersExecutedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO twamm_virtual_order_executions
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, token0_sale_rate, token1_sale_rate)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(event.coreAddress)}
            AND pk.pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.saleRateToken0)},
        ${this.numeric(event.saleRateToken1)}
      );
    `;
  }

  public async insertBoostedFeesDonatedEvent(
    event: BoostedFeesDonatedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO boosted_fees_donated
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, donate_rate0, donate_rate1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(event.coreAddress)}
            AND pk.pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.donateRate0)},
        ${this.numeric(event.donateRate1)}
      );
    `;
  }

  public async insertBoostedFeesPoolBoostedEvent(
    event: BoostedFeesPoolBoostedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO boosted_fees_events
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, start_time, end_time, rate0, rate1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(event.coreAddress)}
            AND pk.pool_id = ${this.numeric(event.poolId)}
        ),
        ${new Date(Number(event.startTime * 1000n))},
        ${new Date(Number(event.endTime * 1000n))},
        ${this.numeric(event.rate0)},
        ${this.numeric(event.rate1)}
      );
    `;
  }

  public async insertAuctionCompletedEvent(
    event: AuctionCompletedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO auction_completed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         token_id, token0, token1, config, creator_amount, boost_amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.tokenId)},
        ${this.numeric(event.auctionKey.token0)},
        ${this.numeric(event.auctionKey.token1)},
        ${this.numeric(event.auctionKey.config)},
        ${this.numeric(event.creatorAmount)},
        ${this.numeric(event.boostAmount)}
      );
    `;
  }

  public async insertAuctionFundsAddedEvent(
    event: AuctionFundsAddedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO auction_funds_added
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         token_id, token0, token1, config, sale_rate)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.tokenId)},
        ${this.numeric(event.auctionKey.token0)},
        ${this.numeric(event.auctionKey.token1)},
        ${this.numeric(event.auctionKey.config)},
        ${this.numeric(event.saleRate)}
      );
    `;
  }

  public async insertAuctionBoostStartedEvent(
    event: AuctionBoostStartedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO auction_boost_started
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         token0, token1, config, boost_rate, boost_end_time)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.auctionKey.token0)},
        ${this.numeric(event.auctionKey.token1)},
        ${this.numeric(event.auctionKey.config)},
        ${this.numeric(event.boostRate)},
        ${new Date(Number(BigInt(event.boostEndTime) * 1000n))}
      );
    `;
  }

  public async insertCreatorProceedsCollectedEvent(
    event: CreatorProceedsCollectedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO auction_creator_proceeds_collected
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         token_id, token0, token1, config, recipient, amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(event.tokenId)},
        ${this.numeric(event.auctionKey.token0)},
        ${this.numeric(event.auctionKey.token1)},
        ${this.numeric(event.auctionKey.config)},
        ${this.numeric(event.recipient)},
        ${this.numeric(event.amount)}
      );
    `;
  }

  public async insertOrderPlacedEvent(
    event: LimitOrderPlacedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO limit_order_placed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, token0, token1, tick, liquidity, amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.locker)},
        ${this.numeric(event.salt)},
        ${this.numeric(event.token0)},
        ${this.numeric(event.token1)},
        ${event.tick},
        ${this.numeric(event.liquidity)},
        ${this.numeric(event.amount)}
      );
    `;
  }

  public async insertOrderClosedEvent(
    event: LimitOrderClosedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO limit_order_closed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, token0, token1, tick, amount0, amount1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.locker)},
        ${this.numeric(event.salt)},
        ${this.numeric(event.token0)},
        ${this.numeric(event.token1)},
        ${event.tick},
        ${this.numeric(event.amount0)},
        ${this.numeric(event.amount1)}
      );
    `;
  }

  public async insertSplineLiquidityUpdatedEvent(
    event: LiquidityUpdatedInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO spline_liquidity_updated
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, sender, liquidity_factor, shares, amount0, amount1, protocol_fees0, protocol_fees1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pool_key_id
          FROM pool_keys
          WHERE chain_id = ${this.chainId}
            AND pool_id = ${this.numeric(event.poolId)}
        ),
        ${this.numeric(event.sender)},
        ${this.numeric(event.liquidityFactor)},
        ${this.numeric(event.shares)},
        ${this.numeric(event.amount0)},
        ${this.numeric(event.amount1)},
        ${this.numeric(event.protocolFees0)},
        ${this.numeric(event.protocolFees1)}
      );
    `;
  }

  async insertOracleSnapshotEvent(
    snapshot: OracleSnapshotInsert,
    key: EventKey,
  ) {
    await this.sql`
      INSERT INTO oracle_snapshots
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         token0, token1, snapshot_block_timestamp, snapshot_tick_cumulative, snapshot_seconds_per_liquidity_cumulative)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(snapshot.token0)},
        ${this.numeric(snapshot.token1)},
        ${this.numeric(snapshot.timestamp)},
        ${this.numeric(snapshot.tickCumulative)},
        ${this.numeric(snapshot.secondsPerLiquidityCumulative)}
      );
    `;
  }

  async insertIncentivesRefundedEvent(
    key: EventKey,
    parsed: IncentivesRefundedInsert,
  ) {
    await this.sql`
      INSERT INTO incentives_refunded
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, owner, token, root, refund_amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(parsed.key.owner)},
        ${this.numeric(parsed.key.token)},
        ${this.numeric(parsed.key.root)},
        ${this.numeric(parsed.refundAmount)}
      );
    `;
  }

  async insertIncentivesFundedEvent(
    key: EventKey,
    parsed: IncentivesFundedInsert,
  ) {
    await this.sql`
      INSERT INTO incentives_funded
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, owner, token, root, amount_next)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(parsed.key.owner)},
        ${this.numeric(parsed.key.token)},
        ${this.numeric(parsed.key.root)},
        ${this.numeric(parsed.amountNext)}
      );
    `;
  }

  async insertTokenWrapperDeployed(
    key: EventKey,
    parsed: TokenWrapperDeployedInsert,
  ) {
    await this.sql`
      INSERT INTO token_wrapper_deployed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_wrapper, underlying_token, unlock_time)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(parsed.tokenWrapper)},
        ${this.numeric(parsed.underlyingToken)},
        ${this.numeric(parsed.unlockTime)}
      );
    `;
  }

  async insertVe33StakeChangedEvent(
    key: EventKey,
    parsed: Ve33StakeChangedInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_stake_changed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         owner, stake_id, stake_salt, stake_end_time, delta)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(parsed.owner)},
        ${this.numeric(parsed.stake.id)},
        ${this.numeric(parsed.stake.salt)},
        ${new Date(Number(BigInt(parsed.stake.endTime) * 1000n))},
        ${this.numeric(parsed.delta)}
      );
    `;
  }

  async insertVe33VoteWeightAppliedEvent(
    key: EventKey,
    parsed: Ve33VoteWeightAppliedInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_vote_weight_applied
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, owner, stake_id, stake_salt, stake_end_time, weight,
         voted_swap_fee, swap_fee)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(parsed.coreAddress)}
            AND pk.pool_id = ${this.numeric(parsed.poolId)}
        ),
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.owner)},
        ${this.numeric(parsed.stake.id)},
        ${this.numeric(parsed.stake.salt)},
        ${new Date(Number(BigInt(parsed.stake.endTime) * 1000n))},
        ${this.numeric(parsed.weight)},
        ${this.numeric(parsed.votedSwapFee)},
        ${this.numeric(parsed.swapFee)}
      );
    `;
  }

  async insertVe33PoolFeesAccountedEvent(
    key: EventKey,
    parsed: Ve33PoolFeesAccountedInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_pool_fees_accounted
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, amount0, amount1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(parsed.coreAddress)}
            AND pk.pool_id = ${this.numeric(parsed.poolId)}
        ),
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.amount0)},
        ${this.numeric(parsed.amount1)}
      );
    `;
  }

  async insertVe33PoolFeesClaimedEvent(
    key: EventKey,
    parsed: Ve33PoolFeesClaimedInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_pool_fees_claimed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, owner, stake_id, stake_salt, stake_end_time, amount0, amount1)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(parsed.coreAddress)}
            AND pk.pool_id = ${this.numeric(parsed.poolId)}
        ),
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.owner)},
        ${this.numeric(parsed.stake.id)},
        ${this.numeric(parsed.stake.salt)},
        ${new Date(Number(BigInt(parsed.stake.endTime) * 1000n))},
        ${this.numeric(parsed.amount0)},
        ${this.numeric(parsed.amount1)}
      );
    `;
  }

  async insertVe33EmissionsScheduledEvent(
    key: EventKey,
    parsed: Ve33EmissionsScheduledInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_emissions_scheduled
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         funder, start_time, end_time, reward_rate, amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        ${this.numeric(parsed.funder)},
        ${new Date(Number(BigInt(parsed.startTime) * 1000n))},
        ${new Date(Number(BigInt(parsed.endTime) * 1000n))},
        ${this.numeric(parsed.rewardRate)},
        ${this.numeric(parsed.amount)}
      );
    `;
  }

  async insertVe33PoolEmissionsAccruedEvent(
    key: EventKey,
    parsed: Ve33PoolEmissionsAccruedInsert,
  ) {
    await this.sql`
      INSERT INTO ve33_pool_emissions_accrued
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(parsed.coreAddress)}
            AND pk.pool_id = ${this.numeric(parsed.poolId)}
        ),
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.amount)}
      );
    `;
  }

  async insertVe33RewardsClaimedEvent(
    key: EventKey,
    parsed: Ve33RewardsClaimedInsert,
  ) {
    const { lower, upper } = parsed.bounds;

    await this.sql`
      INSERT INTO ve33_rewards_claimed
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, pool_id, owner, position_id, salt, lower_bound, upper_bound, amount)
      VALUES (
        ${this.chainId},
        ${key.blockNumber},
        ${key.transactionIndex},
        ${key.eventIndex},
        ${this.numeric(key.transactionHash)},
        ${this.numeric(key.emitter)},
        (
          SELECT pk.pool_key_id
          FROM pool_keys pk
          WHERE pk.chain_id = ${this.chainId}
            AND pk.core_address = ${this.numeric(parsed.coreAddress)}
            AND pk.pool_id = ${this.numeric(parsed.poolId)}
        ),
        ${this.numeric(parsed.poolId)},
        ${this.numeric(parsed.owner)},
        ${this.numeric(parsed.positionId)},
        ${this.numeric(parsed.salt)},
        ${lower},
        ${upper},
        ${this.numeric(parsed.amount)}
      );
    `;
  }
}
