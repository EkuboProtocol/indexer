CREATE TABLE twamm_order_updates (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    locker NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    sale_rate_delta0 NUMERIC NOT NULL,
    sale_rate_delta1 NUMERIC NOT NULL,
    start_time timestamptz NOT NULL,
    end_time timestamptz NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_twamm_order_updates_pool_key_id_event_id ON twamm_order_updates USING btree (pool_key_id, event_id);
CREATE INDEX idx_twamm_order_updates_pool_key_id_time ON twamm_order_updates USING btree (pool_key_id, start_time, end_time);
CREATE INDEX idx_twamm_order_updates_owner_salt ON twamm_order_updates USING btree (locker, salt);
CREATE INDEX idx_twamm_order_updates_salt ON twamm_order_updates USING btree (salt);
CREATE INDEX idx_twamm_order_updates_salt_key_hash_start_end_owner_event_id ON twamm_order_updates (
    salt,
    pool_key_id,
    start_time,
    end_time,
    locker,
    event_id
);
CREATE TABLE twamm_proceeds_withdrawals (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    locker NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    start_time timestamptz NOT NULL,
    end_time timestamptz NOT NULL,
    amount0 NUMERIC NOT NULL,
    amount1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_twamm_proceeds_withdrawals_pool_key_id_event_id ON twamm_proceeds_withdrawals USING btree (pool_key_id, event_id);
CREATE INDEX idx_twamm_proceeds_withdrawals_pool_key_id_time ON twamm_proceeds_withdrawals USING btree (pool_key_id, start_time, end_time);
CREATE INDEX idx_twamm_proceeds_withdrawals_owner_salt ON twamm_proceeds_withdrawals USING btree (locker, salt);
CREATE INDEX idx_twamm_proceeds_withdrawals_salt ON twamm_proceeds_withdrawals USING btree (salt);
CREATE INDEX idx_twamm_proceeds_withdrawals_salt_event_id_desc ON twamm_proceeds_withdrawals (salt, event_id DESC);
CREATE TABLE twamm_virtual_order_executions (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    token0_sale_rate NUMERIC NOT NULL,
    token1_sale_rate NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_twamm_virtual_order_executions_pool_key_id_event_id ON twamm_virtual_order_executions USING btree (pool_key_id, event_id DESC);
CREATE VIEW twamm_pool_states_view AS (
    WITH lvoe_id AS (
        SELECT pool_key_id,
            MAX(event_id) AS event_id
        FROM twamm_virtual_order_executions
        GROUP BY pool_key_id
    ),
    last_virtual_order_execution AS (
        SELECT pk.id AS pool_key_id,
            last_voe.token0_sale_rate,
            last_voe.token1_sale_rate,
            last_voe.event_id AS last_virtual_order_execution_event_id,
            b.time AS last_virtual_execution_time
        FROM pool_keys pk
            JOIN lvoe_id ON lvoe_id.pool_key_id = pk.id
            JOIN twamm_virtual_order_executions last_voe ON last_voe.chain_id = pk.chain_id
            AND last_voe.event_id = lvoe_id.event_id
            JOIN event_keys ek ON last_voe.chain_id = ek.chain_id
            AND last_voe.event_id = ek.sort_id
            JOIN blocks b ON ek.chain_id = b.chain_id
            AND ek.block_number = b.number
    ),
    active_order_updates_after_lvoe AS (
        SELECT lvoe_1.pool_key_id,
            SUM(tou.sale_rate_delta0) AS sale_rate_delta0,
            SUM(tou.sale_rate_delta1) AS sale_rate_delta1,
            MAX(tou.event_id) AS last_order_update_event_id
        FROM last_virtual_order_execution lvoe_1
            JOIN twamm_order_updates tou ON tou.pool_key_id = lvoe_1.pool_key_id
            AND tou.event_id > lvoe_1.last_virtual_order_execution_event_id
            AND tou.start_time <= lvoe_1.last_virtual_execution_time
            AND tou.end_time > lvoe_1.last_virtual_execution_time
        GROUP BY lvoe_1.pool_key_id
    )
    SELECT lvoe.pool_key_id,
        lvoe.token0_sale_rate + COALESCE(ou_lvoe.sale_rate_delta0, 0::NUMERIC) AS token0_sale_rate,
        lvoe.token1_sale_rate + COALESCE(ou_lvoe.sale_rate_delta1, 0::NUMERIC) AS token1_sale_rate,
        lvoe.last_virtual_execution_time,
        GREATEST(
            COALESCE(
                ou_lvoe.last_order_update_event_id,
                lvoe.last_virtual_order_execution_event_id
            ),
            psv.last_event_id
        ) AS last_event_id
    FROM last_virtual_order_execution lvoe
        JOIN pool_states_incremental_view psv ON lvoe.pool_key_id = psv.pool_key_id
        LEFT JOIN active_order_updates_after_lvoe ou_lvoe ON lvoe.pool_key_id = ou_lvoe.pool_key_id
);
CREATE MATERIALIZED VIEW twamm_pool_states_materialized AS (
    SELECT pool_key_id,
        token0_sale_rate,
        token1_sale_rate,
        last_virtual_execution_time,
        last_event_id
    FROM twamm_pool_states_view
);
CREATE UNIQUE INDEX idx_twamm_pool_states_materialized_key_hash ON twamm_pool_states_materialized USING btree (pool_key_id);
CREATE VIEW twamm_sale_rate_deltas_view AS (
    WITH all_order_deltas AS (
        SELECT pool_key_id,
            start_time AS time,
            SUM(sale_rate_delta0) net_sale_rate_delta0,
            SUM(sale_rate_delta1) net_sale_rate_delta1
        FROM twamm_order_updates
        GROUP BY pool_key_id,
            start_time
        UNION ALL
        SELECT pool_key_id,
            end_time AS time,
            - SUM(sale_rate_delta0) net_sale_rate_delta0,
            - SUM(sale_rate_delta1) net_sale_rate_delta1
        FROM twamm_order_updates
        GROUP BY pool_key_id,
            end_time
    ),
    summed AS (
        SELECT pool_key_id,
            time,
            SUM(net_sale_rate_delta0) AS net_sale_rate_delta0,
            SUM(net_sale_rate_delta1) AS net_sale_rate_delta1
        FROM all_order_deltas
        GROUP BY pool_key_id,
            time
    )
    SELECT pool_key_id,
        time,
        net_sale_rate_delta0,
        net_sale_rate_delta1
    FROM summed
    WHERE net_sale_rate_delta0 != 0
        OR net_sale_rate_delta1 != 0
    ORDER BY pool_key_id,
        time
);
CREATE MATERIALIZED VIEW twamm_sale_rate_deltas_materialized AS (
    SELECT tsrdv.pool_key_id,
        tsrdv.time,
        tsrdv.net_sale_rate_delta0,
        tsrdv.net_sale_rate_delta1
    FROM twamm_sale_rate_deltas_view AS tsrdv
        JOIN twamm_pool_states_materialized tpsm ON tpsm.pool_key_id = tsrdv.pool_key_id
        AND tpsm.last_virtual_execution_time < tsrdv.time
);
CREATE UNIQUE INDEX idx_twamm_sale_rate_deltas_materialized_pool_key_id_time ON twamm_sale_rate_deltas_materialized USING btree (pool_key_id, time);