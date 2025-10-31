CREATE TABLE oracle_snapshots (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    snapshot_block_timestamp int8 NOT NULL,
    snapshot_tick_cumulative NUMERIC NOT NULL,
    -- null in case of starknet
    snapshot_seconds_per_liquidity_cumulative NUMERIC,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_oracle_snapshots_pool_key_id_timestamp ON oracle_snapshots USING btree (pool_key_id, snapshot_block_timestamp);
CREATE VIEW oracle_pool_states_view AS (
    SELECT pool_key_id,
        MAX(snapshot_block_timestamp) AS last_snapshot_block_timestamp
    FROM oracle_snapshots os
    GROUP BY pool_key_id
);
CREATE MATERIALIZED VIEW oracle_pool_states_materialized AS (
    SELECT pool_key_id,
        last_snapshot_block_timestamp
    FROM oracle_pool_states_view
);
CREATE UNIQUE INDEX idx_oracle_pool_states_materialized_pool_key_id ON oracle_pool_states_materialized USING btree (pool_key_id);