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

  public async initializeSchema() {
    await this.beginTransaction();
    await this.createSchema();
    const cursor = await this.loadCursor();
    // we need to clear anything that was potentially inserted as pending before starting
    if (cursor) {
      await this.deleteOldBlockNumbers(Number(cursor.orderKey) + 1);
    }
    await this.commitTransaction();
    return cursor;
  }

  private async createSchema(): Promise<void> {
    await this.pg.query(`
        CREATE TABLE IF NOT EXISTS cursor
        (
            indexer_name TEXT        NOT NULL PRIMARY KEY,
            order_key    BIGINT      NOT NULL,
            unique_key   bytea,
            last_updated timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks
        (
            chain_id int8        NOT NULL,
            number   int8        NOT NULL,
            hash     NUMERIC     NOT NULL,
            time     timestamptz NOT NULL,
            inserted timestamptz NOT NULL DEFAULT NOW(),
            PRIMARY KEY (chain_id, number)
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_chain_id_time ON blocks USING btree (chain_id, time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_chain_id_hash ON blocks USING btree (chain_id, hash);

        CREATE TABLE IF NOT EXISTS pool_keys
        (
            chain_id     int8    NOT NULL,
            id           serial8 NOT NULL,
            core_address NUMERIC NOT NULL,
            pool_id      NUMERIC NOT NULL,
            token0       NUMERIC NOT NULL,
            token1       NUMERIC NOT NULL,
            fee          NUMERIC NOT NULL,
            tick_spacing INT     NOT NULL,
            extension    NUMERIC NOT NULL,
            config       NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_keys_chain_id_core_address_pool_id ON pool_keys USING btree (chain_id, core_address, pool_id);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_chain_id_token0 ON pool_keys USING btree (chain_id, token0);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_chain_id_token1 ON pool_keys USING btree (chain_id, token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_chain_id_token0_token1 ON pool_keys USING btree (chain_id, token0, token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_chain_id_extension ON pool_keys USING btree (chain_id, extension);

        -- all events reference an event id which contains the metadata of the event
        CREATE TABLE IF NOT EXISTS event_keys
        (
            chain_id          int8    NOT NULL,
            sort_id           int8 GENERATED ALWAYS AS (block_number * 4294967296 + transaction_index * 65536 + event_index) STORED,
            transaction_hash  NUMERIC NOT NULL,
            block_number      int8    NOT NULL,
            transaction_index int2    NOT NULL,
            event_index       int2    NOT NULL,
            emitter           NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, sort_id),
            FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, number) ON DELETE CASCADE,
            UNIQUE (chain_id, block_number, transaction_index, event_index)
        );
        CREATE INDEX IF NOT EXISTS idx_event_keys_transaction_hash ON event_keys USING btree (transaction_hash);

        -- Unified table for all pool balance changes (must be created before tables that reference it)
        CREATE TABLE IF NOT EXISTS pool_balance_change_event
        (
            event_id      int8    NOT NULL REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,
            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),
            delta0        NUMERIC NOT NULL,
            delta1        NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pool_balance_change_event_pool_key_hash_event_id ON pool_balance_change_event USING btree (pool_key_hash, event_id);

        CREATE TABLE IF NOT EXISTS position_transfers
        (
            chain_id     int8    NOT NULL,
            event_id     int8    NOT NULL,

            token_id     NUMERIC NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id_from_to ON position_transfers (token_id, from_address, to_address);
        CREATE INDEX IF NOT EXISTS idx_position_transfers_to_address ON position_transfers (to_address);

        CREATE TABLE IF NOT EXISTS order_transfers
        (
            chain_id     int8    NOT NULL,
            event_id     int8    NOT NULL,

            token_id     NUMERIC NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_order_transfers_token_id_from_to ON order_transfers (token_id, from_address, to_address);
        CREATE INDEX IF NOT EXISTS idx_order_transfers_to_address ON order_transfers (to_address);

        CREATE TABLE IF NOT EXISTS position_updates
        (
            chain_id        int8    NOT NULL,
            pool_balance_change_id int8 NOT NULL REFERENCES pool_balance_change_event (event_id) ON DELETE CASCADE,

            locker          NUMERIC NOT NULL,

            pool_key_id   int8 NOT NULL,

            salt            NUMERIC NOT NULL,
            lower_bound     int4    NOT NULL,
            upper_bound     int4    NOT NULL,

            liquidity_delta NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, pool_balance_change_id),
            FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_position_updates_pool_key_id_event_id ON position_updates USING btree (pool_key_id, pool_balance_change_id);
        CREATE INDEX IF NOT EXISTS idx_position_updates_locker_salt ON position_updates USING btree (locker, salt);
        CREATE INDEX IF NOT EXISTS idx_position_updates_salt ON position_updates USING btree (salt);

        CREATE TABLE IF NOT EXISTS position_fees_collected
        (
            chain_id      int8    NOT NULL,
            pool_balance_change_id int8 NOT NULL REFERENCES pool_balance_change_event (event_id) ON DELETE CASCADE,

            pool_key_id int8 NOT NULL,

            owner         NUMERIC NOT NULL,
            salt          NUMERIC NOT NULL,
            lower_bound   int4    NOT NULL,
            upper_bound   int4    NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_pool_key_id ON position_fees_collected (pool_key_id);
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_salt ON position_fees_collected USING btree (salt);


        CREATE TABLE IF NOT EXISTS protocol_fees_withdrawn
        (
            chain_id  int8    NOT NULL,
            event_id  int8    NOT NULL,

            recipient NUMERIC NOT NULL,
            token     NUMERIC NOT NULL,
            amount    NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );


        CREATE TABLE IF NOT EXISTS fees_accumulated
        (
          chain_id      int8    NOT NULL,
          pool_balance_change_id int8 NOT NULL REFERENCES pool_balance_change_event (event_id) ON DELETE CASCADE,

          pool_key_id int8 NOT NULL,
          PRIMARY KEY (chain_id, pool_balance_change_id),
          FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
          FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_fees_accumulated_pool_key_id ON fees_accumulated (pool_key_id);

        CREATE TABLE IF NOT EXISTS extension_registrations
        (
            chain_id  int8    NOT NULL,
            event_id  int8    NOT NULL,
            extension NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pool_initializations
        (
            chain_id      int8    NOT NULL,
            event_id      int8    NOT NULL,

            pool_key_id int8 NOT NULL,

            tick          int4    NOT NULL,
            sqrt_ratio    NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_pool_initializations_pool_key_id ON pool_initializations (pool_key_id);


        CREATE TABLE IF NOT EXISTS swaps
        (
            chain_id         int8    NOT NULL,
            pool_balance_change_id int8 NOT NULL REFERENCES pool_balance_change_event (event_id) ON DELETE CASCADE,

            locker           NUMERIC NOT NULL,
            pool_key_id    int8 NOT NULL,

            sqrt_ratio_after NUMERIC NOT NULL,
            tick_after       int4    NOT NULL,
            liquidity_after  NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_id_event_id ON swaps USING btree (pool_key_id, pool_balance_change_id);
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_id_event_id_desc ON swaps USING btree (pool_key_id, pool_balance_change_id DESC) INCLUDE (sqrt_ratio_after, tick_after, liquidity_after);

        CREATE OR REPLACE VIEW pool_states_view AS
        (
        WITH lss AS (SELECT id AS pool_key_id,
                            COALESCE(last_swap.pool_balance_change_id, pi.pool_balance_change_id)           AS last_swap_event_id,
                            COALESCE(last_swap.sqrt_ratio_after, pi.sqrt_ratio) AS sqrt_ratio,
                            COALESCE(last_swap.tick_after, pi.tick)             AS tick,
                            COALESCE(last_swap.liquidity_after, 0)              AS liquidity_last
                     FROM pool_keys
                              LEFT JOIN LATERAL (
                         SELECT pool_balance_change_id, sqrt_ratio_after, tick_after, liquidity_after
                         FROM swaps
                         WHERE pool_keys.id = swaps.pool_key_id AND pool_keys.chain_id = swaps.chain_id
                         ORDER BY pool_balance_change_id DESC
                         LIMIT 1
                         ) AS last_swap ON TRUE
                              LEFT JOIN LATERAL (
                         SELECT pool_balance_change_id, sqrt_ratio, tick
                         FROM pool_initializations
                         WHERE pool_initializations.pool_key_id = pool_keys.id AND pool_initializations.chain_id = pool_keys.chain_id
                         ORDER BY pool_balance_change_id DESC
                         LIMIT 1
                         ) AS pi ON TRUE),
             pl AS (SELECT pool_key_id,
                           (SELECT pool_balance_change_id
                            FROM position_updates
                            WHERE pool_key_id = position_updates.pool_key_id
                            ORDER BY pool_balance_change_id DESC
                            LIMIT 1)                                   AS last_update_event_id,
                           (COALESCE(liquidity_last, 0) + COALESCE((SELECT SUM(liquidity_delta)
                                                                    FROM position_updates AS pu
                                                                    WHERE lss.last_swap_event_id < pu.pool_balance_change_id
                                                                      AND pu.pool_key_id = lss.pool_key_id
                                                                      AND lss.tick BETWEEN pu.lower_bound AND (pu.upper_bound - 1)),
                                                                   0)) AS liquidity
                    FROM lss)
        SELECT lss.pool_key_id,
               sqrt_ratio,
               tick,
               liquidity,
               GREATEST(lss.last_swap_event_id, pl.last_update_event_id) AS last_event_id,
               pl.last_update_event_id                                   AS last_liquidity_update_event_id
        FROM lss
                 JOIN pl ON lss.pool_key_id = pl.pool_key_id
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS pool_states_materialized AS
        (
        SELECT pool_key_id, last_event_id, last_liquidity_update_event_id, sqrt_ratio, liquidity, tick
        FROM pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_states_materialized_pool_key_id ON pool_states_materialized USING btree (pool_key_id);

        CREATE TABLE IF NOT EXISTS hourly_volume_by_token
        (
            pool_key_id   int8,
            hour       timestamptz,
            token      NUMERIC,
            volume     NUMERIC,
            fees       NUMERIC,
            swap_count NUMERIC,
            PRIMARY KEY (pool_key_id, hour, token)
        );

        CREATE TABLE IF NOT EXISTS hourly_price_data
        (
            token0     NUMERIC,
            token1     NUMERIC,
            hour       timestamptz,
            k_volume   NUMERIC,
            total      NUMERIC,
            swap_count NUMERIC,
            PRIMARY KEY (token0, token1, hour)
        );


        CREATE TABLE IF NOT EXISTS hourly_tvl_delta_by_token
        (
            pool_key_id int8,
            hour     timestamptz,
            token    NUMERIC,
            delta    NUMERIC,
            PRIMARY KEY (pool_key_id, hour, token)
        );

        CREATE TABLE IF NOT EXISTS hourly_revenue_by_token
        (
            pool_key_id int8,
            hour     timestamptz,
            token    NUMERIC,
            revenue  NUMERIC,
            PRIMARY KEY (pool_key_id, hour, token)
        );

        CREATE OR REPLACE VIEW per_pool_per_tick_liquidity_view AS
        (
        WITH all_tick_deltas AS (SELECT pool_key_id,
                                        lower_bound AS       tick,
                                        SUM(liquidity_delta) net_liquidity_delta,
                                        SUM(liquidity_delta) total_liquidity_on_tick
                                 FROM position_updates
                                 GROUP BY pool_key_id, lower_bound
                                 UNION ALL
                                 SELECT pool_key_id,
                                        upper_bound AS        tick,
                                        SUM(-liquidity_delta) net_liquidity_delta,
                                        SUM(liquidity_delta)  total_liquidity_on_tick
                                 FROM position_updates
                                 GROUP BY pool_key_id, upper_bound),
             summed AS (SELECT pool_key_id,
                               tick,
                               SUM(net_liquidity_delta)     AS net_liquidity_delta_diff,
                               SUM(total_liquidity_on_tick) AS total_liquidity_on_tick
                        FROM all_tick_deltas
                        GROUP BY pool_key_id, tick)
        SELECT pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick
        FROM summed
        WHERE net_liquidity_delta_diff != 0
        ORDER BY tick);

        CREATE TABLE IF NOT EXISTS per_pool_per_tick_liquidity_incremental_view
        (
            pool_key_id            int8,
            tick                     int4,
            net_liquidity_delta_diff NUMERIC,
            total_liquidity_on_tick  NUMERIC,
            PRIMARY KEY (pool_key_id, tick)
        );

        DELETE
        FROM per_pool_per_tick_liquidity_incremental_view
        WHERE TRUE;
        INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_id, tick, net_liquidity_delta_diff,
                                                                  total_liquidity_on_tick)
            (SELECT pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick
             FROM per_pool_per_tick_liquidity_view);

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Update or insert for lower_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff + new.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick + new.liquidity_delta
            WHERE pool_key_id = new.pool_key_id
              AND tick = new.lower_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_id, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (new.pool_key_id, new.lower_bound, new.liquidity_delta, new.liquidity_delta);
            END IF;

            -- Delete if total_liquidity_on_tick is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_id = new.pool_key_id
              AND tick = new.lower_bound
              AND total_liquidity_on_tick = 0;

            -- Update or insert for upper_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff - new.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick + new.liquidity_delta
            WHERE pool_key_id = new.pool_key_id
              AND tick = new.upper_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_id, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (new.pool_key_id, new.upper_bound, -new.liquidity_delta, new.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_id = new.pool_key_id
              AND tick = new.upper_bound
              AND total_liquidity_on_tick = 0;

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Reverse effect for lower_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff - old.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick - old.liquidity_delta
            WHERE pool_key_id = old.pool_key_id
              AND tick = old.lower_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_id, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (old.pool_key_id, old.lower_bound, -old.liquidity_delta, -old.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_id = old.pool_key_id
              AND tick = old.lower_bound
              AND total_liquidity_on_tick = 0;

            -- Reverse effect for upper_bound
            UPDATE per_pool_per_tick_liquidity_incremental_view
            SET net_liquidity_delta_diff = net_liquidity_delta_diff + old.liquidity_delta,
                total_liquidity_on_tick  = total_liquidity_on_tick - old.liquidity_delta
            WHERE pool_key_id = old.pool_key_id
              AND tick = old.upper_bound;

            IF NOT found THEN
                INSERT INTO per_pool_per_tick_liquidity_incremental_view (pool_key_id, tick,
                                                                          net_liquidity_delta_diff,
                                                                          total_liquidity_on_tick)
                VALUES (old.pool_key_id, old.upper_bound, old.liquidity_delta, -old.liquidity_delta);
            END IF;

            -- Delete if net_liquidity_delta_diff is zero
            DELETE
            FROM per_pool_per_tick_liquidity_incremental_view
            WHERE pool_key_id = old.pool_key_id
              AND tick = old.upper_bound
              AND total_liquidity_on_tick = 0;

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_update()
            RETURNS TRIGGER AS
        $$
        BEGIN
            -- Reverse OLD row effects (similar to DELETE)
            PERFORM net_liquidity_deltas_after_delete();

            -- Apply NEW row effects (similar to INSERT)
            PERFORM net_liquidity_deltas_after_insert();

            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_insert
            AFTER INSERT
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_insert();

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_delete
            AFTER DELETE
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_delete();

        CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_update
            AFTER UPDATE
            ON position_updates
            FOR EACH ROW
        EXECUTE FUNCTION net_liquidity_deltas_after_update();

        CREATE TABLE IF NOT EXISTS twamm_order_updates
        (
            chain_id         int8        NOT NULL,
            event_id         int8        NOT NULL,

            pool_key_id         int8     NOT NULL,

            owner            NUMERIC     NOT NULL,
            salt             NUMERIC     NOT NULL,
            sale_rate_delta0 NUMERIC     NOT NULL,
            sale_rate_delta1 NUMERIC     NOT NULL,
            start_time       timestamptz NOT NULL,
            end_time         timestamptz NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_pool_key_id_event_id ON twamm_order_updates USING btree (pool_key_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_pool_key_id_time ON twamm_order_updates USING btree (pool_key_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_owner_salt ON twamm_order_updates USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_salt ON twamm_order_updates USING btree (salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_salt_key_hash_start_end_owner_event_id ON twamm_order_updates (salt, pool_key_id, start_time, end_time, owner, event_id);

        CREATE TABLE IF NOT EXISTS twamm_proceeds_withdrawals
        (
            chain_id   int8        NOT NULL,
            event_id   int8        NOT NULL,

            pool_key_id   int8     NOT NULL,

            owner      NUMERIC     NOT NULL,
            salt       NUMERIC     NOT NULL,
            start_time timestamptz NOT NULL,
            end_time   timestamptz NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_pool_key_id_event_id ON twamm_proceeds_withdrawals USING btree (pool_key_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_pool_key_id_time ON twamm_proceeds_withdrawals USING btree (pool_key_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_owner_salt ON twamm_proceeds_withdrawals USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_salt ON twamm_proceeds_withdrawals USING btree (salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_salt_event_id_desc ON twamm_proceeds_withdrawals (salt, event_id DESC);

        CREATE TABLE IF NOT EXISTS twamm_virtual_order_executions
        (
            chain_id         int8    NOT NULL,
            event_id         int8    NOT NULL,

            pool_key_id         int8 NOT NULL,

            token0_sale_rate NUMERIC NOT NULL,
            token1_sale_rate NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE,
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_virtual_order_executions_pool_key_id_event_id ON twamm_virtual_order_executions USING btree (pool_key_id, event_id DESC);

        CREATE OR REPLACE VIEW twamm_pool_states_view AS
        (
        WITH lvoe_id AS (SELECT pool_key_id, MAX(event_id) AS event_id
                         FROM twamm_virtual_order_executions
                         GROUP BY pool_key_id),

             last_virtual_order_execution AS (SELECT pk.id AS pool_key_id,
                                                     last_voe.token0_sale_rate,
                                                     last_voe.token1_sale_rate,
                                                     last_voe.event_id AS last_virtual_order_execution_event_id,
                                                     b.time            AS last_virtual_execution_time
                                              FROM pool_keys pk
                                                       JOIN lvoe_id ON lvoe_id.pool_key_id = pk.id
                                                       JOIN twamm_virtual_order_executions last_voe
                                                            ON last_voe.chain_id = pk.chain_id AND last_voe.event_id = lvoe_id.event_id
                                                       JOIN event_keys ek ON last_voe.chain_id = ek.chain_id AND last_voe.event_id = ek.sort_id
                                                       JOIN blocks b ON ek.chain_id = b.chain_id AND ek.block_number = b.number),
             active_order_updates_after_lvoe AS (SELECT lvoe_1.pool_key_id,
                                                        SUM(tou.sale_rate_delta0) AS sale_rate_delta0,
                                                        SUM(tou.sale_rate_delta1) AS sale_rate_delta1,
                                                        MAX(tou.event_id)         AS last_order_update_event_id
                                                 FROM last_virtual_order_execution lvoe_1
                                                          JOIN twamm_order_updates tou
                                                               ON tou.pool_key_id = lvoe_1.pool_key_id AND
                                                                  tou.event_id >
                                                                  lvoe_1.last_virtual_order_execution_event_id AND
                                                                  tou.start_time <=
                                                                  lvoe_1.last_virtual_execution_time AND
                                                                  tou.end_time >
                                                                  lvoe_1.last_virtual_execution_time
                                                 GROUP BY lvoe_1.pool_key_id)
        SELECT lvoe.pool_key_id,
               lvoe.token0_sale_rate + COALESCE(ou_lvoe.sale_rate_delta0, 0::NUMERIC) AS token0_sale_rate,
               lvoe.token1_sale_rate + COALESCE(ou_lvoe.sale_rate_delta1, 0::NUMERIC) AS token1_sale_rate,
               lvoe.last_virtual_execution_time,
               GREATEST(COALESCE(ou_lvoe.last_order_update_event_id, lvoe.last_virtual_order_execution_event_id),
                        psm.last_event_id)                                            AS last_event_id
        FROM last_virtual_order_execution lvoe
                 JOIN pool_states_materialized psm ON lvoe.pool_key_id = psm.pool_key_id
                 LEFT JOIN active_order_updates_after_lvoe ou_lvoe ON lvoe.pool_key_id = ou_lvoe.pool_key_id
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_pool_states_materialized AS
        (
        SELECT pool_key_id,
               token0_sale_rate,
               token1_sale_rate,
               last_virtual_execution_time,
               last_event_id
        FROM twamm_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_pool_states_materialized_key_hash ON twamm_pool_states_materialized USING btree (pool_key_id);

        CREATE OR REPLACE VIEW twamm_sale_rate_deltas_view AS
        (
        WITH all_order_deltas AS (SELECT pool_key_id,
                                         start_time AS         time,
                                         SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY pool_key_id, start_time
                                  UNION ALL
                                  SELECT pool_key_id,
                                         end_time AS            time,
                                         -SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         -SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY pool_key_id, end_time),
             summed AS (SELECT pool_key_id,
                               time,
                               SUM(net_sale_rate_delta0) AS net_sale_rate_delta0,
                               SUM(net_sale_rate_delta1) AS net_sale_rate_delta1
                        FROM all_order_deltas
                        GROUP BY pool_key_id, time)
        SELECT pool_key_id, time, net_sale_rate_delta0, net_sale_rate_delta1
        FROM summed
        WHERE net_sale_rate_delta0 != 0
           OR net_sale_rate_delta1 != 0
        ORDER BY pool_key_id, time);

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_sale_rate_deltas_materialized AS
        (
        SELECT tsrdv.pool_key_id, tsrdv.time, tsrdv.net_sale_rate_delta0, tsrdv.net_sale_rate_delta1
        FROM twamm_sale_rate_deltas_view AS tsrdv
                 JOIN twamm_pool_states_materialized tpsm
                      ON tpsm.pool_key_id = tsrdv.pool_key_id AND
                         tpsm.last_virtual_execution_time < tsrdv.time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_sale_rate_deltas_materialized_pool_key_id_time ON twamm_sale_rate_deltas_materialized USING btree (pool_key_id, time);

        CREATE TABLE IF NOT EXISTS oracle_snapshots
        (
            chain_id                                  int8    NOT NULL,
            event_id                                  int8    NOT NULL,

            token                                     NUMERIC NOT NULL,
            snapshot_block_timestamp                  int8    NOT NULL,
            snapshot_tick_cumulative                  NUMERIC NOT NULL,
            snapshot_seconds_per_liquidity_cumulative NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_token_snapshot_block_timestamp ON oracle_snapshots USING btree (token, snapshot_block_timestamp);

        CREATE TABLE IF NOT EXISTS mev_resist_pool_keys
        (
            chain_id      int8    NOT NULL,
            pool_key_id int8 NOT NULL,
            PRIMARY KEY (chain_id, pool_key_id),
            FOREIGN KEY (chain_id, pool_key_id) REFERENCES pool_keys (chain_id, id)
        );

        CREATE TABLE IF NOT EXISTS incentives_funded
        (
            chain_id    int8    NOT NULL,
            event_id    int8    NOT NULL,

            owner       NUMERIC NOT NULL,
            token       NUMERIC NOT NULL,
            root        NUMERIC NOT NULL,
            amount_next NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS incentives_refunded
        (
            chain_id      int8    NOT NULL,
            event_id      int8    NOT NULL,

            owner         NUMERIC NOT NULL,
            token         NUMERIC NOT NULL,
            root          NUMERIC NOT NULL,
            refund_amount NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );


        CREATE TABLE IF NOT EXISTS token_wrapper_deployed
        (
            chain_id    int8   NOT NULL,
            event_id    int8   NOT NULL,

            token_wrapper      NUMERIC NOT NULL,
            underlying_token   NUMERIC NOT NULL,
            unlock_time        NUMERIC NOT NULL,
            PRIMARY KEY (chain_id, event_id),
            FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
        );


        CREATE OR REPLACE VIEW last_24h_pool_stats_view AS
        (
        WITH volume AS (SELECT vbt.pool_key_id,
                               SUM(CASE WHEN vbt.token = token0 THEN vbt.volume ELSE 0 END) AS volume0,
                               SUM(CASE WHEN vbt.token = token1 THEN vbt.volume ELSE 0 END) AS volume1,
                               SUM(CASE WHEN vbt.token = token0 THEN vbt.fees ELSE 0 END)   AS fees0,
                               SUM(CASE WHEN vbt.token = token1 THEN vbt.fees ELSE 0 END)   AS fees1
                        FROM hourly_volume_by_token vbt
                                 JOIN pool_keys ON vbt.pool_key_id = pool_keys.id
                        WHERE hour >= NOW() - INTERVAL '24 hours'
                        GROUP BY vbt.pool_key_id),
             tvl_total AS (SELECT tbt.pool_key_id,
                                  SUM(CASE WHEN token = token0 THEN delta ELSE 0 END) AS tvl0,
                                  SUM(CASE WHEN token = token1 THEN delta ELSE 0 END) AS tvl1
                           FROM hourly_tvl_delta_by_token tbt
                                    JOIN pool_keys pk ON tbt.pool_key_id = pk.id
                           GROUP BY tbt.pool_key_id),
             tvl_delta_24h AS (SELECT tbt.pool_key_id,
                                      SUM(CASE WHEN token = token0 THEN delta ELSE 0 END) AS tvl0,
                                      SUM(CASE WHEN token = token1 THEN delta ELSE 0 END) AS tvl1
                               FROM hourly_tvl_delta_by_token tbt
                                        JOIN pool_keys pk ON tbt.pool_key_id = pk.id
                               WHERE hour >= NOW() - INTERVAL '24 hours'
                               GROUP BY tbt.pool_key_id)
        SELECT pool_keys.id,
               COALESCE(volume.volume0, 0)     AS volume0_24h,
               COALESCE(volume.volume1, 0)     AS volume1_24h,
               COALESCE(volume.fees0, 0)       AS fees0_24h,
               COALESCE(volume.fees1, 0)       AS fees1_24h,
               COALESCE(tvl_total.tvl0, 0)     AS tvl0_total,
               COALESCE(tvl_total.tvl1, 0)     AS tvl1_total,
               COALESCE(tvl_delta_24h.tvl0, 0) AS tvl0_delta_24h,
               COALESCE(tvl_delta_24h.tvl1, 0) AS tvl1_delta_24h
        FROM pool_keys
                 LEFT JOIN volume ON volume.pool_key_id = pool_keys.id
                 LEFT JOIN
             tvl_total ON pool_keys.id = tvl_total.pool_key_id
                 LEFT JOIN tvl_delta_24h
                           ON tvl_delta_24h.pool_key_id = pool_keys.id
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS last_24h_pool_stats_materialized AS
        (
        SELECT pool_key_id,
               volume0_24h,
               volume1_24h,
               fees0_24h,
               fees1_24h,
               tvl0_total,
               tvl1_total,
               tvl0_delta_24h,
               tvl1_delta_24h
        FROM last_24h_pool_stats_view
            );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_last_24h_pool_stats_materialized_pool_key_id ON last_24h_pool_stats_materialized USING btree (pool_key_id);

        CREATE OR REPLACE VIEW oracle_pool_states_view AS
        (
        SELECT pk.id AS pool_key_id, MAX(snapshot_block_timestamp) AS last_snapshot_block_timestamp
        FROM oracle_snapshots os
                 JOIN event_keys ek ON ek.sort_id = os.event_id
                 JOIN pool_keys pk ON ek.emitter = pk.extension AND pk.token1 = os.token
        GROUP BY pk.id);

        CREATE MATERIALIZED VIEW IF NOT EXISTS oracle_pool_states_materialized AS
        (
        SELECT pool_key_id,
               last_snapshot_block_timestamp
        FROM oracle_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_pool_states_materialized_pool_key_id ON oracle_pool_states_materialized USING btree (pool_key_id);

        CREATE OR REPLACE VIEW token_pair_realized_volatility_view AS
        WITH times AS (SELECT blocks.time - INTERVAL '7 days' AS start_time,
                              blocks.time                     AS end_time
                       FROM blocks
                       ORDER BY number DESC
                       LIMIT 1),

             prices AS (SELECT token0,
                               token1,
                               hour,
                               LN(total / k_volume)                                          AS log_price,
                               ROW_NUMBER() OVER (PARTITION BY token0, token1 ORDER BY hour) AS row_no
                        FROM hourly_price_data hpd,
                             times t
                        WHERE hpd.hour BETWEEN t.start_time AND t.end_time
                          AND hpd.k_volume <> 0),

             log_price_changes AS (SELECT token0,
                                          token1,
                                          log_price -
                                          LAG(log_price) OVER (PARTITION BY token0, token1 ORDER BY row_no)             AS price_change,
                                          EXTRACT(HOURS FROM hour - LAG(hour)
                                                                    OVER (PARTITION BY token0, token1 ORDER BY row_no)) AS hours_since_last
                                   FROM prices p
                                   WHERE p.row_no != 1),

             realized_volatility_by_pair AS (SELECT token0,
                                                    token1,
                                                    COUNT(1)                               AS observation_count,
                                                    SQRT(SUM(price_change * price_change)) AS realized_volatility
                                             FROM log_price_changes lpc
                                             GROUP BY token0, token1)

        SELECT token0,
               token1,
               realized_volatility,
               observation_count,
               int4(FLOOR(realized_volatility / LN(1.000001::NUMERIC))) AS volatility_in_ticks
        FROM realized_volatility_by_pair
        WHERE realized_volatility IS NOT NULL;

        CREATE MATERIALIZED VIEW IF NOT EXISTS token_pair_realized_volatility AS
        SELECT * FROM token_pair_realized_volatility_view;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_token_pair_realized_volatility_pair
            ON token_pair_realized_volatility (token0, token1);

        CREATE OR REPLACE VIEW pool_market_depth_view AS
        WITH depth_percentages AS (
          SELECT (POWER(1.21, generate_series(0, 40)) * 0.00005)::float AS depth_percent
        ),
        last_swap_per_pair AS (
          SELECT
            token0,
            token1,
            max(pool_balance_change_id) AS last_swap_event_id
        FROM
          swaps s
          JOIN pool_keys pk ON s.pool_key_id = pk.id
          WHERE
            liquidity_after != 0
          GROUP BY
            token0,
            token1
        ),
        last_swap_time_per_pair AS (
          SELECT
            token0,
            token1,
            b.time
          FROM
            last_swap_per_pair ls
            JOIN event_keys ek ON ls.last_swap_event_id = ek.sort_id
            JOIN blocks b ON ek.block_number = b.number
        ),
        median_ticks AS (
          SELECT
            pk.token0,
            pk.token1,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY tick_after) AS median_tick
          FROM
            swaps s
            JOIN pool_keys pk ON s.pool_key_id = pk.id
            JOIN event_keys ek ON s.pool_balance_change_id = ek.sort_id
            JOIN blocks b ON b.number = ek.block_number
            JOIN last_swap_time_per_pair lstpp ON pk.token0 = lstpp.token0
              AND pk.token1 = lstpp.token1
          WHERE
            b.time >= lstpp.time - interval '1 hour'
            AND liquidity_after != 0 GROUP BY
              pk.token0,
              pk.token1
        ),
        pool_states AS (
          SELECT
            pk.id,
            pk.token0,
            pk.token1,
            dp.depth_percent,
            floor(ln(1::numeric + dp.depth_percent) / ln(1.000001))::int4 AS depth_in_ticks,
            ceil(log(1::numeric + (pk.fee / 0x10000000000000000::numeric)) / log(1.000001))::int4 AS fee_in_ticks,
            round(mt.median_tick)::int4 AS last_tick
          FROM
            pool_keys pk
            CROSS JOIN depth_percentages dp
            LEFT JOIN median_ticks mt ON pk.token0 = mt.token0
              AND pk.token1 = mt.token1
        ),
        pool_ticks AS (
          SELECT
            pool_key_id,
            sum(net_liquidity_delta_diff) OVER (PARTITION BY ppptliv.pool_key_id ORDER BY ppptliv.tick ROWS UNBOUNDED PRECEDING) AS liquidity,
          tick AS tick_start,
          lead(tick) OVER (PARTITION BY ppptliv.pool_key_id ORDER BY ppptliv.tick) AS tick_end
        FROM
          per_pool_per_tick_liquidity_incremental_view ppptliv
        ),
        depth_liquidity_ranges AS (
          SELECT
            pt.pool_key_id,
            pt.liquidity,
            ps.depth_percent,
            int4range(ps.last_tick - ps.depth_in_ticks, ps.last_tick - ps.fee_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_below,
            int4range(ps.last_tick + ps.fee_in_ticks, ps.last_tick + ps.depth_in_ticks) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_above
        FROM
          pool_ticks pt
        JOIN pool_states ps ON pt.pool_key_id = ps.pool_key_id
        WHERE
          liquidity != 0
          AND ps.fee_in_ticks < ps.depth_in_ticks
        ),
        token_amounts_by_pool AS (
          SELECT
            pool_key_id,
            depth_percent,
            floor(sum(liquidity * (power(1.0000005::numeric, upper(overlap_range_below)) - power(1.0000005::numeric, lower(overlap_range_below))))) AS amount1,
          floor(sum(liquidity * ((1::numeric / power(1.0000005::numeric, lower(overlap_range_above))) - (1::numeric / power(1.0000005::numeric, upper(overlap_range_above)))))) AS amount0
        FROM
          depth_liquidity_ranges
          WHERE
            NOT isempty(overlap_range_below)
            OR NOT isempty(overlap_range_above)
            GROUP BY
              pool_key_id,
              depth_percent
        ),
        total_depth AS (
          SELECT
            pool_key_id,
            depth_percent,
            coalesce(sum(amount0), 0) AS depth0,
            coalesce(sum(amount1), 0) AS depth1
          FROM
            token_amounts_by_pool tabp GROUP BY
              pool_key_id,
              depth_percent
        )
          SELECT
            td.pool_key_id,
            td.depth_percent AS depth_percent,
            td.depth0,
            td.depth1
          FROM
            total_depth td;


        CREATE MATERIALIZED VIEW IF NOT EXISTS pool_market_depth AS
        SELECT * FROM pool_market_depth_view;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_market_depth
            ON pool_market_depth (pool_key_id, depth_percent);

    `);
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
                             JOIN pool_balance_change_event pbc ON swaps.pool_balance_change_id = pbc.event_id
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
                             JOIN pool_balance_change_event pbc ON fa.pool_balance_change_id = pbc.event_id
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
                             JOIN pool_balance_change_event pbc ON fa.pool_balance_change_id = pbc.event_id
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
                                            JOIN pool_balance_change_event pbc ON pu.pool_balance_change_id = pbc.event_id
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
                                            JOIN pool_balance_change_event pbc ON pu.pool_balance_change_id = pbc.event_id
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
                                                             JOIN pool_balance_change_event pbc ON s.pool_balance_change_id = pbc.event_id
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
                          -- Use the unified pool_balance_change_event table with fee adjustments for position updates
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
                              FROM pool_balance_change_event pbc
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
                INSERT INTO pool_keys (chain_id,
                                       pool_id,
                                       core_address,
                                       token0,
                                       token1,
                                       fee,
                                       tick_spacing,
                                       extension,
                                       config)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        BigInt(poolKey.config),
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
                    INSERT INTO pool_balance_change_event (event_id, pool_key_hash, delta0, delta1)
                    VALUES ((SELECT id FROM inserted_event),
                            (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $7),
                            $12, $13)
                    RETURNING event_id
                )
                INSERT INTO position_updates
                (chain_id,
                 pool_balance_change_id,
                 locker,
                 pool_key_id,
                 salt,
                 lower_bound,
                 upper_bound,
                 liquidity_delta)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_event_id FROM balance_change_insert),
                        $7,
                        (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                        $9, $10, $11, $14);
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
                        RETURNING chain_id, sort_id),
                balance_change_insert AS (
                    INSERT INTO pool_balance_change_event (event_id, pool_key_hash, delta0, delta1)
                    VALUES ((SELECT id FROM inserted_event),
                            (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $6),
                            -$11::numeric, -$12::numeric)
                    RETURNING event_id
                )
                INSERT INTO position_fees_collected
                (chain_id,
                 pool_balance_change_id,
                 pool_key_id,
                 owner,
                 salt,
                 lower_bound,
                 upper_bound)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_event_id FROM balance_change_insert),
                        (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $7),
                        $8, $9, $10, $13);
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
                INSERT
                INTO pool_initializations
                (chain_id,
                 event_id,
                 pool_key_id,
                 tick,
                 sqrt_ratio)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7, $8, $9)
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
                    INSERT INTO pool_balance_change_event (event_id, pool_key_id, delta0, delta1)
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
                        RETURNING chain_id, sort_id),
                balance_change_insert AS (
                    INSERT INTO pool_balance_change_event (event_id, pool_key_hash, delta0, delta1)
                    VALUES ((SELECT id FROM inserted_event),
                            (SELECT key_hash FROM pool_keys WHERE core_address = $5 AND pool_id = $7),
                            $8, $9)
                    RETURNING event_id
                )
                INSERT INTO swaps
                (chain_id,
                 pool_balance_change_id,
                 locker,
                 pool_key_id,
                 sqrt_ratio_after,
                 tick_after,
                 liquidity_after)
                VALUES ((SELECT chain_id FROM inserted_event), (SELECT sort_id FROM inserted_event), $7,
                        (SELECT pool_key_id FROM pool_keys WHERE chain_id = $1 AND core_address = $6 AND pool_id = $8),
                        $9, $10, $11, $12, $13);
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
