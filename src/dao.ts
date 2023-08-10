import { Client, PoolClient } from "pg";
import { pedersen_from_hex } from "pedersen-fast";
import { EventKey } from "./processor";
import {
  FeesPaidEvent,
  FeesWithdrawnEvent,
  PoolInitializationEvent,
  PoolKey,
  PositionFeesCollectedEvent,
  PositionUpdatedEvent,
  SwappedEvent,
} from "./events/core";
import { PositionMintedEvent } from "./events/positions";
import { TransferEvent } from "./events/nft";

function toHex(x: bigint): string {
  return `0x${x.toString(16)}`;
}

function computeKeyHash(pool_key: PositionMintedEvent["pool_key"]): bigint {
  return BigInt(
    pedersen_from_hex(
      pedersen_from_hex(
        pedersen_from_hex(toHex(pool_key.token0), toHex(pool_key.token1)),
        pedersen_from_hex(toHex(pool_key.fee), toHex(pool_key.tick_spacing))
      ),
      toHex(pool_key.extension)
    )
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
    const result = await Promise.all([
      this.pg.query(`CREATE TABLE IF NOT EXISTS blocks
                     (
                         number    INT8      NOT NULL PRIMARY KEY,
                         hash      NUMERIC   NOT NULL,
                         timestamp TIMESTAMP NOT NULL
                     );

        CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks USING btree (timestamp);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks USING btree (hash);
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS cursor
          (
              id         INT     NOT NULL UNIQUE CHECK (id = 1), -- only one row.
              order_key  NUMERIC NOT NULL,
              unique_key TEXT    NOT NULL
          );
      `),

      this.pg.query(`
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
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS position_minted
          (
              token_id      INT8    NOT NULL PRIMARY KEY,
              lower_bound   INT4    NOT NULL,
              upper_bound   INT4    NOT NULL,

              pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

              block_number  INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_position_minted_pool_key_hash ON position_minted USING btree (pool_key_hash);
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS position_transfers
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              token_id         INT8    NOT NULL,
              from_address     NUMERIC NOT NULL,
              to_address       NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );

          CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id ON position_transfers USING btree (token_id);
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS position_updates
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              locker           NUMERIC NOT NULL,

              pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

              salt             NUMERIC NOT NULL,
              lower_bound      INT4    NOT NULL,
              upper_bound      INT4    NOT NULL,

              liquidity_delta  NUMERIC NOT NULL,
              delta0           NUMERIC NOT NULL,
              delta1           NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS position_fees_collected
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

              owner            NUMERIC NOT NULL,
              salt             NUMERIC NOT NULL,
              lower_bound      INT4    NOT NULL,
              upper_bound      INT4    NOT NULL,

              delta0           NUMERIC NOT NULL,
              delta1           NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS protocol_fees_withdrawn
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              recipient        NUMERIC NOT NULL,
              token            NUMERIC NOT NULL,
              amount           NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS protocol_fees_paid
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

              owner            NUMERIC NOT NULL,
              salt             NUMERIC NOT NULL,
              lower_bound      INT4    NOT NULL,
              upper_bound      INT4    NOT NULL,

              delta0           NUMERIC NOT NULL,
              delta1           NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS initializations
          (
              transaction_hash NUMERIC  NOT NULL,
              block_number     INT8     NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4     NOT NULL,

              pool_key_hash    NUMERIC  NOT NULL REFERENCES pool_keys (key_hash),

              tick             INT4     NOT NULL,
              sqrt_ratio       NUMERIC  NOT NULL,
              call_points      SMALLINT NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),

      this.pg.query(`
          CREATE TABLE IF NOT EXISTS swaps
          (
              transaction_hash NUMERIC NOT NULL,
              block_number     INT8    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
              index            INT4    NOT NULL,

              locker           NUMERIC NOT NULL,
              pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),
              
              delta0           NUMERIC NOT NULL,
              delta1           NUMERIC NOT NULL,

              sqrt_ratio_after NUMERIC NOT NULL,
              tick_after       INT4    NOT NULL,
              liquidity_after  NUMERIC NOT NULL,

              PRIMARY KEY (transaction_hash, block_number, index)
          );
      `),
    ]);
  }

  private async loadCursor(): Promise<{
    orderKey: string;
    uniqueKey: string;
  } | null> {
    const { rows } = await this.pg.query({
      text: `SELECT order_key, unique_key FROM cursor WHERE id = 1;`,
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
          ON CONFLICT (id) DO UPDATE SET order_key = $1, unique_key = $2;
      `,
      values: [BigInt(cursor.orderKey), cursor.uniqueKey],
    });
  }

  private async insertKeyHash(pool_key: PoolKey) {
    const key_hash = computeKeyHash(pool_key);

    await this.pg.query({
      text: `
        insert into pool_keys (
          key_hash,
          token0,
          token1,
          fee,
          tick_spacing,
          extension
        ) values ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING;
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
    token: PositionMintedEvent,
    blockNumber: bigint
  ) {
    const pool_key_hash = await this.insertKeyHash(token.pool_key);

    await this.pg.query({
      text: `
      insert into position_minted (
        token_id,
        lower_bound,
        upper_bound,
        pool_key_hash,
        block_number
      ) values ($1, $2, $3, $4, $5); 
      `,
      values: [
        token.id,
        token.bounds.lower,
        token.bounds.upper,
        pool_key_hash,
        blockNumber,
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
      INSERT INTO position_transfers (
        transaction_hash,
        block_number,
        index,

        token_id,
        from_address,
        to_address
      ) values ($1, $2, $3, $4, $5, $6)
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,
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
    const pool_key_hash = await this.insertKeyHash(event.pool_key);

    await this.pg.query({
      text: `
      INSERT INTO position_updates (
        transaction_hash,
        block_number,
        index,

        locker,
        pool_key_hash,

        salt,
        lower_bound,
        upper_bound,

        liquidity_delta,
        delta0,
        delta1
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

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
    const pool_key_hash = await this.insertKeyHash(event.pool_key);

    await this.pg.query({
      text: `
      INSERT INTO position_fees_collected (
        transaction_hash,
        block_number,
        index,

        pool_key_hash,

        owner,
        salt,
        lower_bound,
        upper_bound,

        delta0,
        delta1
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

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
    const pool_key_hash = await this.insertKeyHash(event.pool_key);

    await this.pg.query({
      text: `
      INSERT INTO initializations (
        transaction_hash,
        block_number,
        index,

        pool_key_hash,

        tick,
        sqrt_ratio,
        call_points
      ) values ($1, $2, $3, $4, $5, $6, $7);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

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
      INSERT INTO protocol_fees_withdrawn (
        transaction_hash,
        block_number,
        index,

        recipient,
        token,
        amount
      ) values ($1, $2, $3, $4, $5, $6);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

        event.recipient,
        event.token,
        event.amount,
      ],
    });
  }

  public async insertProtocolFeesPaid(event: FeesPaidEvent, key: EventKey) {
    const pool_key_hash = await this.insertKeyHash(event.pool_key);

    await this.pg.query({
      text: `
      INSERT INTO protocol_fees_paid (
        transaction_hash,
        block_number,
        index,

        pool_key_hash,

        owner,
        salt,
        lower_bound,
        upper_bound,                                      

        delta0,
        delta1
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

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

  public async insertSwappedEvent(event: SwappedEvent, key: EventKey) {
    const pool_key_hash = await this.insertKeyHash(event.pool_key);

    await this.pg.query({
      text: `
      INSERT INTO swaps (
        transaction_hash,
        block_number,
        index,

        locker,
        pool_key_hash,

        delta0,
        delta1,
        sqrt_ratio_after,
        tick_after,
        liquidity_after
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      values: [
        key.txHash,
        key.blockNumber,
        key.logIndex,

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

  private async deleteOldBlockNumbers(
    invalidatedBlockNumber: bigint
  ): Promise<void> {
    await this.pg.query({
      text: `
        DELETE FROM blocks
        WHERE number >= $1;
      `,
      values: [invalidatedBlockNumber],
    });
  }

  public async invalidateBlockNumber(invalidatedBlockNumber: bigint) {
    await this.deleteOldBlockNumbers(invalidatedBlockNumber);
  }
}
