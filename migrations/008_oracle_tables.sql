CREATE TABLE oracle_snapshots (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    snapshot_block_timestamp int8 NOT NULL,
    snapshot_tick_cumulative NUMERIC NOT NULL,
    -- null in case of starknet
    snapshot_seconds_per_liquidity_cumulative NUMERIC,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_oracle_snapshots_chain_id_pair_snapshot_block_timestamp ON oracle_snapshots USING btree (
    chain_id,
    token0,
    token1,
    snapshot_block_timestamp
);
CREATE VIEW oracle_pool_states_view AS (
    SELECT pk.id AS pool_key_id,
        MAX(snapshot_block_timestamp) AS last_snapshot_block_timestamp
    FROM oracle_snapshots os
        JOIN event_keys ek USING (chain_id, event_id)
        JOIN pool_keys pk ON ek.chain_id = pk.chain_id
        AND ek.emitter = pk.extension
        AND pk.token0 = os.token0 -- there is only one pool key per token pair
        AND pk.token1 = os.token1
    GROUP BY pk.id
);
CREATE MATERIALIZED VIEW oracle_pool_states_materialized AS (
    SELECT pool_key_id,
        last_snapshot_block_timestamp
    FROM oracle_pool_states_view
);
CREATE UNIQUE INDEX idx_oracle_pool_states_materialized_pool_key_id ON oracle_pool_states_materialized USING btree (pool_key_id);