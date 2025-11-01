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

CREATE TABLE oracle_pool_states (
	pool_key_id int8 PRIMARY KEY NOT NULL REFERENCES pool_keys (pool_key_id),
	last_snapshot_block_timestamp int8 NOT NULL
);

CREATE OR REPLACE FUNCTION oracle_apply_snapshot_deferred ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_pool_key_id bigint;
BEGIN
	SELECT
		pk.pool_key_id INTO v_pool_key_id STRICT
	FROM
		pool_keys pk
	WHERE
		pk.chain_id = NEW.chain_id
		AND pk.token0 = NEW.token0
		AND pk.token1 = NEW.token1
		AND pk.pool_extension = NEW.emitter;
	INSERT INTO oracle_pool_states (pool_key_id, last_snapshot_block_timestamp)
		VALUES (v_pool_key_id, NEW.snapshot_block_timestamp)
	ON CONFLICT (pool_key_id)
		DO UPDATE SET
			last_snapshot_block_timestamp = GREATEST (oracle_pool_states.last_snapshot_block_timestamp, EXCLUDED.last_snapshot_block_timestamp);
	RETURN NEW;
END;
$$
LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_oracle_apply_snapshot
	AFTER INSERT ON oracle_snapshots DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION oracle_apply_snapshot_deferred ();
	
CREATE OR REPLACE FUNCTION oracle_rollback_snapshot ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_pool_key_id bigint;
	v_last_ts bigint;
BEGIN
	-- find the pool for this snapshot (strict one-row match)
	SELECT
		pk.pool_key_id INTO STRICT v_pool_key_id
	FROM
		pool_keys pk
	WHERE
		pk.chain_id = OLD.chain_id
		AND pk.token0 = OLD.token0
		AND pk.token1 = OLD.token1
		-- todo: this row is already deleted, which prevents the rollback
		AND pk.pool_extension = OLD.emitter;
	-- get the most recent remaining snapshot (by event_id, not timestamp)
	SELECT
		os.snapshot_block_timestamp INTO v_last_ts
	FROM
		oracle_snapshots os
	WHERE
		os.chain_id = OLD.chain_id
		AND os.token0 = OLD.token0
		AND os.token1 = OLD.token1
		AND os.emitter = (
			SELECT
				pool_extension
			FROM
				pool_keys
			WHERE
				pool_key_id = v_pool_key_id)
	ORDER BY
		os.event_id DESC
	LIMIT 1;
	IF v_last_ts IS NULL THEN
		-- no snapshots remain → delete state row
		DELETE FROM oracle_pool_states
		WHERE pool_key_id = v_pool_key_id;
	ELSE
		-- set state to last surviving snapshot
		UPDATE
			oracle_pool_states
		SET
			last_snapshot_block_timestamp = v_last_ts
		WHERE
			pool_key_id = v_pool_key_id;
	END IF;
	RETURN OLD;
END;
$$
LANGUAGE plpgsql;


CREATE TRIGGER trg_oracle_rollback_snapshot
	AFTER DELETE ON oracle_snapshots
	FOR EACH ROW
	EXECUTE FUNCTION oracle_rollback_snapshot ();
