import { Client } from "pg";
import { type EventKey } from "./eventKey.ts";

export type NumericValue = bigint | number | `0x${string}`;
export type AddressValue = bigint | `0x${string}`;

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
  lower: NumericValue;
  upper: NumericValue;
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
  tickSpacing: number;
  extension: AddressValue;
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
  poolId: `0x${string}`;
  orderKey: TwammOrderKeyInsert;
  saleRateDelta: bigint;
  owner: AddressValue;
  salt: NumericValue;
}

export interface TwammOrderProceedsWithdrawnInsert {
  poolId: `0x${string}`;
  orderKey: TwammOrderKeyInsert;
  amount: NumericValue;
  owner: AddressValue;
  salt: NumericValue;
}

export interface TwammVirtualOrdersExecutedInsert {
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

// Data access object that manages inserts/deletes
export class DAO {
  private pg: Client;
  private chainId: bigint;
  private indexerName: string;

  constructor(pg: Client, chainId: bigint, indexerName: string) {
    this.pg = pg;
    this.chainId = chainId;
    this.indexerName = indexerName;
  }

  public async beginTransaction(): Promise<void> {
    await this.pg.query("BEGIN");
  }

  public async commitTransaction(): Promise<void> {
    await this.pg.query("COMMIT");
  }

  public async initializeState() {
    await this.beginTransaction();
    const cursor = await this.loadCursor();
    // we need to clear anything that was potentially inserted as pending before starting
    if (cursor) {
      await this.deleteOldBlockNumbers(Number(cursor.orderKey) + 1);
    }
    await this.commitTransaction();
    return cursor;
  }

  private async loadCursor(): Promise<
    | {
        orderKey: bigint;
        uniqueKey: `0x${string}`;
      }
    | { orderKey: bigint }
    | null
  > {
    const { rows } = await this.pg.query({
      text: `SELECT order_key, unique_key FROM indexer_cursor WHERE indexer_name = $1`,
      values: [this.indexerName],
    });
    if (rows.length === 1) {
      const { order_key, unique_key } = rows[0];

      if (unique_key === null) {
        return {
          orderKey: BigInt(order_key),
        };
      } else {
        return {
          orderKey: BigInt(order_key),
          uniqueKey: `0x${BigInt(unique_key).toString(16)}`,
        };
      }
    } else {
      return null;
    }
  }

  public async writeCursor(cursor: { orderKey: bigint; uniqueKey?: string }) {
    await this.pg.query({
      text: `
        INSERT INTO indexer_cursor (indexer_name, order_key, unique_key, last_updated)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (indexer_name) DO UPDATE SET order_key    = excluded.order_key,
                                                  unique_key   = excluded.unique_key,
                                                  last_updated = NOW();
      `,
      values: [
        this.indexerName,
        cursor.orderKey,
        typeof cursor.uniqueKey !== "undefined"
          ? BigInt(cursor.uniqueKey)
          : null,
      ],
    });
  }

  public async insertBlock({
    number,
    hash,
    time,
  }: {
    number: bigint;
    hash: bigint;
    time: Date;
  }) {
    await this.pg.query({
      text: `INSERT INTO blocks (chain_id, block_number, block_hash, block_time)
                   VALUES ($1, $2, $3, $4);`,
      values: [this.chainId, number, hash, time],
    });
  }

  public async insertNonfungibleTokenTransferEvent(
    transfer: NonfungibleTokenTransfer,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO nonfungible_token_transfers
            (chain_id,
              block_number,
              transaction_index,
              event_index,
              transaction_hash,
              emitter,
              token_id,
              from_address,
              to_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        transfer.id,
        transfer.from,
        transfer.to,
      ],
    });
  }

  public async insertPositionMintedWithReferrerEvent(
    event: PositionMintedWithReferrerInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO position_minted_with_referrer
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_id, referrer)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.tokenId,
        event.referrer,
      ],
    });
  }

  public async insertPositionUpdatedEvent(
    event: PositionUpdatedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO position_updates
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, liquidity_delta, delta0, delta1)
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
          $7,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14
        );
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.locker,

        event.poolId,

        event.params.salt,
        event.params.bounds.lower,
        event.params.bounds.upper,

        event.params.liquidityDelta,
        event.delta0,
        event.delta1,
      ],
    });
  }

  public async insertPositionUpdatedEventWithSyntheticProtocolFeesPaidEvent(
    event: PositionUpdatedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        WITH 
          inserted_position_update AS (
            INSERT INTO position_updates
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
            pool_key_id, locker, salt, lower_bound, upper_bound, liquidity_delta, delta0, delta1)
              VALUES (
                $1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                $7, $9, $10, $11, $12, $13, $14
              )
          )
          INSERT INTO protocol_fees_paid
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
                SELECT $1, $2, $3, $4, $5, $6,
                    pool_key_id,
                    $7, $9, $10, $11, 
                    FLOOR(($13::numeric * fee_denominator) / (fee_denominator - fee)) - $13,
                    FLOOR(($14::numeric * fee_denominator) / (fee_denominator - fee)) - $14
                FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8 AND fee != 0 AND $12 < 0::NUMERIC;
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.locker,

        event.poolId,

        event.params.salt,
        event.params.bounds.lower,
        event.params.bounds.upper,

        event.params.liquidityDelta,
        event.delta0,
        event.delta1,
      ],
    });
  }

  public async insertPositionFeesCollectedEvent(
    event: PositionFeesCollectedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO position_fees_collected
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $7),
          $8,
          $9,
          $10,
          $11,
          -$12::numeric,
          -$13::numeric
        );
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.poolId,

        event.positionKey.owner,
        event.positionKey.salt,
        event.positionKey.bounds.lower,
        event.positionKey.bounds.upper,

        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertPoolInitializedEvent(
    newPool: PoolInitializedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        WITH inserted_pool_key AS (
        INSERT INTO pool_keys (chain_id, core_address, pool_id, token0, token1, fee, tick_spacing, pool_extension, fee_denominator)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING
              pool_key_id
        )
        INSERT INTO pool_initializations (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_key_id, tick, sqrt_ratio)
          SELECT $1, $10, $11, $12, $13, $14, inserted_pool_key.pool_key_id, $15, $16
          FROM inserted_pool_key;
      `,
      values: [
        this.chainId,
        key.emitter,
        newPool.poolId,
        newPool.poolKey.token0,
        newPool.poolKey.token1,
        newPool.poolKey.fee,
        newPool.poolKey.tickSpacing,
        newPool.poolKey.extension,
        newPool.feeDenominator,

        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        newPool.tick,
        newPool.sqrtRatio,
      ],
    });
  }

  public async insertMEVCapturePoolKey(
    coreAddress: `0x${string}`,
    poolId: `0x${string}`
  ) {
    await this.pg.query({
      text: `INSERT INTO mev_capture_pool_keys (pool_key_id) VALUES 
      (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $2 AND pool_id = $3) ON CONFLICT DO NOTHING;`,
      values: [this.chainId, coreAddress, poolId],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: ProtocolFeesWithdrawnInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                INSERT
                INTO protocol_fees_withdrawn
                (chain_id,
                 block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 emitter,
                 recipient,
                 token,
                 amount)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
            `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.recipient,
        event.token,
        event.amount,
      ],
    });
  }

  public async insertProtocolFeesPaid(
    event: ProtocolFeesPaidInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO protocol_fees_paid
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, locker, salt, lower_bound, upper_bound, delta0, delta1)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                $7, $9, $10, $11, $12, $13);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.locker,
        event.poolId,
        event.salt,
        event.bounds.lower,
        event.bounds.upper,
        event.delta0,
        event.delta1,
      ],
    });
  }

  public async insertExtensionRegistered(
    event: ExtensionRegisteredInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                INSERT
                INTO extension_registrations
                    (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_extension)
                VALUES ($1, $2, $3, $4, $5, $6, $7);
            `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.extension,
      ],
    });
  }

  public async insertRegistration(
    event: TokenRegistrationInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO token_registrations
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, address, name, symbol, decimals, total_supply)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.address,
        event.name,
        event.symbol,
        event.decimals,
        event.totalSupply,
      ],
    });
  }

  public async insertRegistrationV3(
    event: TokenRegistrationV3Insert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO token_registrations_v3
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, address, name, symbol, decimals, total_supply)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.address,
        event.name,
        event.symbol,
        event.decimals,
        event.totalSupply,
      ],
    });
  }

  public async insertStakerStakedEvent(
    event: StakerStakedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO staker_staked
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, from_address, amount, delegate)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.from,
        event.amount,
        event.delegate,
      ],
    });
  }

  public async insertStakerWithdrawnEvent(
    event: StakerWithdrawnInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO staker_withdrawn
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, from_address, amount, recipient, delegate)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.from,
        event.amount,
        event.recipient,
        event.delegate,
      ],
    });
  }

  public async insertGovernorReconfiguredEvent(
    event: GovernorReconfiguredInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO governor_reconfigured
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, version, voting_start_delay, voting_period, voting_weight_smoothing_duration,
             quorum, proposal_creation_threshold, execution_delay, execution_window)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.version,
        event.votingStartDelay,
        event.votingPeriod,
        event.votingWeightSmoothingDuration,
        event.quorum,
        event.proposalCreationThreshold,
        event.executionDelay,
        event.executionWindow,
      ],
    });
  }

  public async insertGovernorProposedEvent(
    event: GovernorProposedInsert,
    key: EventKey
  ) {
    const configVersion =
      event.configVersion === null ? 0n : BigInt(event.configVersion);

    await this.pg.query({
      text: `
        INSERT INTO governor_proposed
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, proposer, config_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.proposal_id,
        event.proposer,
        configVersion,
      ],
    });

    for (let i = 0; i < event.calls.length; i++) {
      const call = event.calls[i];
      await this.pg.query({
        text: `
          INSERT INTO governor_proposed_calls
              (chain_id, emitter, proposal_id, index, to_address, selector, calldata)
          VALUES ($1, $2, $3, $4, $5, $6, $7);
        `,
        values: [
          this.chainId,
          key.emitter,
          event.proposal_id,
          i,
          call.to,
          call.selector,
          call.calldata.map((value) => BigInt(value).toString()),
        ],
      });
    }
  }

  public async insertGovernorCanceledEvent(
    event: GovernorCanceledInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO governor_canceled
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (chain_id, proposal_id) DO NOTHING;
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.proposal_id,
      ],
    });
  }

  public async insertGovernorVotedEvent(
    event: GovernorVotedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO governor_voted
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, voter, weight, yea)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.proposal_id,
        event.voter,
        event.weight,
        event.yea,
      ],
    });
  }

  public async insertGovernorExecutedEvent(
    event: GovernorExecutedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO governor_executed
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.proposal_id,
      ],
    });

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      await this.pg.query({
        text: `
          INSERT INTO governor_executed_results
              (chain_id, emitter, proposal_id, index, results)
          VALUES ($1, $2, $3, $4, $5);
        `,
        values: [
          this.chainId,
          key.emitter,
          event.proposal_id,
          i,
          result.map((value) => BigInt(value).toString()),
        ],
      });
    }
  }

  public async insertGovernorProposalDescribedEvent(
    event: GovernorProposalDescribedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO governor_proposal_described
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, proposal_id, description)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.proposal_id,
        event.description,
      ],
    });
  }

  public async insertFeesAccumulatedEvent(
    event: FeesAccumulatedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO fees_accumulated
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, pool_key_id, delta0, delta1)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $7),
                $8, $9);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.poolId,

        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertSwappedEvent(event: SwapEventInsert, key: EventKey) {
    await this.pg.query({
      text: `
        INSERT INTO swaps
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, delta0, delta1, sqrt_ratio_after, tick_after, liquidity_after)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                $7, $9, $10, $11, $12, $13);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.locker,

        event.poolId,

        event.delta0,
        event.delta1,
        event.sqrtRatioAfter,
        event.tickAfter,
        event.liquidityAfter,
      ],
    });
  }

  /**
   * Deletes all the blocks equal to or greater than the given block number, cascades to all the other tables.
   * @param invalidatedBlockNumber the block number for which data in the database should be removed
   */
  public async deleteOldBlockNumbers(invalidatedBlockNumber: number) {
    const { rowCount } = await this.pg.query({
      text: `
                DELETE
                FROM blocks
                WHERE chain_id = $1 AND block_number >= $2;
            `,
      values: [this.chainId, invalidatedBlockNumber],
    });
    if (rowCount === null) throw new Error("Null row count after delete");
    return rowCount;
  }

  public async insertTWAMMOrderUpdatedEvent(
    event: TwammOrderUpdatedInsert,
    key: EventKey
  ) {
    const { orderKey, poolId } = event;

    const [sale_rate_delta0, sale_rate_delta1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.saleRateDelta]
        : [orderKey.sellToken, orderKey.buyToken, event.saleRateDelta, 0];

    await this.pg.query({
      text: `
        INSERT
        INTO twamm_order_updates
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, sale_rate_delta0, sale_rate_delta1, start_time, end_time)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pk.pool_key_id
                  FROM pool_keys pk
                    LEFT JOIN extension_registrations er 
                      ON er.chain_id = pk.chain_id AND er.pool_extension = pk.pool_extension
                  WHERE pk.chain_id = $1 
                    AND (er.emitter IS NULL OR pk.core_address = er.emitter)
                    AND pk.pool_id = $7),
                $8, $9, $10, $11, $12, $13);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolId,

        BigInt(event.owner),
        BigInt(event.salt),
        sale_rate_delta0,
        sale_rate_delta1,
        new Date(Number(orderKey.startTime * 1000n)),
        new Date(Number(orderKey.endTime * 1000n)),
      ],
    });
  }

  public async insertTWAMMOrderProceedsWithdrawnEvent(
    event: TwammOrderProceedsWithdrawnInsert,
    key: EventKey
  ) {
    const { orderKey, poolId } = event;

    const [amount0, amount1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.amount]
        : [orderKey.sellToken, orderKey.buyToken, event.amount, 0];

    await this.pg.query({
      text: `
        INSERT
        INTO twamm_proceeds_withdrawals
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
         pool_key_id, locker, salt, amount0, amount1, start_time, end_time)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pk.pool_key_id
                  FROM pool_keys pk
                    LEFT JOIN extension_registrations er 
                      ON er.chain_id = pk.chain_id AND er.pool_extension = pk.pool_extension
                  WHERE pk.chain_id = $1 
                    AND (er.emitter IS NULL OR pk.core_address = er.emitter)
                    AND pk.pool_id = $7), 
                $8, $9, $10, $11, $12, $13);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolId,

        BigInt(event.owner),
        BigInt(event.salt),
        amount0,
        amount1,
        new Date(Number(orderKey.startTime * 1000n)),
        new Date(Number(orderKey.endTime * 1000n)),
      ],
    });
  }

  public async insertTWAMMVirtualOrdersExecutedEvent(
    event: TwammVirtualOrdersExecutedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT
        INTO twamm_virtual_order_executions
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, token0_sale_rate, token1_sale_rate)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pk.pool_key_id
                  FROM pool_keys pk
                    LEFT JOIN extension_registrations er 
                      ON er.chain_id = pk.chain_id AND er.pool_extension = pk.pool_extension
                  WHERE pk.chain_id = $1 
                    AND (er.emitter IS NULL OR pk.core_address = er.emitter)
                    AND pk.pool_id = $7),
                $8, $9);
      `,
      // note on starknet we do not have an extension registration event
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        event.poolId,
        event.saleRateToken0,
        event.saleRateToken1,
      ],
    });
  }

  public async insertOrderPlacedEvent(
    event: LimitOrderPlacedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO limit_order_placed
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, locker, salt, token0, token1, tick, liquidity, amount)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id
                  FROM pool_keys
                  WHERE chain_id = $1 AND pool_id = $7),
                $8, $9, $10, $11, $12, $13, $14);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.poolId,
        event.locker,
        event.salt,
        event.token0,
        event.token1,
        event.tick,
        event.liquidity,
        event.amount,
      ],
    });
  }

  public async insertOrderClosedEvent(
    event: LimitOrderClosedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO limit_order_closed
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, locker, salt, token0, token1, tick, amount0, amount1)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id
                  FROM pool_keys
                  WHERE chain_id = $1 AND pool_id = $7),
                $8, $9, $10, $11, $12, $13, $14);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.poolId,
        event.locker,
        event.salt,
        event.token0,
        event.token1,
        event.tick,
        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertLiquidityUpdatedEvent(
    event: LiquidityUpdatedInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT INTO spline_liquidity_updated
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
             pool_key_id, sender, liquidity_factor, shares, amount0, amount1, protocol_fees0, protocol_fees1)
        VALUES ($1, $2, $3, $4, $5, $6,
                (SELECT pool_key_id
                  FROM pool_keys
                  WHERE chain_id = $1 AND core_address = (
                        SELECT emitter
                        FROM extension_registrations
                        WHERE chain_id = $1 AND pool_extension = $6
                        ORDER BY block_number DESC, transaction_index DESC, event_index DESC
                        LIMIT 1)
                    AND pool_id = $7),
                $8, $9, $10, $11, $12, $13, $14);
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        event.poolId,
        event.sender,
        event.liquidityFactor,
        event.shares,
        event.amount0,
        event.amount1,
        event.protocolFees0,
        event.protocolFees1,
      ],
    });
  }

  async insertOracleSnapshotEvent(
    snapshot: OracleSnapshotInsert,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        INSERT
        INTO oracle_snapshots
        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter,
          token0, token1, snapshot_block_timestamp, snapshot_tick_cumulative, snapshot_seconds_per_liquidity_cumulative)
        VALUES ($1, $2, $3, $4, $5, $6, 
                $7, $8, $9, $10, $11)
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        snapshot.token0,
        snapshot.token1,

        snapshot.timestamp,
        snapshot.tickCumulative,
        snapshot.secondsPerLiquidityCumulative,
      ],
    });
  }

  async insertIncentivesRefundedEvent(
    key: EventKey,
    parsed: IncentivesRefundedInsert
  ) {
    await this.pg.query({
      text: `
                INSERT
                INTO incentives_refunded
                    (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, owner, token, root, refund_amount)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.key.owner,
        parsed.key.token,
        parsed.key.root,
        parsed.refundAmount,
      ],
    });
  }

  async insertIncentivesFundedEvent(
    key: EventKey,
    parsed: IncentivesFundedInsert
  ) {
    await this.pg.query({
      text: `
        INSERT
        INTO incentives_funded
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, owner, token, root, amount_next)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.key.owner,
        parsed.key.token,
        parsed.key.root,
        parsed.amountNext,
      ],
    });
  }

  async insertTokenWrapperDeployed(
    key: EventKey,
    parsed: TokenWrapperDeployedInsert
  ) {
    await this.pg.query({
      text: `
        INSERT
        INTO token_wrapper_deployed
            (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter, token_wrapper, underlying_token, unlock_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.tokenWrapper,
        parsed.underlyingToken,
        parsed.unlockTime,
      ],
    });
  }
}
