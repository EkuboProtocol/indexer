import { Client, PoolClient } from "pg";
import { EventKey, eventKeyToId, ParsedEventWithKey } from "./processor";
import {
  FeesAccumulatedEvent,
  PoolInitializationEvent,
  PoolKey,
  PositionFeesCollectedEvent,
  PositionUpdatedEvent,
  ProtocolFeesPaidEvent,
  ProtocolFeesWithdrawnEvent,
  SwappedEvent,
} from "./events/core";
import { TransferEvent } from "./events/nft";
import { computeKeyHash, populateCache } from "./pool_key_hash";
import { PositionMintedWithReferrer } from "./events/positions";
import {
  OrderKey,
  OrderProceedsWithdrawnEvent,
  OrderUpdatedEvent,
  VirtualOrdersExecutedEvent,
} from "./events/twamm";
import { StakedEvent, WithdrawnEvent } from "./events/staker";
import {
  DescribedEvent,
  GovernorCanceledEvent,
  GovernorCreationThresholdBreached,
  GovernorExecutedEvent,
  GovernorProposedEvent,
  GovernorReconfiguredEvent,
  GovernorVotedEvent,
} from "./events/governor";
import { TokenRegistrationEvent } from "./events/tokenRegistry";
import { Cursor } from "@apibara/protocol";

const MAX_TICK_SPACING = 354892;

function orderKeyToPoolKey(event_key: EventKey, order_key: OrderKey): PoolKey {
  const [token0, token1]: [bigint, bigint] =
    order_key.buy_token > order_key.sell_token
      ? [order_key.sell_token, order_key.buy_token]
      : [order_key.buy_token, order_key.sell_token];

  return {
    token0,
    token1,
    fee: order_key.fee,
    tick_spacing: BigInt(MAX_TICK_SPACING),
    extension: event_key.fromAddress,
  };
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
    await this.createSchema();
    const cursor = await this.loadCursor();
    // we need to clear anything that was potentially inserted as pending before starting
    if (cursor) {
      await this.deleteOldBlockNumbers(Number(cursor.orderKey) + 1);
    }
    await this.populatePoolKeyCache();
    await this.commitTransaction();
    return cursor;
  }

  private async populatePoolKeyCache() {
    const { rows } = await this.pg.query<{
      key_hash: string;
      token0: string;
      token1: string;
      fee: string;
      tick_spacing: number;
      extension: number;
    }>(`
            SELECT key_hash, token0, token1, fee, tick_spacing, extension
            FROM pool_keys
        `);
    populateCache(
      rows.map(({ token0, token1, key_hash, fee, extension, tick_spacing }) => {
        return {
          pool_key: {
            token0: BigInt(token0),
            token1: BigInt(token1),
            fee: BigInt(fee),
            tick_spacing: BigInt(tick_spacing),
            extension: BigInt(extension),
          },
          hash: BigInt(key_hash),
        };
      })
    );
  }

  private async createSchema(): Promise<void> {
    await this.pg.query(`
        CREATE TABLE IF NOT EXISTS cursor
        (
            id           INT         NOT NULL UNIQUE CHECK (id = 1), -- only one row.
            order_key    NUMERIC     NOT NULL,
            unique_key   TEXT        NOT NULL,
            last_updated timestamptz NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks
        (
            -- int4 blocks represents over a thousand years at 12 second blocks
            number   int4        NOT NULL PRIMARY KEY,
            hash     NUMERIC     NOT NULL,
            time     timestamptz NOT NULL,
            inserted timestamptz NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_time ON blocks USING btree (time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_hash ON blocks USING btree (hash);

        CREATE TABLE IF NOT EXISTS pool_keys
        (
            key_hash     NUMERIC NOT NULL PRIMARY KEY,
            token0       NUMERIC NOT NULL,
            token1       NUMERIC NOT NULL,
            fee          NUMERIC NOT NULL,
            tick_spacing INT     NOT NULL,
            extension    NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token0 ON pool_keys USING btree (token0);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token1 ON pool_keys USING btree (token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_token0_token1 ON pool_keys USING btree (token0, token1);
        CREATE INDEX IF NOT EXISTS idx_pool_keys_extension ON pool_keys USING btree (extension);

        -- all events reference an event id which contains the metadata of the event
        CREATE TABLE IF NOT EXISTS event_keys
        (
            id                int8 GENERATED ALWAYS AS (block_number * 4294967296 + transaction_index * 65536 + event_index) STORED PRIMARY KEY,
            transaction_hash  NUMERIC NOT NULL,
            block_number      int4    NOT NULL REFERENCES blocks (number) ON DELETE CASCADE,
            transaction_index int2    NOT NULL,
            event_index       int2    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_keys_block_number_transaction_index_event_index ON event_keys USING btree (block_number, transaction_index, event_index);
        CREATE INDEX IF NOT EXISTS idx_event_keys_transaction_hash ON event_keys USING btree (transaction_hash);

        CREATE TABLE IF NOT EXISTS transactions
        (
            transaction_hash NUMERIC NOT NULL PRIMARY KEY,
            sender           NUMERIC NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transaction_receipts
        (
            transaction_hash NUMERIC  NOT NULL PRIMARY KEY,
            fee_paid         NUMERIC  NOT NULL,
            fee_paid_unit    SMALLINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS position_transfers
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            token_id     int8    NOT NULL,
            from_address NUMERIC NOT NULL,
            to_address   NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_transfers_token_id_from_to ON position_transfers (token_id, from_address, to_address);

        CREATE TABLE IF NOT EXISTS position_updates
        (
            event_id        int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            locker          NUMERIC NOT NULL,

            pool_key_hash   NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            salt            NUMERIC NOT NULL,
            lower_bound     int4    NOT NULL,
            upper_bound     int4    NOT NULL,

            liquidity_delta NUMERIC NOT NULL,
            delta0          NUMERIC NOT NULL,
            delta1          NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_updates_pool_key_hash_event_id ON position_updates USING btree (pool_key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_position_updates_locker_salt ON position_updates USING btree (locker, salt);
        CREATE INDEX IF NOT EXISTS idx_position_updates_salt ON position_updates USING btree (salt);

        CREATE TABLE IF NOT EXISTS position_fees_collected
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            owner         NUMERIC NOT NULL,
            salt          NUMERIC NOT NULL,
            lower_bound   int4    NOT NULL,
            upper_bound   int4    NOT NULL,

            delta0        NUMERIC NOT NULL,
            delta1        NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_pool_key_hash ON position_fees_collected (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_position_fees_collected_salt ON position_fees_collected USING btree (salt);


        CREATE TABLE IF NOT EXISTS protocol_fees_withdrawn
        (
            event_id  int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            recipient NUMERIC NOT NULL,
            token     NUMERIC NOT NULL,
            amount    NUMERIC NOT NULL
        );


        CREATE TABLE IF NOT EXISTS protocol_fees_paid
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            owner         NUMERIC NOT NULL,
            salt          NUMERIC NOT NULL,
            lower_bound   int4    NOT NULL,
            upper_bound   int4    NOT NULL,

            delta0        NUMERIC NOT NULL,
            delta1        NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_protocol_fees_paid_pool_key_hash ON protocol_fees_paid (pool_key_hash);
        CREATE INDEX IF NOT EXISTS idx_protocol_fees_paid_salt ON protocol_fees_paid USING btree (salt);

        CREATE TABLE IF NOT EXISTS fees_accumulated
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            amount0       NUMERIC NOT NULL,
            amount1       NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fees_accumulated_pool_key_hash ON fees_accumulated (pool_key_hash);

        CREATE TABLE IF NOT EXISTS pool_initializations
        (
            event_id      int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            pool_key_hash NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            tick          int4    NOT NULL,
            sqrt_ratio    NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pool_initializations_pool_key_hash ON pool_initializations (pool_key_hash);


        CREATE TABLE IF NOT EXISTS swaps
        (
            event_id         int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            locker           NUMERIC NOT NULL,
            pool_key_hash    NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            delta0           NUMERIC NOT NULL,
            delta1           NUMERIC NOT NULL,

            sqrt_ratio_after NUMERIC NOT NULL,
            tick_after       int4    NOT NULL,
            liquidity_after  NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_swaps_pool_key_hash_event_id ON swaps USING btree (pool_key_hash, event_id);

        CREATE TABLE IF NOT EXISTS position_minted_with_referrer
        (
            event_id int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            token_id int8    NOT NULL,
            referrer NUMERIC NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_position_minted_with_referrer_token_id ON position_minted_with_referrer USING btree (token_id);

        CREATE TABLE IF NOT EXISTS token_registrations
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            address      NUMERIC NOT NULL,

            name         NUMERIC NOT NULL,
            symbol       NUMERIC NOT NULL,
            decimals     INT     NOT NULL,
            total_supply NUMERIC NOT NULL
        );

        CREATE TABLE IF NOT EXISTS staker_staked
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            from_address NUMERIC NOT NULL,
            amount       NUMERIC NOT NULL,
            delegate     NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_staker_staked_delegate_from_address ON staker_staked USING btree (delegate, from_address);
        CREATE INDEX IF NOT EXISTS idx_staker_staked_from_address_delegate ON staker_staked USING btree (from_address, delegate);

        CREATE TABLE IF NOT EXISTS staker_withdrawn
        (
            event_id     int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            from_address NUMERIC NOT NULL,
            amount       NUMERIC NOT NULL,
            recipient    NUMERIC NOT NULL,
            delegate     NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_staker_withdrawn_delegate_from_address ON staker_staked USING btree (delegate, from_address);
        CREATE INDEX IF NOT EXISTS idx_staker_withdrawn_from_address_delegate ON staker_staked USING btree (from_address, delegate);

        CREATE TABLE IF NOT EXISTS governor_reconfigured
        (
            event_id                         int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            version                          BIGINT  NOT NULL,

            voting_start_delay               BIGINT  NOT NULL,
            voting_period                    BIGINT  NOT NULL,
            voting_weight_smoothing_duration BIGINT  NOT NULL,
            quorum                           NUMERIC NOT NULL,
            proposal_creation_threshold      NUMERIC NOT NULL,
            execution_delay                  BIGINT  NOT NULL,
            execution_window                 BIGINT  NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_governor_reconfigured_version ON governor_reconfigured USING btree (version);

        CREATE TABLE IF NOT EXISTS governor_proposed
        (
            event_id       int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            id             NUMERIC NOT NULL,
            proposer       NUMERIC NOT NULL,
            config_version BIGINT REFERENCES governor_reconfigured (version) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_governor_proposed_id ON governor_proposed USING btree (id);

        CREATE TABLE IF NOT EXISTS governor_proposed_calls
        (
            proposal_id NUMERIC   NOT NULL REFERENCES governor_proposed (id) ON DELETE CASCADE,
            index       int2      NOT NULL,
            to_address  NUMERIC   NOT NULL,
            selector    NUMERIC   NOT NULL,
            calldata    NUMERIC[] NOT NULL,
            PRIMARY KEY (proposal_id, index)
        );

        CREATE TABLE IF NOT EXISTS governor_canceled
        (
            event_id int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            id       NUMERIC NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_governor_canceled_id ON governor_canceled USING btree (id);

        CREATE TABLE IF NOT EXISTS governor_voted
        (
            event_id int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            id       NUMERIC NOT NULL,
            voter    NUMERIC NOT NULL,
            weight   NUMERIC NOT NULL,
            yea      BOOLEAN NOT NULL
        );

        CREATE TABLE IF NOT EXISTS governor_executed
        (
            event_id int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            id       NUMERIC NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_governor_executed_id ON governor_executed USING btree (id);

        CREATE TABLE IF NOT EXISTS governor_executed_results
        (
            proposal_id NUMERIC   NOT NULL REFERENCES governor_executed (id) ON DELETE CASCADE,
            index       int2      NOT NULL,
            results     NUMERIC[] NOT NULL,
            PRIMARY KEY (proposal_id, index)
        );

        CREATE TABLE IF NOT EXISTS governor_proposal_described
        (
            event_id    int8 REFERENCES event_keys (id) ON DELETE CASCADE PRIMARY KEY,

            id          NUMERIC NOT NULL,
            description TEXT    NOT NULL
        );

        CREATE OR REPLACE VIEW pool_states_view AS
        (
        WITH lss AS (SELECT key_hash,
                            COALESCE(last_swap.event_id, pi.event_id)           AS last_swap_event_id,
                            COALESCE(last_swap.sqrt_ratio_after, pi.sqrt_ratio) AS sqrt_ratio,
                            COALESCE(last_swap.tick_after, pi.tick)             AS tick,
                            COALESCE(last_swap.liquidity_after, 0)              AS liquidity_last
                     FROM pool_keys
                              LEFT JOIN LATERAL (
                         SELECT event_id, sqrt_ratio_after, tick_after, liquidity_after
                         FROM swaps
                         WHERE pool_keys.key_hash = swaps.pool_key_hash
                         ORDER BY event_id DESC
                         LIMIT 1
                         ) AS last_swap ON TRUE
                              LEFT JOIN LATERAL (
                         SELECT event_id, sqrt_ratio, tick
                         FROM pool_initializations
                         WHERE pool_initializations.pool_key_hash = pool_keys.key_hash
                         ORDER BY event_id DESC
                         LIMIT 1
                         ) AS pi ON TRUE),
             pl AS (SELECT key_hash,
                           (SELECT event_id
                            FROM position_updates
                            WHERE key_hash = position_updates.pool_key_hash
                            ORDER BY event_id DESC
                            LIMIT 1)                                   AS last_update_event_id,
                           (COALESCE(liquidity_last, 0) + COALESCE((SELECT SUM(liquidity_delta)
                                                                    FROM position_updates AS pu
                                                                    WHERE lss.last_swap_event_id < pu.event_id
                                                                      AND pu.pool_key_hash = lss.key_hash
                                                                      AND lss.tick BETWEEN pu.lower_bound AND (pu.upper_bound - 1)),
                                                                   0)) AS liquidity
                    FROM lss)
        SELECT lss.key_hash                                              AS pool_key_hash,
               sqrt_ratio,
               tick,
               liquidity,
               GREATEST(lss.last_swap_event_id, pl.last_update_event_id) AS last_event_id,
               pl.last_update_event_id                                   AS last_liquidity_update_event_id
        FROM lss
                 JOIN pl ON lss.key_hash = pl.key_hash
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS pool_states_materialized AS
        (
        SELECT pool_key_hash, last_event_id, last_liquidity_update_event_id, sqrt_ratio, liquidity, tick
        FROM pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_states_materialized_pool_key_hash ON pool_states_materialized USING btree (pool_key_hash);

        CREATE TABLE IF NOT EXISTS hourly_volume_by_token
        (
            key_hash   NUMERIC,
            hour       timestamptz,
            token      NUMERIC,
            volume     NUMERIC,
            fees       NUMERIC,
            swap_count NUMERIC,
            PRIMARY KEY (key_hash, hour, token)
        );

        CREATE TABLE IF NOT EXISTS hourly_tvl_delta_by_token
        (
            key_hash NUMERIC,
            hour     timestamptz,
            token    NUMERIC,
            delta    NUMERIC,
            PRIMARY KEY (key_hash, hour, token)
        );

        CREATE OR REPLACE VIEW per_pool_per_tick_liquidity_view AS
        (
        WITH all_tick_deltas AS (SELECT pool_key_hash,
                                        lower_bound AS       tick,
                                        SUM(liquidity_delta) net_liquidity_delta
                                 FROM position_updates
                                 GROUP BY pool_key_hash, lower_bound
                                 UNION ALL
                                 SELECT pool_key_hash,
                                        upper_bound AS        tick,
                                        SUM(-liquidity_delta) net_liquidity_delta
                                 FROM position_updates
                                 GROUP BY pool_key_hash, upper_bound),
             summed AS (SELECT pool_key_hash,
                               tick,
                               SUM(net_liquidity_delta) AS net_liquidity_delta_diff
                        FROM all_tick_deltas
                        GROUP BY pool_key_hash, tick)
        SELECT pool_key_hash, tick, net_liquidity_delta_diff
        FROM summed
        WHERE net_liquidity_delta_diff != 0
        ORDER BY tick);

        CREATE MATERIALIZED VIEW IF NOT EXISTS per_pool_per_tick_liquidity_materialized AS
        (
        SELECT pool_key_hash, tick, net_liquidity_delta_diff
        FROM per_pool_per_tick_liquidity_view);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_per_pool_per_tick_liquidity_pool_key_hash_tick ON per_pool_per_tick_liquidity_materialized USING btree (pool_key_hash, tick);

        CREATE TABLE IF NOT EXISTS twamm_order_updates
        (
            event_id         int8        NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash         NUMERIC     NOT NULL REFERENCES pool_keys (key_hash),

            owner            NUMERIC     NOT NULL,
            salt             NUMERIC     NOT NULL,
            sale_rate_delta0 NUMERIC     NOT NULL,
            sale_rate_delta1 NUMERIC     NOT NULL,
            start_time       timestamptz NOT NULL,
            end_time         timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_key_hash_event_id ON twamm_order_updates USING btree (key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_key_hash_time ON twamm_order_updates USING btree (key_hash, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_owner_salt ON twamm_order_updates USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_salt ON twamm_order_updates USING btree (salt);

        CREATE TABLE IF NOT EXISTS twamm_proceeds_withdrawals
        (
            event_id   int8        NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash   NUMERIC     NOT NULL REFERENCES pool_keys (key_hash),

            owner      NUMERIC     NOT NULL,
            salt       NUMERIC     NOT NULL,
            amount0    NUMERIC     NOT NULL,
            amount1    NUMERIC     NOT NULL,
            start_time timestamptz NOT NULL,
            end_time   timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_key_hash_event_id ON twamm_proceeds_withdrawals USING btree (key_hash, event_id);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_key_hash_time ON twamm_proceeds_withdrawals USING btree (key_hash, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_owner_salt ON twamm_proceeds_withdrawals USING btree (owner, salt);
        CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_salt ON twamm_proceeds_withdrawals USING btree (salt);

        CREATE TABLE IF NOT EXISTS twamm_virtual_order_executions
        (
            event_id         int8    NOT NULL PRIMARY KEY REFERENCES event_keys (id) ON DELETE CASCADE,

            key_hash         NUMERIC NOT NULL REFERENCES pool_keys (key_hash),

            token0_sale_rate NUMERIC NOT NULL,
            token1_sale_rate NUMERIC NOT NULL,
            delta0           NUMERIC NOT NULL,
            delta1           NUMERIC NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_twamm_virtual_order_executions_pool_key_hash_event_id ON twamm_virtual_order_executions USING btree (key_hash, event_id DESC);

        CREATE OR REPLACE VIEW twamm_pool_states_view AS
        (
        WITH last_virtual_order_execution AS (SELECT pk.key_hash,
                                                     last_voe.token0_sale_rate,
                                                     last_voe.token1_sale_rate,
                                                     last_voe.event_id AS last_virtual_order_execution_event_id,
                                                     last_voe.last_virtual_execution_time
                                              FROM pool_keys pk
                                                       JOIN LATERAL (SELECT tvoe.event_id,
                                                                            tvoe.token0_sale_rate,
                                                                            tvoe.token1_sale_rate,
                                                                            b."time" AS last_virtual_execution_time
                                                                     FROM twamm_virtual_order_executions tvoe
                                                                              JOIN event_keys ek ON tvoe.event_id = ek.id
                                                                              JOIN blocks b ON ek.block_number = b.number
                                                                     WHERE pk.key_hash = tvoe.key_hash
                                                                     ORDER BY tvoe.event_id DESC
                                                                     LIMIT 1) last_voe ON TRUE
                                              WHERE pk.extension != 0),
             active_order_updates_after_lvoe AS (SELECT lvoe_1.key_hash,
                                                        SUM(tou.sale_rate_delta0) AS sale_rate_delta0,
                                                        SUM(tou.sale_rate_delta1) AS sale_rate_delta1,
                                                        MAX(tou.event_id)         AS last_order_update_event_id
                                                 FROM last_virtual_order_execution lvoe_1
                                                          JOIN twamm_order_updates tou
                                                               ON tou.key_hash = lvoe_1.key_hash AND
                                                                  tou.event_id >
                                                                  lvoe_1.last_virtual_order_execution_event_id AND
                                                                  tou.start_time <=
                                                                  lvoe_1.last_virtual_execution_time AND
                                                                  tou.end_time >
                                                                  lvoe_1.last_virtual_execution_time
                                                 GROUP BY lvoe_1.key_hash)
        SELECT lvoe.key_hash                                                          AS pool_key_hash,
               lvoe.token0_sale_rate + COALESCE(ou_lvoe.sale_rate_delta0, 0::NUMERIC) AS token0_sale_rate,
               lvoe.token1_sale_rate + COALESCE(ou_lvoe.sale_rate_delta1, 0::NUMERIC) AS token1_sale_rate,
               lvoe.last_virtual_execution_time,
               GREATEST(COALESCE(ou_lvoe.last_order_update_event_id, lvoe.last_virtual_order_execution_event_id),
                        psm.last_event_id)                                            AS last_event_id
        FROM last_virtual_order_execution lvoe
                 JOIN pool_states_materialized psm ON lvoe.key_hash = psm.pool_key_hash
                 LEFT JOIN active_order_updates_after_lvoe ou_lvoe ON lvoe.key_hash = ou_lvoe.key_hash
            );

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_pool_states_materialized AS
        (
        SELECT pool_key_hash,
               token0_sale_rate,
               token1_sale_rate,
               last_virtual_execution_time,
               last_event_id
        FROM twamm_pool_states_view);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_pool_states_materialized_key_hash ON twamm_pool_states_materialized USING btree (pool_key_hash);

        CREATE OR REPLACE VIEW twamm_sale_rate_deltas_view AS
        (
        WITH all_order_deltas AS (SELECT key_hash,
                                         start_time AS         time,
                                         SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY key_hash, start_time
                                  UNION ALL
                                  SELECT key_hash,
                                         end_time AS            time,
                                         -SUM(sale_rate_delta0) net_sale_rate_delta0,
                                         -SUM(sale_rate_delta1) net_sale_rate_delta1
                                  FROM twamm_order_updates
                                  GROUP BY key_hash, end_time),
             summed AS (SELECT key_hash,
                               time,
                               SUM(net_sale_rate_delta0) AS net_sale_rate_delta0,
                               SUM(net_sale_rate_delta1) AS net_sale_rate_delta1
                        FROM all_order_deltas
                        GROUP BY key_hash, time)
        SELECT key_hash AS pool_key_hash, time, net_sale_rate_delta0, net_sale_rate_delta1
        FROM summed
        WHERE net_sale_rate_delta0 != 0
           OR net_sale_rate_delta1 != 0
        ORDER BY key_hash, time);

        CREATE MATERIALIZED VIEW IF NOT EXISTS twamm_sale_rate_deltas_materialized AS
        (
        SELECT tsrdv.pool_key_hash, tsrdv.time, tsrdv.net_sale_rate_delta0, tsrdv.net_sale_rate_delta1
        FROM twamm_sale_rate_deltas_view AS tsrdv
                 JOIN twamm_pool_states_materialized tpsm
                      ON tpsm.pool_key_hash = tsrdv.pool_key_hash AND
                         tpsm.last_virtual_execution_time < tsrdv.time);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_twamm_sale_rate_deltas_materialized_pool_key_hash_time ON twamm_sale_rate_deltas_materialized USING btree (pool_key_hash, time);
    `);
  }

  public async refreshAnalyticalTables({ since }: { since: Date }) {
    await Promise.all([
      this.pg.query({
        text: `
            INSERT INTO hourly_volume_by_token
                (SELECT swaps.pool_key_hash                                                      AS   key_hash,
                        DATE_TRUNC('hour', blocks.time)                                          AS   hour,
                        (CASE WHEN swaps.delta0 >= 0 THEN pool_keys.token0 ELSE pool_keys.token1 END) token,
                        SUM(CASE WHEN swaps.delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) AS   volume,
                        SUM(FLOOR(((CASE WHEN delta0 >= 0 THEN swaps.delta0 ELSE swaps.delta1 END) *
                                   pool_keys.fee) /
                                  340282366920938463463374607431768211456))                      AS   fees,
                        COUNT(1)                                                                 AS   swap_count
                 FROM swaps
                          JOIN pool_keys ON swaps.pool_key_hash = pool_keys.key_hash
                          JOIN event_keys ON swaps.event_id = event_keys.id
                          JOIN blocks ON event_keys.block_number = blocks.number
                 WHERE DATE_TRUNC('hour', blocks.time) >= DATE_TRUNC('hour', $1::timestamptz)
                 GROUP BY hour, swaps.pool_key_hash, token)
            ON CONFLICT (key_hash, hour, token)
                DO UPDATE SET volume     = excluded.volume,
                              fees       = excluded.fees,
                              swap_count = excluded.swap_count;
        `,
        values: [since],
      }),

      this.pg.query({
        text: `
            INSERT INTO hourly_tvl_delta_by_token
                (WITH first_event_id AS (SELECT id
                                         FROM event_keys AS ek
                                                  JOIN blocks AS b ON ek.block_number = b.number
                                         WHERE b.time >= DATE_TRUNC('hour', $1::timestamptz)
                                         LIMIT 1),
                      grouped_pool_key_hash_deltas AS (SELECT pool_key_hash,
                                                              DATE_TRUNC('hour', blocks.time) AS hour,
                                                              SUM(delta0)                     AS delta0,
                                                              SUM(delta1)                     AS delta1
                                                       FROM swaps
                                                                JOIN event_keys ON swaps.event_id = event_keys.id
                                                                JOIN blocks ON event_keys.block_number = blocks.number
                                                       WHERE event_id >= (SELECT id FROM first_event_id)
                                                       GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                       UNION ALL

                                                       SELECT pool_key_hash,
                                                              DATE_TRUNC('hour', blocks.time) AS hour,
                                                              SUM(delta0)                     AS delta0,
                                                              SUM(delta1)                     AS delta1
                                                       FROM position_updates
                                                                JOIN event_keys ON position_updates.event_id = event_keys.id
                                                                JOIN blocks ON event_keys.block_number = blocks.number
                                                       WHERE event_id >= (SELECT id FROM first_event_id)
                                                       GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                       UNION ALL

                                                       SELECT pool_key_hash,
                                                              DATE_TRUNC('hour', blocks.time) AS hour,
                                                              SUM(delta0)                     AS delta0,
                                                              SUM(delta1)                     AS delta1
                                                       FROM position_fees_collected
                                                                JOIN event_keys ON position_fees_collected.event_id = event_keys.id
                                                                JOIN blocks ON event_keys.block_number = blocks.number
                                                       WHERE event_id >= (SELECT id FROM first_event_id)
                                                       GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                       UNION ALL

                                                       SELECT pool_key_hash,
                                                              DATE_TRUNC('hour', blocks.time) AS hour,
                                                              SUM(delta0)                     AS delta0,
                                                              SUM(delta1)                     AS delta1
                                                       FROM protocol_fees_paid
                                                                JOIN event_keys ON protocol_fees_paid.event_id = event_keys.id
                                                                JOIN blocks ON event_keys.block_number = blocks.number
                                                       WHERE event_id >= (SELECT id FROM first_event_id)
                                                       GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)

                                                       UNION ALL

                                                       SELECT pool_key_hash,
                                                              DATE_TRUNC('hour', blocks.time) AS hour,
                                                              SUM(amount0)                    AS delta0,
                                                              SUM(amount1)                    AS delta1
                                                       FROM fees_accumulated
                                                                JOIN event_keys ON fees_accumulated.event_id = event_keys.id
                                                                JOIN blocks ON event_keys.block_number = blocks.number
                                                       WHERE event_id >= (SELECT id FROM first_event_id)
                                                       GROUP BY pool_key_hash, DATE_TRUNC('hour', blocks.time)),
                      token_deltas AS (SELECT pool_key_hash,
                                              grouped_pool_key_hash_deltas.hour,
                                              pool_keys.token0 AS token,
                                              SUM(delta0)      AS delta
                                       FROM grouped_pool_key_hash_deltas
                                                JOIN pool_keys
                                                     ON pool_keys.key_hash = grouped_pool_key_hash_deltas.pool_key_hash
                                       GROUP BY pool_key_hash, grouped_pool_key_hash_deltas.hour,
                                                pool_keys.token0

                                       UNION ALL

                                       SELECT pool_key_hash,
                                              grouped_pool_key_hash_deltas.hour,
                                              pool_keys.token1 AS token,
                                              SUM(delta1)      AS delta
                                       FROM grouped_pool_key_hash_deltas
                                                JOIN pool_keys
                                                     ON pool_keys.key_hash = grouped_pool_key_hash_deltas.pool_key_hash
                                       GROUP BY pool_key_hash, grouped_pool_key_hash_deltas.hour,
                                                pool_keys.token1)
                 SELECT pool_key_hash AS key_hash,
                        token_deltas.hour,
                        token_deltas.token,
                        SUM(delta)    AS delta
                 FROM token_deltas
                 GROUP BY token_deltas.pool_key_hash, token_deltas.hour, token_deltas.token)
            ON CONFLICT (key_hash, hour, token)
                DO UPDATE SET delta = excluded.delta;
        `,
        values: [since],
      }),
    ]);
  }

  public async refreshOperationalMaterializedView() {
    await this.pg.query(`
      REFRESH MATERIALIZED VIEW CONCURRENTLY per_pool_per_tick_liquidity_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_pool_states_materialized;
      REFRESH MATERIALIZED VIEW CONCURRENTLY twamm_sale_rate_deltas_materialized;
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
                   WHERE id = 1;`,
    });
    if (rows.length === 1) {
      const { order_key, unique_key } = rows[0];

      if (BigInt(unique_key) === 0n) {
        return {
          orderKey: BigInt(order_key),
        };
      } else {
        return {
          orderKey: BigInt(order_key),
          uniqueKey: unique_key,
        };
      }
    } else {
      return null;
    }
  }

  public async writeCursor(cursor: { orderKey: bigint; uniqueKey?: string }) {
    await this.pg.query({
      text: `
                INSERT INTO cursor (id, order_key, unique_key, last_updated)
                VALUES (1, $1, $2, NOW())
                ON CONFLICT (id) DO UPDATE SET order_key    = $1,
                                               unique_key   = $2,
                                               last_updated = NOW();
            `,
      values: [cursor.orderKey, BigInt(cursor.uniqueKey ?? 0)],
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
      text: `INSERT INTO blocks (number, hash, time)
                   VALUES ($1, $2, $3);`,
      values: [number, hash, time],
    });
  }

  private async batchInsertFakeEventKeys(keys: EventKey[]) {
    await this.pg.query({
      text: `
                INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                SELECT *
                FROM UNNEST($1::INT[], $2::SMALLINT[], $3::SMALLINT[], $4::NUMERIC[])
            `,
      values: [
        keys.map((k) => k.blockNumber),
        keys.map((k) => k.transactionIndex),
        keys.map((k) => k.eventIndex),
        Array(keys.length).fill(0),
      ],
    });
  }

  public async batchInsertFakeFeeEvents(
    tableName: "position_fees_collected" | "protocol_fees_paid",
    owner: BigInt,
    events:
      | ParsedEventWithKey<PositionFeesCollectedEvent>[]
      | ParsedEventWithKey<ProtocolFeesPaidEvent>[]
  ) {
    await this.batchInsertFakeEventKeys(events.map((e) => e.key));
    await this.pg.query({
      text: `
                INSERT INTO ${tableName} (event_id, pool_key_hash, owner, salt, lower_bound, upper_bound, delta0,
                                          delta1)
                SELECT *
                FROM UNNEST($1::BIGINT[], $2::NUMERIC[], $3::NUMERIC[], $4::NUMERIC[], $5::INT[], $6::INT[],
                            $7::NUMERIC[], $8::NUMERIC[])
            `,
      values: [
        events.map((e) => eventKeyToId(e.key)),
        events.map((e) => computeKeyHash(e.parsed.pool_key)),
        events.map(() => owner),
        events.map((e) => e.parsed.position_key.salt),
        events.map((e) => e.parsed.position_key.bounds.lower),
        events.map((e) => e.parsed.position_key.bounds.upper),
        events.map((e) => e.parsed.delta.amount0),
        events.map((e) => e.parsed.delta.amount1),
      ],
    });
  }

  private async insertPoolKeyHash(pool_key: PoolKey) {
    const key_hash = computeKeyHash(pool_key);

    await this.pg.query({
      text: `
                INSERT INTO pool_keys (key_hash,
                                       token0,
                                       token1,
                                       fee,
                                       tick_spacing,
                                       extension)
                VALUES ($1, $2, $3, $4, $5, $6)
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

  public async insertPositionTransferEvent(
    transfer: TransferEvent,
    key: EventKey
  ) {
    // The `*` operator is the PostgreSQL range intersection operator.
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO position_transfers
                (event_id,
                 token_id,
                 from_address,
                 to_address)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7)
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

  public async insertPositionMintedWithReferrerEvent(
    minted: PositionMintedWithReferrer,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO position_minted_with_referrer
                (event_id,
                 token_id,
                 referrer)
                VALUES ((SELECT id FROM inserted_event), $5, $6)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        minted.id,
        minted.referrer,
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
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO position_updates
                (event_id,
                 locker,
                 pool_key_hash,
                 salt,
                 lower_bound,
                 upper_bound,
                 liquidity_delta,
                 delta0,
                 delta1)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11, $12);
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
      name: "insert-position-fees-collected",
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO position_fees_collected
                (event_id,
                 pool_key_hash,
                 owner,
                 salt,
                 lower_bound,
                 upper_bound,
                 delta0,
                 delta1)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11);
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
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO pool_initializations
                (event_id,
                 pool_key_hash,
                 tick,
                 sqrt_ratio)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        pool_key_hash,

        event.tick,
        event.sqrt_ratio,
      ],
    });
  }

  public async insertProtocolFeesWithdrawn(
    event: ProtocolFeesWithdrawnEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO protocol_fees_withdrawn
                (event_id,
                 recipient,
                 token,
                 amount)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7);
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

  public async insertProtocolFeesPaid(
    event: ProtocolFeesPaidEvent,
    key: EventKey
  ) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      name: "insert-protocol-fees-paid",
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO protocol_fees_paid
                (event_id,
                 pool_key_hash,
                 owner,
                 salt,
                 lower_bound,
                 upper_bound,
                 delta0,
                 delta1)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11);
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
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO fees_accumulated
                (event_id,
                 pool_key_hash,
                 amount0,
                 amount1)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7);
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

  public async insertRegistration(
    event: TokenRegistrationEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO token_registrations
                (event_id,
                 address,
                 decimals,
                 name,
                 symbol,
                 total_supply)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        event.address,
        event.decimals,
        event.name,
        event.symbol,
        event.total_supply,
      ],
    });
  }

  public async insertSwappedEvent(event: SwappedEvent, key: EventKey) {
    const pool_key_hash = await this.insertPoolKeyHash(event.pool_key);

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO swaps
                (event_id,
                 locker,
                 pool_key_hash,
                 delta0,
                 delta1,
                 sqrt_ratio_after,
                 tick_after,
                 liquidity_after)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11);
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

  /**
   * Deletes all the blocks equal to or greater than the given block number, cascades to all the other tables.
   * @param invalidatedBlockNumber the block number for which data in the database should be removed
   */
  public async deleteOldBlockNumbers(invalidatedBlockNumber: number) {
    const { rowCount } = await this.pg.query({
      text: `
                DELETE
                FROM blocks
                WHERE number >= $1;
            `,
      values: [invalidatedBlockNumber],
    });
    return rowCount;
  }

  public async writeTransactionSenders(
    transactionSenders: [transactionHash: string, sender: string][]
  ) {
    if (transactionSenders.length > 0) {
      await this.pg.query({
        text: `INSERT INTO transactions (transaction_hash, sender)
                       SELECT *
                       FROM UNNEST($1::NUMERIC[], $2::NUMERIC[])
                       ON CONFLICT DO NOTHING`,
        values: [
          transactionSenders.map(([hash]) => BigInt(hash)),
          transactionSenders.map(([, sender]) => BigInt(sender)),
        ],
      });
    }
  }

  public async writeReceipts(
    receipts: [
      hash: string,
      receiptData: { feePaid: bigint; feePaidUnit: 0 | 1 | 2 }
    ][]
  ) {
    await this.pg.query({
      text: `
                INSERT INTO transaction_receipts (transaction_hash, fee_paid, fee_paid_unit)
                SELECT *
                FROM UNNEST($1::NUMERIC[], $2::NUMERIC[], $3::SMALLINT[])
                ON CONFLICT (transaction_hash) DO UPDATE
                    SET fee_paid      = excluded.fee_paid,
                        fee_paid_unit = excluded.fee_paid_unit;
            `,
      values: [
        receipts.map(([hash]) => hash),
        receipts.map(([, { feePaid }]) => feePaid),
        receipts.map(([, { feePaidUnit }]) => feePaidUnit),
      ],
    });
  }

  public async insertTWAMMOrderUpdatedEvent(
    order_updated: OrderUpdatedEvent,
    key: EventKey
  ) {
    const { order_key } = order_updated;

    const key_hash = await this.insertPoolKeyHash(
      orderKeyToPoolKey(key, order_key)
    );

    const [sale_rate_delta0, sale_rate_delta1] =
      order_key.sell_token > order_key.buy_token
        ? [0, order_updated.sale_rate_delta]
        : [order_updated.sale_rate_delta, 0];

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO twamm_order_updates
                (event_id,
                 key_hash,
                 owner,
                 salt,
                 sale_rate_delta0,
                 sale_rate_delta1,
                 start_time,
                 end_time)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        key_hash,

        BigInt(order_updated.owner),
        order_updated.salt,
        sale_rate_delta0,
        sale_rate_delta1,
        new Date(Number(order_key.start_time * 1000n)),
        new Date(Number(order_key.end_time * 1000n)),
      ],
    });
  }

  public async insertTWAMMOrderProceedsWithdrawnEvent(
    order_proceeds_withdrawn: OrderProceedsWithdrawnEvent,
    key: EventKey
  ) {
    const { order_key } = order_proceeds_withdrawn;

    const key_hash = await this.insertPoolKeyHash(
      orderKeyToPoolKey(key, order_key)
    );

    const [amount0, amount1] =
      order_key.sell_token > order_key.buy_token
        ? [0, order_proceeds_withdrawn.amount]
        : [order_proceeds_withdrawn.amount, 0];

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO twamm_proceeds_withdrawals
                (event_id, key_hash, owner, salt, amount0, amount1, start_time, end_time)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        key_hash,

        BigInt(order_proceeds_withdrawn.owner),
        order_proceeds_withdrawn.salt,
        amount0,
        amount1,
        new Date(Number(order_key.start_time * 1000n)),
        new Date(Number(order_key.end_time * 1000n)),
      ],
    });
  }

  public async insertTWAMMVirtualOrdersExecutedEvent(
    virtual_orders_executed: VirtualOrdersExecutedEvent,
    key: EventKey
  ) {
    let { key: state_key } = virtual_orders_executed;

    const key_hash = await this.insertPoolKeyHash({
      token0: state_key.token0,
      token1: state_key.token1,
      fee: state_key.fee,
      tick_spacing: BigInt(MAX_TICK_SPACING),
      extension: key.fromAddress,
    });

    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys
                        (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO twamm_virtual_order_executions
                (event_id, key_hash, token0_sale_rate, token1_sale_rate, delta0, delta1)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9);
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,

        key_hash,
        virtual_orders_executed.token0_sale_rate,
        virtual_orders_executed.token1_sale_rate,
        virtual_orders_executed.twamm_delta.amount0,
        virtual_orders_executed.twamm_delta.amount1,
      ],
    });
  }

  async insertStakerStakedEvent(parsed: StakedEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO staker_staked
                (event_id,
                 from_address,
                 delegate,
                 amount)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.from,
        parsed.delegate,
        parsed.amount,
      ],
    });
  }

  async insertStakerWithdrawnEvent(parsed: WithdrawnEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO staker_withdrawn
                (event_id,
                 from_address,
                 delegate,
                 amount,
                 recipient)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.from,
        parsed.delegate,
        parsed.amount,
        parsed.to,
      ],
    });
  }

  async insertGovernorProposedEvent(
    parsed: GovernorProposedEvent,
    key: EventKey
  ) {
    const query =
      parsed.calls.length > 0
        ? `
                        WITH inserted_event AS (
                            INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                                VALUES ($1, $2, $3, $4)
                                RETURNING id),
                             inserted_governor_proposed AS (
                                 INSERT
                                     INTO governor_proposed
                                         (event_id, id, proposer, config_version)
                                         VALUES ((SELECT id FROM inserted_event), $5, $6, $7))
                        INSERT
                        INTO governor_proposed_calls (proposal_id, index, to_address, selector, calldata)
                        VALUES
                        ${parsed.calls
                          .map(
                            (call, ix) =>
                              `($5, ${ix}, ${call.to}, ${
                                call.selector
                              }, '{${call.calldata
                                .map((c) => c.toString())
                                .join(",")}}')`
                          )
                          .join(",")};
                `
        : `
                        WITH inserted_event AS (
                            INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                                VALUES ($1, $2, $3, $4)
                                RETURNING id)
                        INSERT
                        INTO governor_proposed
                            (event_id, id, proposer, config_version)
                        VALUES ((SELECT id FROM inserted_event), $5, $6, $7);
                `;
    await this.pg.query({
      text: query,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.id,
        parsed.proposer,
        parsed.config_version,
      ],
    });
  }

  async insertGovernorExecutedEvent(
    parsed: GovernorExecutedEvent,
    key: EventKey
  ) {
    const query =
      parsed.result_data.length > 0
        ? `
                        WITH inserted_event AS (
                            INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                                VALUES ($1, $2, $3, $4)
                                RETURNING id),
                             inserted_governor_executed AS (
                                 INSERT
                                     INTO governor_executed
                                         (event_id, id)
                                         VALUES ((SELECT id FROM inserted_event), $5))
                        INSERT
                        INTO governor_executed_results (proposal_id, index, results)
                        VALUES
                        ${parsed.result_data
                          .map(
                            (results, ix) =>
                              `($5, ${ix}, '{${results
                                .map((c) => c.toString())
                                .join(",")}}')`
                          )
                          .join(",")};
                `
        : `

                        WITH inserted_event AS (
                            INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                                VALUES ($1, $2, $3, $4)
                                RETURNING id)
                        INSERT
                        INTO governor_executed
                            (event_id, id)
                        VALUES ((SELECT id FROM inserted_event), $5)
                `;

    await this.pg.query({
      text: query,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.id,
      ],
    });
  }

  async insertGovernorVotedEvent(parsed: GovernorVotedEvent, key: EventKey) {
    await this.pg.query({
      text: `
                WITH inserted_event AS (
                    INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                        VALUES ($1, $2, $3, $4)
                        RETURNING id)
                INSERT
                INTO governor_voted
                    (event_id, id, voter, weight, yea)
                VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8)
            `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.id,
        parsed.voter,
        parsed.weight,
        parsed.yea,
      ],
    });
  }

  async insertGovernorCanceledEvent(
    parsed: GovernorCanceledEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                  VALUES ($1, $2, $3, $4)
                  RETURNING id)
          INSERT
          INTO governor_canceled
              (event_id, id)
          VALUES ((SELECT id FROM inserted_event), $5)
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.id,
      ],
    });
  }

  async insertGovernorProposalDescribedEvent(
    parsed: DescribedEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                  VALUES ($1, $2, $3, $4)
                  RETURNING id)
          INSERT
          INTO governor_proposal_described
              (event_id, id, description)
          VALUES ((SELECT id FROM inserted_event), $5, $6)
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.id,
        // postgres does not support null characters
        parsed.description.replaceAll("\u0000", "?"),
      ],
    });
  }

  async insertGovernorReconfiguredEvent(
    parsed: GovernorReconfiguredEvent,
    key: EventKey
  ) {
    await this.pg.query({
      text: `
          WITH inserted_event AS (
              INSERT INTO event_keys (block_number, transaction_index, event_index, transaction_hash)
                  VALUES ($1, $2, $3, $4)
                  RETURNING id)
          INSERT
          INTO governor_reconfigured
          (event_id, version, voting_start_delay, voting_period, voting_weight_smoothing_duration, quorum,
           proposal_creation_threshold, execution_delay, execution_window)
          VALUES ((SELECT id FROM inserted_event), $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      values: [
        key.blockNumber,
        key.transactionIndex,
        key.eventIndex,
        key.transactionHash,
        parsed.version,
        parsed.new_config.voting_start_delay,
        parsed.new_config.voting_period,
        parsed.new_config.voting_weight_smoothing_duration,
        parsed.new_config.quorum,
        parsed.new_config.proposal_creation_threshold,
        parsed.new_config.execution_delay,
        parsed.new_config.execution_window,
      ],
    });
  }
}
