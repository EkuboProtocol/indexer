CREATE TABLE oracle_snapshots (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    token NUMERIC NOT NULL,
    snapshot_block_timestamp int8 NOT NULL,
    snapshot_tick_cumulative NUMERIC NOT NULL,
    snapshot_seconds_per_liquidity_cumulative NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_oracle_snapshots_chain_id_token_snapshot_block_timestamp ON oracle_snapshots USING btree (chain_id, token, snapshot_block_timestamp);
CREATE VIEW oracle_pool_states_view AS (
    SELECT pk.id AS pool_key_id,
        MAX(snapshot_block_timestamp) AS last_snapshot_block_timestamp
    FROM oracle_snapshots os
        JOIN event_keys ek ON ek.sort_id = os.event_id
        JOIN pool_keys pk ON ek.emitter = pk.extension
        AND pk.token1 = os.token
    GROUP BY pk.id
);
CREATE MATERIALIZED VIEW oracle_pool_states_materialized AS (
    SELECT pool_key_id,
        last_snapshot_block_timestamp
    FROM oracle_pool_states_view
);
CREATE UNIQUE INDEX idx_oracle_pool_states_materialized_pool_key_id ON oracle_pool_states_materialized USING btree (pool_key_id);