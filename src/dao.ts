import type { PoolClient } from "pg";
import { Client } from "pg";
import type { EventKey } from "./processor";
import { parsePoolKeyConfig, toPoolConfig, toPoolId } from "./poolKey.ts";
import type {
  CoreExtensionRegistered,
  CoreFeesAccumulated,
  CorePoolInitialized,
  CorePositionFeesCollected,
  CorePositionUpdated,
  CoreProtocolFeesWithdrawn,
  IncentivesFunded,
  IncentivesRefunded,
  OrderTransfer,
  PoolKey,
  PositionTransfer,
  TokenWrapperDeployed,
  TwammOrderProceedsWithdrawn,
  TwammOrderUpdated,
} from "./eventTypes.ts";
import type { CoreSwapped } from "./swapEvent.ts";
import type { OracleEvent } from "./oracleEvent.ts";
import type { TwammVirtualOrdersExecutedEvent } from "./twammEvent.ts";

// Data access object that manages inserts/deletes
export class DAO {
  private pg: Client | PoolClient;
  private chainId: bigint;
  private indexerName: string;

  constructor(pg: Client | PoolClient, chainId: bigint, indexerName: string) {
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

  public async refreshAnalyticalTables({ since }: { since: Date }) {
    await this.pg.query({
      text: `
                WITH swap_data AS (
                    SELECT swaps.pool_key_id                                                      AS   pool_key_id,
                           DATE_TRUNC('hour', blocks.time)                                          AS   hour,
                           (CASE WHEN pbc.delta0 >= 0 THEN pool_keys.token0 ELSE pool_keys.token1 END) token,
                           SUM(CASE WHEN pbc.delta0 >= 0 THEN pbc.delta0 ELSE pbc.delta1 END) AS   volume,
                           SUM(FLOOR(((CASE WHEN pbc.delta0 >= 0 THEN pbc.delta0 ELSE pbc.delta1 END) *
                                      pool_keys.fee) /
                                     0x10000000000000000))                                          AS   fees,
                           COUNT(1)                                                                 AS   swap_count
                    FROM swaps
                             JOIN pool_balance_change pbc ON swaps.pool_balance_change_id = pbc.event_id
                             JOIN pool_keys ON swaps.chain_id = pool_keys.chain_id AND swaps.pool_key_id = pool_keys.id
                             JOIN event_keys ON swaps.chain_id = event_keys.chain_id AND swaps.event_id = event_keys.sort_id
                             JOIN blocks ON event_keys.chain_id = blocks.chain_id AND event_keys.block_number = blocks.number
                    WHERE swaps.chain_id = $2 AND DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                    GROUP BY hour, swaps.pool_key_id, token
                ),
                fees_token0 AS (
                    SELECT fa.pool_key_id                AS pool_key_id,
                           DATE_TRUNC('hour', blocks.time) AS hour,
                           pool_keys.token0                AS token,
                           0                               AS volume,
                           SUM(pbc.delta0)                 AS fees,
                           0                               AS swap_count
                    FROM fees_accumulated fa
                             JOIN pool_balance_change pbc ON fa.pool_balance_change_id = pbc.event_id
                             JOIN pool_keys ON fa.chain_id = pool_keys.chain_id AND fa.pool_key_id = pool_keys.id
                             JOIN event_keys ON fa.chain_id = event_keys.chain_id AND fa.event_id = event_keys.sort_id
                             JOIN blocks ON event_keys.chain_id = blocks.chain_id AND event_keys.block_number = blocks.number
                    WHERE fa.chain_id = $2 AND DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                      AND pbc.delta0 > 0
                    GROUP BY hour, fa.pool_key_id, token
                ),
                fees_token1 AS (
                    SELECT fa.pool_key_id                AS pool_key_id,
                           DATE_TRUNC('hour', blocks.time) AS hour,
                           pool_keys.token1                AS token,
                           0                               AS volume,
                           SUM(pbc.delta1)                 AS fees,
                           0                               AS swap_count
                    FROM fees_accumulated fa
                             JOIN pool_balance_change pbc ON fa.pool_balance_change_id = pbc.event_id
                             JOIN pool_keys ON fa.chain_id = pool_keys.chain_id AND fa.pool_key_id = pool_keys.id
                             JOIN event_keys ON fa.chain_id = event_keys.chain_id AND fa.event_id = event_keys.sort_id
                             JOIN blocks ON event_keys.chain_id = blocks.chain_id AND event_keys.block_number = blocks.number
                    WHERE fa.chain_id = $2 AND DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                      AND pbc.delta1 > 0
                    GROUP BY hour, fa.pool_key_id, token
                ),
                combined_data AS (
                    SELECT pool_key_id, hour, token, volume, fees, swap_count FROM swap_data
                    UNION ALL
                    SELECT pool_key_id, hour, token, volume, fees, swap_count FROM fees_token0
                    UNION ALL
                    SELECT pool_key_id, hour, token, volume, fees, swap_count FROM fees_token1
                )
                INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, swap_count)
                SELECT pool_key_id,
                       hour,
                       token,
                       SUM(volume)     AS volume,
                       SUM(fees)       AS fees,
                       SUM(swap_count) AS swap_count
                FROM combined_data
                GROUP BY pool_key_id, hour, token
                ON CONFLICT (pool_key_id, hour, token)
                    DO UPDATE SET volume     = excluded.volume,
                                  fees       = excluded.fees,
                                  swap_count = excluded.swap_count;
            `,
      values: [since, this.chainId],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_revenue_by_token
                    (WITH rev0 AS (SELECT pu.pool_key_id                AS pool_key_id,
                                          DATE_TRUNC('hour', blocks.time) AS hour,
                                          pk.token0                          token,
                                          SUM(CEIL((-pbc.delta0 * 0x10000000000000000::NUMERIC) /
                                                   (0x10000000000000000::NUMERIC - pk.fee)) +
                                              pbc.delta0)                     AS revenue
                                   FROM position_updates pu
                                            JOIN pool_balance_change pbc ON pu.pool_balance_change_id = pbc.event_id
                                            JOIN pool_keys pk ON pu.chain_id = pk.chain_id AND pu.pool_key_id = pk.id
                                            JOIN event_keys ek ON pu.chain_id = ek.chain_id AND pu.event_id = ek.sort_id
                                            JOIN blocks ON ek.chain_id = blocks.chain_id AND ek.block_number = blocks.number
                                   WHERE pu.chain_id = $2 AND DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                                     AND pbc.delta0 < 0
                                     AND pk.fee != 0
                                   GROUP BY hour, pu.pool_key_id, token),
                          rev1 AS (SELECT pu.pool_key_id                AS pool_key_id,
                                          DATE_TRUNC('hour', blocks.time) AS hour,
                                          pk.token1                          token,
                                          SUM(CEIL((-pbc.delta1 * 0x10000000000000000::NUMERIC) /
                                                   (0x10000000000000000::NUMERIC - pk.fee)) +
                                              pbc.delta1)                     AS revenue
                                   FROM position_updates pu
                                            JOIN pool_balance_change pbc ON pu.pool_balance_change_id = pbc.event_id
                                            JOIN pool_keys pk ON pu.chain_id = pk.chain_id AND pu.pool_key_id = pk.id
                                            JOIN event_keys ek ON pu.chain_id = ek.chain_id AND pu.event_id = ek.sort_id
                                            JOIN blocks ON ek.chain_id = blocks.chain_id AND ek.block_number = blocks.number
                                   WHERE pu.chain_id = $2 AND DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                                     AND pbc.delta1 < 0
                                     AND pk.fee != 0
                                   GROUP BY hour, pu.pool_key_id, token),
                          total AS (SELECT pool_key_id, hour, token, revenue
                                    FROM rev0
                                    UNION ALL
                                    SELECT pool_key_id, hour, token, revenue
                                    FROM rev1)
                     SELECT pool_key_id, hour, token, SUM(revenue) AS revenue
                     FROM total
                     GROUP BY pool_key_id, hour, token)
                ON CONFLICT (pool_key_id, hour, token)
                    DO UPDATE SET revenue = excluded.revenue;
            `,
      values: [since, this.chainId],
    });

    await this.pg.query({
      text: `
                WITH total_swaps_per_block_pair AS (SELECT ek.block_number,
                                                           pk.token0        AS token0,
                                                           pk.token1        AS token1,
                                                           SUM(pbc.delta0) AS total_delta0,
                                                           SUM(pbc.delta1) AS total_delta1,
                                                           COUNT(1)         AS swap_count
                                                    FROM swaps s
                                                             JOIN pool_balance_change pbc ON s.pool_balance_change_id = pbc.event_id
                                                             JOIN event_keys ek ON s.event_id = ek.sort_id
                                                             JOIN pool_keys pk ON s.pool_key_id = pk.id
                                                    GROUP BY block_number, pk.token0, pk.token1)
                INSERT
                INTO hourly_price_data
                    (SELECT token0,
                            token1,
                            DATE_TRUNC('hour', b.time)            AS hour,
                            SUM(ABS(total_delta0 * total_delta1)) AS k_volume,
                            SUM(total_delta1 * total_delta1)      AS total,
                            SUM(swap_count)                       AS swap_count
                     FROM total_swaps_per_block_pair tspt
                              JOIN blocks b ON tspt.block_number = b.number
                     WHERE total_delta0 != 0
                       AND total_delta1 != 0
                       AND DATE_TRUNC('hour', b.time) >= DATE_TRUNC('hour', $1::timestamptz)
                     GROUP BY token0, token1, hour)
                ON CONFLICT (token0, token1, hour)
                    DO UPDATE SET k_volume   = excluded.k_volume,
                                  total      = excluded.total,
                                  swap_count = excluded.swap_count;
            `,
      values: [since],
    });

    await this.pg.query({
      text: `
                INSERT INTO hourly_tvl_delta_by_token
                    (WITH first_event_id AS (SELECT id
                                             FROM event_keys AS ek
                                                      JOIN blocks AS b ON ek.block_number = b.number
                                             WHERE b.time >= DATE_TRUNC('hour', $1::timestamptz)
                                             ORDER BY id
                                             LIMIT 1),
                          -- Use the unified pool_balance_change table with fee adjustments for position updates
                          adjusted_pool_balance_changes AS (
                              SELECT 
                                  pbc.pool_key_id,
                                  DATE_TRUNC('hour', blocks.time) AS hour,
                                  CASE 
                                      WHEN pu.event_id IS NOT NULL AND pu.liquidity_delta < 0 THEN 
                                          CEIL((pbc.delta0 * 0x10000000000000000::NUMERIC) / (0x10000000000000000::NUMERIC - pk.fee))
                                      ELSE pbc.delta0 
                                  END AS delta0,
                                  CASE 
                                      WHEN pu.event_id IS NOT NULL AND pu.liquidity_delta < 0 THEN 
                                          CEIL((pbc.delta1 * 0x10000000000000000::NUMERIC) / (0x10000000000000000::NUMERIC - pk.fee))
                                      ELSE pbc.delta1 
                                  END AS delta1
                              FROM pool_balance_change pbc
                              JOIN event_keys ek ON pbc.event_id = ek.id
                              JOIN blocks ON ek.block_number = blocks.number
                              JOIN pool_keys pk ON pbc.pool_key_id = pk.key_hash
                              LEFT JOIN position_updates pu ON pbc.event_id = pu.event_id
                              WHERE pbc.event_id >= (SELECT id FROM first_event_id)
                          ),
                          grouped_pool_key_hash_deltas AS (
                              SELECT pool_key_hash,
                                     hour,
                                     SUM(delta0) AS delta0,
                                     SUM(delta1) AS delta1
                              FROM adjusted_pool_balance_changes
                              GROUP BY pool_key_id, hour
                          ),
                          token_deltas AS (SELECT pool_key_id,
                                                  grouped_pool_key_hash_deltas.hour,
                                                  pool_keys.token0 AS token,
                                                  SUM(delta0)      AS delta
                                           FROM grouped_pool_key_id_deltas
                                                    JOIN pool_keys
                                                         ON pool_keys.id = grouped_pool_key_id_deltas.pool_key_id
                                           GROUP BY pool_key_id, grouped_pool_key_id_deltas.hour,
                                                    pool_keys.token0

                                           UNION ALL

                                           SELECT pool_key_id,
                                                  grouped_pool_key_id_deltas.hour,
                                                  pool_keys.token1 AS token,
                                                  SUM(delta1)      AS delta
                                           FROM grouped_pool_key_id_deltas
                                                    JOIN pool_keys
                                                         ON pool_keys.id = grouped_pool_key_id_deltas.pool_key_id
                                           GROUP BY pool_key_id, grouped_pool_key_id_deltas.hour,
                                                    pool_keys.token1)
                     SELECT pool_key_id AS pool_key_id,
                            token_deltas.hour,
                            token_deltas.token,
                            SUM(delta)    AS delta
                     FROM token_deltas
                     GROUP BY token_deltas.pool_key_id, token_deltas.hour, token_deltas.token)
                ON CONFLICT (pool_key_id, hour, token)
                    DO UPDATE SET delta = excluded.delta;
            `,
      values: [since],
    });

    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY last_24h_pool_stats_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY token_pair_realized_volatility;
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth;
    `);
  }

  public async refreshOperationalMaterializedView() {
    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_sale_rate_deltas_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY oracle_pool_states_materialized;
    `);
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
      text: `SELECT order_key, unique_key
                   FROM cursor
                   WHERE indexer_name = $1;`,
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
                INSERT INTO cursor (indexer_name, order_key, unique_key, last_updated)
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
      text: `INSERT INTO blocks (chain_id, number, hash, time)
                   VALUES ($1, $2, $3, $4);`,
      values: [this.chainId, number, hash, time],
    });
  }

  private async insertPoolKey(
    coreAddress: `0x${string}`,
    poolKey: PoolKey,
    poolId: `0x${string}`
  ): Promise<bigint> {
    const { fee, tickSpacing, extension } = parsePoolKeyConfig(poolKey.config);

    const { rows } = await this.pg.query({
      text: `
        INSERT INTO pool_keys (chain_id, pool_id, core_address, token0, token1, fee, tick_spacing, extension)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (chain_id, core_address, pool_id) DO UPDATE SET id = pool_keys.id
        RETURNING id;
      `,
      values: [
        this.chainId,
        poolId,
        coreAddress,
        BigInt(poolKey.token0),
        BigInt(poolKey.token1),
        fee,
        tickSpacing,
        BigInt(extension),
      ],
    });
    return BigInt(rows[0].id);
  }

  public async insertPositionTransferEvent(
    transfer: PositionTransfer,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO position_transfers
                (chain_id,
                 event_id,
                 token_id,
                 from_address,
                 to_address)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9)
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

  public async insertOrdersTransferEvent(
    transfer: OrderTransfer,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO order_transfers
                (chain_id,
                 event_id,
                 token_id,
                 from_address,
                 to_address)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9)
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

  public async insertPositionUpdatedEvent(
    event: CorePositionUpdated,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        WITH inserted_event AS (
            INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING chain_id, sort_id),
        balance_change_insert AS (
            INSERT INTO pool_balance_change (chain_id, event_id, pool_key_id, delta0, delta1)
            VALUES ($1, (SELECT sort_id FROM inserted_event),
                    (SELECT id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                    $13, $14)
            RETURNING event_id, pool_key_id
        )
        INSERT INTO position_updates
        (chain_id, pool_balance_change_id, locker, salt, lower_bound, upper_bound, liquidity_delta)
        VALUES ($1, (SELECT event_id FROM balance_change_insert),
                $7, $9, $10, $11, $12);
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
    event: CorePositionFeesCollected,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
        WITH inserted_event AS (
            INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING sort_id),
        balance_change_insert AS (
            INSERT INTO pool_balance_change (chain_id, event_id, pool_key_id, delta0, delta1)
            VALUES ($1, (SELECT sort_id FROM inserted_event),
                    (SELECT id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $7),
                    -$12::numeric, -$13::numeric)
            RETURNING event_id
        )
        INSERT INTO position_fees_collected
        (chain_id, pool_balance_change_id, locker, salt, lower_bound, upper_bound)
        VALUES ($1, (SELECT event_id FROM balance_change_insert),
                $8, $9, $10, $11);
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
    event: CorePoolInitialized,
    key: EventKey
  ): Promise<bigint> {
    const poolKeyId = await this.insertPoolKey(
      key.emitter,
      event.poolKey,
      event.poolId
    );

    await this.pg.query({
      text: `
        WITH inserted_event AS (
            INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING chain_id, sort_id)
        INSERT INTO pool_initializations (chain_id, event_id, pool_key_id, tick, sqrt_ratio)
        VALUES ($1, (SELECT sort_id FROM inserted_event), $7, $8, $9)
      `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,

        poolKeyId,

        event.tick,
        event.sqrtRatio,
      ],
    });

    return poolKeyId;
  }

  public async insertMEVResistPoolKey(poolKeyId: bigint) {
    await this.pg.query({
      text: `
          INSERT
          INTO mev_resist_pool_keys (chain_id, pool_key_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING;
      `,
      values: [this.chainId, poolKeyId],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: CoreProtocolFeesWithdrawn,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO protocol_fees_withdrawn
                (chain_id,
                 event_id,
                 recipient,
                 token,
                 amount)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9);
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

  public async insertExtensionRegistered(
    event: CoreExtensionRegistered,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO extension_registrations
                    (chain_id, event_id, extension)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7);
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

  public async insertFeesAccumulatedEvent(
    event: CoreFeesAccumulated,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5)
                        RETURNING chain_id, sort_id),
                balance_change_insert AS (
                    INSERT INTO pool_balance_change (event_id, pool_key_id, delta0, delta1)
                    VALUES ((SELECT id FROM inserted_event),
                            (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $6),
                            $7, $8)
                    RETURNING event_id
                )
                INSERT INTO fees_accumulated
                (chain_id, 
                 pool_balance_change_id,
                 pool_key_id)
                VALUES ((SELECT event_id FROM balance_change_insert),
                        (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $6));
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

  public async insertSwappedEvent(event: CoreSwapped, key: EventKey) {
    await this.pg.query({
      text: `
        WITH inserted_event AS (
            INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING sort_id),
        balance_change_insert AS (
            INSERT INTO pool_balance_change (chain_id, event_id, pool_key_id, delta0, delta1)
            VALUES ($1, (SELECT sort_id FROM inserted_event),
                    (SELECT id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                    $9, $10)
            RETURNING event_id
        )
        INSERT INTO swaps
        (chain_id, pool_balance_change_id, locker, sqrt_ratio_after, tick_after, liquidity_after)
        VALUES ($1, (SELECT sort_id FROM inserted_event), $7,
                $11, $12, $13);
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
                WHERE chain_id = $1 AND number >= $2;
            `,
      values: [this.chainId, invalidatedBlockNumber],
    });
    if (rowCount === null) throw new Error("Null row count after delete");
    return rowCount;
  }

  public async insertTWAMMOrderUpdatedEvent(
    event: TwammOrderUpdated,
    key: EventKey
  ) {
    const { orderKey } = event;

    const [token0, token1, sale_rate_delta0, sale_rate_delta1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.saleRateDelta]
        : [orderKey.sellToken, orderKey.buyToken, event.saleRateDelta, 0];

    const poolId = toPoolId({
      token0,
      token1,
      config: toPoolConfig({
        fee: orderKey.fee,
        tickSpacing: 0,
        extension: key.emitter,
      }),
    });

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO twamm_order_updates
                (chain_id,
                 event_id,
                 pool_key_id,
                 owner,
                 salt,
                 sale_rate_delta0,
                 sale_rate_delta1,
                 start_time,
                 end_time)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event),
                        (SELECT id
                         FROM pool_keys
                         WHERE chain_id = $1 AND core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.chain_id = $1 AND er.event_id = ek.sort_id
                                               WHERE er.extension = $6)
                           AND pool_id = $7), $8, $9, $10, $11, $12, $13);
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
    event: TwammOrderProceedsWithdrawn,
    key: EventKey
  ) {
    const { orderKey } = event;

    const [token0, token1, amount0, amount1] =
      BigInt(orderKey.sellToken) > BigInt(orderKey.buyToken)
        ? [orderKey.buyToken, orderKey.sellToken, 0, event.amount]
        : [orderKey.sellToken, orderKey.buyToken, event.amount, 0];

    const poolId = toPoolId({
      token0,
      token1,
      config: toPoolConfig({
        fee: orderKey.fee,
        tickSpacing: 0,
        extension: key.emitter,
      }),
    });

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO twamm_proceeds_withdrawals
                (chain_id, event_id, pool_key_id, owner, salt, amount0, amount1, start_time, end_time)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event),
                        (SELECT id
                         FROM pool_keys
                         WHERE chain_id = $1 AND core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.chain_id = $1 AND er.event_id = ek.sort_id
                                               WHERE er.extension = $6)
                           AND pool_id = $7), $8, $9, $10, $11, $12, $13);
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
    event: TwammVirtualOrdersExecutedEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO twamm_virtual_order_executions
                    (chain_id, event_id, pool_key_id, token0_sale_rate, token1_sale_rate)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event),
                        (SELECT id
                         FROM pool_keys
                         WHERE chain_id = $1 AND core_address = (SELECT ek.emitter
                                               FROM extension_registrations er
                                                        JOIN event_keys ek ON er.chain_id = $1 AND er.event_id = ek.sort_id
                                               WHERE er.extension = $6)
                           AND pool_id = $7), $8, $9);
            `,
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

  async insertOracleSnapshotEvent(parsed: OracleEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO oracle_snapshots
                (chain_id, event_id, token, snapshot_block_timestamp, snapshot_tick_cumulative,
                 snapshot_seconds_per_liquidity_cumulative)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9, $10)
            `,
      values: [
        this.chainId,
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        key.emitter,
        parsed.token,
        parsed.timestamp,
        parsed.tickCumulative,
        parsed.secondsPerLiquidityCumulative,
      ],
    });
  }

  async insertIncentivesRefundedEvent(
    key: EventKey,
    parsed: IncentivesRefunded
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO incentives_refunded
                    (chain_id, event_id, owner, token, root, refund_amount)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9, $10)
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

  async insertIncentivesFundedEvent(key: EventKey, parsed: IncentivesFunded) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO incentives_funded
                    (chain_id, event_id, owner, token, root, amount_next)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9, $10)
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
    parsed: TokenWrapperDeployed
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (chain_id, block_number, transaction_index, event_index, transaction_hash, emitter)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING chain_id, sort_id)
                INSERT
                INTO token_wrapper_deployed
                    (chain_id, event_id, token_wrapper, underlying_token, unlock_time)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9)
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
