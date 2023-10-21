import { Client, PoolClient } from "pg";
import { pedersen_from_hex } from "pedersen-fast";
import { EventKey } from "./processor";
import {
  FeesAccumulatedEvent,
  FeesPaidEvent,
  FeesWithdrawnEvent,
  PoolInitializationEvent,
  PoolKey,
  PositionFeesCollectedEvent,
  PositionUpdatedEvent,
  SwappedEvent,
} from "./events/core";
import {
  DepositEvent,
  PositionMintedEvent,
  WithdrawEvent,
} from "./events/positions";
import { TransferEvent } from "./events/nft";

function toHex(x: bigint): string {
  return `0x${x.toString(16)}`;
}

const KEY_HASH_CACHE: { [key: string]: bigint } = {};

function computeKeyHash(pool_key: PoolKey): bigint {
  const cacheKey = `${pool_key.token0}-${pool_key.token1}-${pool_key.fee}-${pool_key.tick_spacing}-${pool_key.extension}`;
  return (
    KEY_HASH_CACHE[cacheKey] ??
    (KEY_HASH_CACHE[cacheKey] = BigInt(
      pedersen_from_hex(
        pedersen_from_hex(
          pedersen_from_hex(toHex(pool_key.token0), toHex(pool_key.token1)),
          pedersen_from_hex(toHex(pool_key.fee), toHex(pool_key.tick_spacing))
        ),
        toHex(pool_key.extension)
      )
    ))
  );
}

// Data access object that manages inserts/deletes
export class DAO {
  private pg: Client | PoolClient;

  constructor(pg: Client | PoolClient) {
    this.pg = pg;
  }

  public async beginTransaction(): Promise<void> {
    await this.pg.query("BEGIN");
  }

  public async commitTransaction(): Promise<void> {
    await this.pg.query("COMMIT");
  }

  public async initializeSchema() {
    await this.beginTransaction();
    await this.initSchema();
    const cursor = await this.loadCursor();
    // we need to clear anything that was potentially inserted as pending before starting
    if (cursor) {
      await this.invalidateBlockNumber(BigInt(cursor.orderKey) + 1n);
    }
    await this.commitTransaction();
    return cursor;
  }

  private async initSchema(): Promise<void> {
    await this.pg.query(`
        CREATE TABLE IF NOT EXISTS cursor
        (
            id         INT     NOT NULL UNIQUE CHECK (id = 1), -- only one row.
            order_key  NUMERIC NOT NULL,
            unique_key TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks
        (
            number    INT8      NOT NULL PRIMARY KEY,
            hash      NUMERIC   NOT NULL,
            timestamp TIMESTAMP NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks USING btree (timestamp);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks USING btree (hash);

        CREATE TABLE IF NOT EXISTS pool_keys
        (
            key_hash     NUMERIC NOT NULL PRIMARY KEY,
            token0       NUMERIC NOT NULL,
            token1       NUMERIC NOT NULL,
            fee          NUMERIC NOT NULL,
            tick_spacing NUMERIC NOT NULL,
            extension    NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token0 ON pool_keys USING btree (token0);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token1 ON pool_keys USING btree (token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token0_token1 ON pool_keys USING btree (token0, token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_extension ON pool_keys USING btree (extension);

        CREATE TABLE IF NOT EXISTS position_minted
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            token_id          INT8    NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_minted_pool_key_hash ON position_minted (pool_key_hash);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_position_minted_token_id ON position_minted (token_id);

        CREATE TABLE IF NOT EXISTS position_deposit
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            token_id          INT8    NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            liquidity         NUMERIC NOT NULL,
            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_deposit_pool_key_hash ON position_deposit (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_position_deposit_token_id ON position_deposit (token_id);

        CREATE TABLE IF NOT EXISTS position_withdraw
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            token_id          INT8    NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            collect_fees      BOOL    NOT NULL,

            liquidity         NUMERIC NOT NULL,
            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            recipient         NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_withdraw_pool_key_hash ON position_withdraw (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_position_withdraw_token_id ON position_withdraw (token_id);

        CREATE TABLE IF NOT EXISTS position_transfers
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            token_id          INT8    NOT NULL,
            from_address      NUMERIC NOT NULL,
            to_address        NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id ON position_transfers (token_id);
        CREATE INDEX IF NOT EXISTS idx_position_transfers_from_address ON position_transfers (from_address);
        CREATE INDEX IF NOT EXISTS idx_position_transfers_to_address ON position_transfers (to_address);

        CREATE TABLE IF NOT EXISTS position_updates
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            locker            NUMERIC NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            salt              NUMERIC NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            liquidity_delta   NUMERIC NOT NULL,
            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_updates_pool_key_hash ON position_updates (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_position_updates_pool_key_hash_sorted_events ON position_updates USING btree (pool_key_hash, block_number, transaction_index, event_index);

        CREATE TABLE IF NOT EXISTS position_fees_collected
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            owner             NUMERIC NOT NULL,
            salt              NUMERIC NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_pool_key_hash ON position_fees_collected (pool_key_hash);

        CREATE TABLE IF NOT EXISTS protocol_fees_withdrawn
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            recipient         NUMERIC NOT NULL,
            token             NUMERIC NOT NULL,
            amount            NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );


        CREATE TABLE IF NOT EXISTS protocol_fees_paid
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            owner             NUMERIC NOT NULL,
            salt              NUMERIC NOT NULL,
            lower_bound       INT4    NOT NULL,
            upper_bound       INT4    NOT NULL,

            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_fees_paid_pool_key_hash ON protocol_fees_paid (pool_key_hash);

        CREATE TABLE IF NOT EXISTS fees_accumulated
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            amount0           NUMERIC NOT NULL,
            amount1           NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_fees_accumulated_pool_key_hash ON fees_accumulated (pool_key_hash);

        CREATE TABLE IF NOT EXISTS pool_initializations
        (
            block_number      INT8     NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4     NOT NULL,
            event_index       INT4     NOT NULL,

            transaction_hash  NUMERIC  NOT NULL,

            pool_key_hash     NUMERIC  NOT NULL REFERENCES pool_keys (key_hash),

            tick              INT4     NOT NULL,
            sqrt_ratio        NUMERIC  NOT NULL,
            call_points       SMALLINT NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_pool_initializations_pool_key_hash ON pool_initializations (pool_key_hash);


        CREATE TABLE IF NOT EXISTS swaps
        (
            block_number      INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index INT4    NOT NULL,
            event_index       INT4    NOT NULL,

            transaction_hash  NUMERIC NOT NULL,

            locker            NUMERIC NOT NULL,
            pool_key_hash     NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            delta0            NUMERIC NOT NULL,
            delta1            NUMERIC NOT NULL,

            sqrt_ratio_after  NUMERIC NOT NULL,
            tick_after        INT4    NOT NULL,
            liquidity_after   NUMERIC NOT NULL,

            PRIMARY KEY (block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_hash ON swaps (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_hash_sorted_events ON swaps USING btree (pool_key_hash, block_number, transaction_index, event_index);

        CREATE MATERIALIZED VIEW IF NOT EXISTS volume_by_token_by_hour_by_key_hash AS
        (
        SELECT date_trunc('hour', blocks.timestamp)                   AS hour,
               key_hash,
               (CASE WHEN delta0 >= 0 THEN token0 ELSE token1 END)       token,
               SUM(CASE WHEN delta0 >= 0 THEN delta0 ELSE delta1 END) AS volume,
               SUM(FLOOR(((CASE WHEN delta0 >= 0 THEN delta0 ELSE delta1 END) * fee) /
                         340282366920938463463374607431768211456))    as fees
        FROM swaps
                 JOIN pool_keys ON swaps.pool_key_hash = pool_keys.key_hash
                 JOIN blocks ON swaps.block_number = blocks.number
        GROUP BY hour, key_hash, token
            );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_volume_by_token_by_hour_by_hour_key_hash_token ON volume_by_token_by_hour_by_key_hash USING btree (key_hash, hour, token);

        CREATE MATERIALIZED VIEW IF NOT EXISTS tvl_delta_by_token_by_hour_by_key_hash AS
        (
        WITH token_deltas AS (SELECT token0                               as token,
                                     key_hash,
                                     position_updates.delta0              as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM position_updates
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = position_updates.pool_key_hash
                                       INNER JOIN blocks
                                                  ON position_updates.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token1                     as token,
                                     key_hash,
                                     position_updates.delta1              as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM position_updates
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = position_updates.pool_key_hash
                                       INNER JOIN blocks
                                                  ON position_updates.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token0                     as token,
                                     key_hash,
                                     swaps.delta0                         as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM swaps
                                       INNER JOIN
                                   pool_keys ON pool_keys.key_hash = swaps.pool_key_hash
                                       INNER JOIN blocks
                                                  ON swaps.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token1                     as token,
                                     key_hash,
                                     swaps.delta1                         as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM swaps
                                       INNER JOIN
                                   pool_keys ON pool_keys.key_hash = swaps.pool_key_hash
                                       INNER JOIN blocks
                                                  ON swaps.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token0                     as token,
                                     key_hash,
                                     position_fees_collected.delta0       as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM position_fees_collected
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = position_fees_collected.pool_key_hash
                                       INNER JOIN blocks
                                                  ON position_fees_collected.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token1                     as token,
                                     key_hash,
                                     position_fees_collected.delta1       as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM position_fees_collected
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = position_fees_collected.pool_key_hash
                                       INNER JOIN blocks
                                                  ON position_fees_collected.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token0                     as token,
                                     key_hash,
                                     protocol_fees_paid.delta0            as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM protocol_fees_paid
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = protocol_fees_paid.pool_key_hash
                                       INNER JOIN blocks
                                                  ON protocol_fees_paid.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token1                     as token,
                                     key_hash,
                                     protocol_fees_paid.delta1            as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM protocol_fees_paid
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = protocol_fees_paid.pool_key_hash
                                       INNER JOIN blocks
                                                  ON protocol_fees_paid.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token0                     as token,
                                     key_hash,
                                     amount0                              as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM fees_accumulated
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = fees_accumulated.pool_key_hash
                                       INNER JOIN blocks
                                                  ON fees_accumulated.block_number = blocks.number
                              UNION ALL
                              SELECT pool_keys.token1                     as token,
                                     key_hash,
                                     amount1                              as delta,
                                     date_trunc('hour', blocks.timestamp) as hour
                              FROM fees_accumulated
                                       INNER JOIN
                                   pool_keys
                                   ON pool_keys.key_hash = fees_accumulated.pool_key_hash
                                       INNER JOIN blocks
                                                  ON fees_accumulated.block_number = blocks.number)

        SELECT token,
               key_hash,
               hour,
               SUM(delta) as delta
        FROM token_deltas
        GROUP BY token, key_hash, hour
            );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_tvl_delta_by_token_by_hour_by_key_hash_token_hour_key_hash ON tvl_delta_by_token_by_hour_by_key_hash USING btree (key_hash, hour, token);
    `);
  }

  public async refreshMaterializedViews() {
    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY volume_by_token_by_hour_by_key_hash;
      REFRESH MATERIALIZED VIEW CONCURRENTLY tvl_delta_by_token_by_hour_by_key_hash;
    `);
  }

  private async loadCursor(): Promise<{
    orderKey: string;
    uniqueKey: string;
  } | null> {
    const { rows } = await this.pg.query({
      text: `SELECT order_key, unique_key
                   FROM cursor
                   WHERE id = 1;`,
    });
    if (rows.length === 1) {
      const { order_key, unique_key } = rows[0];

      return {
        orderKey: order_key,
        uniqueKey: unique_key,
      };
    } else {
      return null;
    }
  }

  public async writeCursor(cursor: { orderKey: string; uniqueKey: string }) {
    await this.pg.query({
      text: `
                INSERT INTO cursor (id, order_key, unique_key)
                VALUES (1, $1, $2)
                ON CONFLICT (id) DO UPDATE SET order_key  = $1,
                                               unique_key = $2;
            `,
      values: [BigInt(cursor.orderKey), cursor.uniqueKey],
    });
  }

  public async insertBlock({
    number,
    hash,
    timestamp,
  }: {
    number: bigint;
    hash: bigint;
    timestamp: bigint;
  }) {
    await this.pg.query({
      text: `
                INSERT INTO blocks (number, hash, timestamp)
                VALUES ($1, $2, to_timestamp($3));
            `,
      values: [number, hash, timestamp],
    });
  }

  private async insertPoolKeyHash(pool_key: PoolKey) {
    const key_hash = computeKeyHash(pool_key);

    await this.pg.query({
      text: `
                insert into pool_keys (key_hash,
                                       token0,
                                       token1,
                                       fee,
                                       tick_spacing,
                                       extension)
                values ($1, $2, $3, $4, $5, $6)
                ON CONFLICT DO NOTHING;
            `,
      values: [
        key_hash,
        BigInt(pool_key.token0),
        BigInt(pool_key.token1),
        pool_key.fee,
        pool_key.tick_spacing,
        BigInt(pool_key.extension),
      ],
    });
    return key_hash;
  }

  public async insertPositionMinted(
    minted: PositionMintedEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(minted.pool_key);

    await this.pg.query({
      text: `
                insert into position_minted
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 token_id,
                 lower_bound,
                 upper_bound,
                 pool_key_hash)
                values ($1, $2, $3, $4, $5, $6, $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        minted.id,
        minted.bounds.lower,
        minted.bounds.upper,
        pool_key_hash,
      ],
    });
  }

  public async insertPositionDeposit(deposit: DepositEvent, key: EventKey) {
    const pool_key_hash = await this.insertPoolKeyHash(deposit.pool_key);

    await this.pg.query({
      text: `
                insert into position_deposit
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 token_id,
                 lower_bound,
                 upper_bound,
                 pool_key_hash,
                 liquidity,
                 delta0,
                 delta1)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        deposit.id,
        deposit.bounds.lower,
        deposit.bounds.upper,
        pool_key_hash,
        deposit.liquidity,
        deposit.delta.amount0,
        deposit.delta.amount1,
      ],
    });
  }

  public async insertPositionWithdraw(withdraw: WithdrawEvent, key: EventKey) {
    const pool_key_hash = await this.insertPoolKeyHash(withdraw.pool_key);

    await this.pg.query({
      text: `
                insert into position_withdraw
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 token_id,
                 lower_bound,
                 upper_bound,
                 pool_key_hash,
                 collect_fees,
                 liquidity,
                 delta0,
                 delta1,
                 recipient)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        withdraw.id,
        withdraw.bounds.lower,
        withdraw.bounds.upper,
        pool_key_hash,
        withdraw.collect_fees,
        withdraw.liquidity,
        withdraw.delta.amount0,
        withdraw.delta.amount1,
        withdraw.recipient,
      ],
    });
  }

  public async insertPositionTransferEvent(
    transfer: TransferEvent,
    key: EventKey
  ) {
    // The `*` operator is the PostgreSQL range intersection operator.
    await this.pg.query({
      text: `
                INSERT INTO position_transfers
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 token_id,
                 from_address,
                 to_address)
                values ($1, $2, $3, $4, $5, $6, $7)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        transfer.id,
        transfer.from,
        transfer.to,
      ],
    });
  }

  public async insertPositionUpdatedEvent(
    event: PositionUpdatedEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO position_updates
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 locker,
                 pool_key_hash,
                 salt,
                 lower_bound,
                 upper_bound,
                 liquidity_delta,
                 delta0,
                 delta1)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        event.locker,

        pool_key_hash,

        event.params.salt,
        event.params.bounds.lower,
        event.params.bounds.upper,

        event.params.liquidity_delta,
        event.delta.amount0,
        event.delta.amount1,
      ],
    });
  }

  public async insertPositionFeesCollectedEvent(
    event: PositionFeesCollectedEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO position_fees_collected
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 pool_key_hash,
                 owner,
                 salt,
                 lower_bound,
                 upper_bound,
                 delta0,
                 delta1)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        pool_key_hash,

        event.position_key.owner,
        event.position_key.salt,
        event.position_key.bounds.lower,
        event.position_key.bounds.upper,

        event.delta.amount0,
        event.delta.amount1,
      ],
    });
  }

  public async insertInitializationEvent(
    event: PoolInitializationEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO pool_initializations
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 pool_key_hash,
                 tick,
                 sqrt_ratio,
                 call_points)
                values ($1, $2, $3, $4, $5, $6, $7, $8);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        pool_key_hash,

        event.tick,
        event.sqrt_ratio,
        event.call_points,
      ],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: FeesWithdrawnEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                INSERT INTO protocol_fees_withdrawn
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 recipient,
                 token,
                 amount)
                values ($1, $2, $3, $4, $5, $6, $7);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        event.recipient,
        event.token,
        event.amount,
      ],
    });
  }

  public async insertProtocolFeesPaid(event: FeesPaidEvent, key: EventKey) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO protocol_fees_paid
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 pool_key_hash,
                 owner,
                 salt,
                 lower_bound,
                 upper_bound,
                 delta0,
                 delta1)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        pool_key_hash,

        event.position_key.owner,
        event.position_key.salt,
        event.position_key.bounds.lower,
        event.position_key.bounds.upper,

        event.delta.amount0,
        event.delta.amount1,
      ],
    });
  }

  public async insertFeesAccumulatedEvent(
    event: FeesAccumulatedEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO fees_accumulated
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 pool_key_hash,
                 amount0,
                 amount1)
                values ($1, $2, $3, $4, $5, $6, $7);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        pool_key_hash,

        event.amount0,
        event.amount1,
      ],
    });
  }

  public async insertSwappedEvent(event: SwappedEvent, key: EventKey) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                INSERT INTO swaps
                (block_number,
                 transaction_index,
                 event_index,
                 transaction_hash,
                 locker,
                 pool_key_hash,
                 delta0,
                 delta1,
                 sqrt_ratio_after,
                 tick_after,
                 liquidity_after)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        event.locker,
        pool_key_hash,

        event.delta.amount0,
        event.delta.amount1,
        event.sqrt_ratio_after,
        event.tick_after,
        event.liquidity_after,
      ],
    });
  }

  private async deleteOldBlockNumbers(
    invalidatedBlockNumber: bigint
  ): Promise<void> {
    await this.pg.query({
      text: `
                DELETE
                FROM blocks
                WHERE number >= $1;
            `,
      values: [invalidatedBlockNumber],
    });
  }

  public async invalidateBlockNumber(invalidatedBlockNumber: bigint) {
    await this.deleteOldBlockNumbers(invalidatedBlockNumber);
  }
}
