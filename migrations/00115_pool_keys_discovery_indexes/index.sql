-- Discovery-route filters over pool_keys. The token0 side of single-token
-- lookups is already served by pool_keys_chain_id_token0_token1_idx (00110);
-- token1-side lookups and extension filters would otherwise scan the whole
-- chain partition.
CREATE INDEX pool_keys_chain_id_token1_idx ON pool_keys (chain_id, token1);

CREATE INDEX pool_keys_chain_id_pool_extension_idx
    ON pool_keys (chain_id, pool_extension);
