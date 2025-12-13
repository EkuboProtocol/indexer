import type { Sql } from "postgres";
import { type EventKey } from "./eventKey";
import postgres from "postgres";

export type NumericValue = bigint | number | `0x${string}`;
export type AddressValue = bigint | `0x${string}`;

export interface IndexerCursor {
  orderKey: bigint;
  uniqueKey?: `0x${string}`;
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

const NumericIntegerType: postgres.PostgresType<bigint> = {
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

// Data access object that manages inserts/deletes
export class DAO {
  private readonly chainId: bigint;
  private readonly sql: Sql<{ numeric: bigint; bigint: bigint }>;

  private constructor(
    sql: Sql<{ numeric: bigint; bigint: bigint }>,
    chainId: bigint
  ) {
    this.chainId = chainId;
    this.sql = sql;
  }

  public static create(pgConnectionString: string, chainId: bigint): DAO {
    // should be a single connection that never closes
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
    const rows = await this
      .sql`SELECT pg_advisory_lock(hashtext('ekubo-indexer-' || ${this.chainId}));`;
    if (!rows.length)
      throw new Error(`Failed to acquire lock for chain ID ${this.chainId}`);
  }

  public async releaseLock(): Promise<void> {
    const rows = await this
      .sql`SELECT pg_advisory_unlock(hashtext('ekubo-indexer-' || ${this.chainId}));`;
    if (!rows.length)
      throw new Error(`Failed to release lock for chain ID ${this.chainId}`);
  }

  public async begin<T>(
    cb: (dao: DAO) => T | Promise<T>
  ): Promise<UnwrapPromiseArray<T>> {
    return this.sql.begin((sql) => {
      const dao = new DAO(sql, this.chainId);
      return cb(dao);
    });
  }

  public async end() {
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

  public async writeCursor(
    cursor: IndexerCursor,
    expectedCursor: IndexerCursor
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
      INSERT INTO indexer_cursor (chain_id, order_key, unique_key, last_updated)
      VALUES (${this.chainId}, ${cursor.orderKey}, ${this.numeric(
      uniqueKey
    )}, NOW())
      ON CONFLICT (chain_id) DO UPDATE
        SET order_key = excluded.order_key,
            unique_key = excluded.unique_key,
            last_updated = NOW()
        WHERE indexer_cursor.order_key = ${expectedCursor.orderKey}
          AND indexer_cursor.unique_key IS NOT DISTINCT FROM ${this.numeric(
            expectedUniqueKey
          )}
      RETURNING order_key, unique_key;
    `;

    if (!updatedCursor) {
      throw new Error(
        `Refused to overwrite cursor because database state differed from expected (expected: ${this.describeCursor(
          expectedCursor
        )})`
      );
    }

    return cursor;
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

  public async insertBlock({
    number,
    hash,
    time,
    baseFeePerGas,
  }: {
    number: bigint;
    hash: bigint;
    time: Date;
    baseFeePerGas: bigint | null;
  }) {
    await this.sql`
      INSERT INTO blocks (chain_id, block_number, block_hash, block_time, base_fee_per_gas)
      VALUES (${this.chainId}, ${number}, ${this.numeric(
      hash
    )}, ${time}, ${this.numeric(baseFeePerGas)});
    `;
  }

  public async insertNonfungibleTokenTransferEvent(
    transfer: NonfungibleTokenTransfer,
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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

  public async insertPositionUpdatedEventWithSyntheticProtocolFeesPaidEvent(
    event: PositionUpdatedInsert,
    key: EventKey
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
          delta0
        )} * fee_denominator) / (fee_denominator - fee)) - ${this.numeric(
      delta0
    )},
        FLOOR((${this.numeric(
          delta1
        )} * fee_denominator) / (fee_denominator - fee)) - ${this.numeric(
      delta1
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
    key: EventKey
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
    key: EventKey
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
      WITH inserted_pool_key AS (
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
        inserted_pool_key.pool_key_id,
        ${tick},
        ${this.numeric(sqrtRatio)}
      FROM inserted_pool_key;
    `;
  }

  public async insertMEVCapturePoolKey(
    coreAddress: `0x${string}`,
    poolId: `0x${string}`
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

  public async insertProtocolFeesWithdrawn(
    event: ProtocolFeesWithdrawnInsert,
    key: EventKey
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
    key: EventKey
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

  public async insertExtensionRegistered(
    event: ExtensionRegisteredInsert,
    key: EventKey
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

  public async insertRegistration(
    event: TokenRegistrationInsert,
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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

  /**
   * Deletes all the blocks equal to or greater than the given block number, cascades to all the other tables.
   * @param invalidatedBlockNumber the block number for which data in the database should be removed
   */
  public async deleteOldBlockNumbers(invalidatedBlockNumber: number) {
    await this.sql`
      DELETE
      FROM blocks
      WHERE chain_id = ${this.chainId} AND block_number >= ${invalidatedBlockNumber};
    `;
  }

  public async insertTWAMMOrderUpdatedEvent(
    event: TwammOrderUpdatedInsert,
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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

  public async insertOrderPlacedEvent(
    event: LimitOrderPlacedInsert,
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    key: EventKey
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
    parsed: IncentivesRefundedInsert
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
    parsed: IncentivesFundedInsert
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
    parsed: TokenWrapperDeployedInsert
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
}
