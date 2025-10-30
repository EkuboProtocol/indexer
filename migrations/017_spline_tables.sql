CREATE TABLE spline_liquidity_updated (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    sender NUMERIC NOT NULL,
    liquidity_factor NUMERIC NOT NULL,
    shares NUMERIC NOT NULL,
    amount0 NUMERIC NOT NULL,
    amount1 NUMERIC NOT NULL,
    protocol_fees0 NUMERIC NOT NULL,
    protocol_fees1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_spline_liquidity_updated_updated_pool_key_id ON spline_liquidity_updated USING btree (pool_key_id);
CREATE MATERIALIZED VIEW IF NOT EXISTS spline_pools_materialized AS (
    SELECT DISTINCT pool_key_id
    FROM spline_liquidity_updated
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spline_pools_materialized_pool_key_hash ON spline_pools_materialized USING btree (pool_key_id);