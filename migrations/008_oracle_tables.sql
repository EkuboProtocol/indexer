CREATE TABLE oracle_snapshots (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	-- we include an arbitrary version number so we can distinguish between different oracles in the group
	oracle_version int2 NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	snapshot_block_timestamp int8 NOT NULL,
	snapshot_tick_cumulative numeric NOT NULL,
	-- null in case of starknet
	snapshot_seconds_per_liquidity_cumulative numeric,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX idx_oracle_snapshots_chain_id_token0_token1_timestamp ON oracle_snapshots (chain_id, oracle_version, token0, token1, snapshot_block_timestamp DESC);

CREATE VIEW oracle_pool_states_view AS (
	WITH last_snapshot AS (
		SELECT DISTINCT ON (chain_id,
			oracle_version,
			token0,
			token1)
			chain_id,
			event_id,
			oracle_version,
			token0,
			token1,
			snapshot_block_timestamp
		FROM
			oracle_snapshots
		ORDER BY
			chain_id,
			oracle_version,
			token0,
			token1,
			snapshot_block_timestamp DESC
)
		SELECT
			pk.id AS pool_key_id,
			snapshot_block_timestamp AS last_snapshot_block_timestamp
		FROM
			last_snapshot ls
			JOIN event_keys ek USING (chain_id,
				event_id)
			JOIN pool_keys pk ON pk.chain_id = ls.chain_id
				AND pk.token0 = ls.token0
				AND pk.token1 = ls.token1
				AND pk.extension = ek.emitter);

CREATE MATERIALIZED VIEW oracle_pool_states_materialized AS (
	SELECT
		pool_key_id,
		last_snapshot_block_timestamp
	FROM
		oracle_pool_states_view);

CREATE UNIQUE INDEX idx_oracle_pool_states_materialized_pool_key_id ON oracle_pool_states_materialized USING btree (pool_key_id);
