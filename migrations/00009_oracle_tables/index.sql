CREATE TABLE oracle_snapshots (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	snapshot_block_timestamp int8 NOT NULL,
	snapshot_tick_cumulative numeric NOT NULL,
	-- null in case of starknet
	snapshot_seconds_per_liquidity_cumulative numeric,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_oracle_snapshots
	BEFORE UPDATE ON oracle_snapshots
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();