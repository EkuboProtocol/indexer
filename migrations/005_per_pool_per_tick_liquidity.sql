CREATE TABLE per_pool_per_tick_liquidity (
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	tick int4 NOT NULL,
	net_liquidity_delta_diff numeric,
	total_liquidity_on_tick numeric,
	PRIMARY KEY (pool_key_id, tick)
);

CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_pool_key_id int8;
BEGIN
	SELECT
		pool_key_id INTO STRICT v_pool_key_id
	FROM
		pool_balance_change pbc
	WHERE
		pbc.chain_id = NEW.chain_id
		AND pbc.event_id = NEW.event_id;
	-- Update or insert for lower_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff + NEW.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
	WHERE
		pool_key_id = v_pool_key_id
		AND tick = NEW.lower_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (v_pool_key_id, NEW.lower_bound, NEW.liquidity_delta, NEW.liquidity_delta);
	END IF;
	-- Delete if total_liquidity_on_tick is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = v_pool_key_id
		AND tick = NEW.lower_bound
		AND total_liquidity_on_tick = 0;
	-- Update or insert for upper_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff - NEW.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
	WHERE
		pool_key_id = v_pool_key_id
		AND tick = NEW.upper_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (v_pool_key_id, NEW.upper_bound, - NEW.liquidity_delta, NEW.liquidity_delta);
	END IF;
	-- Delete if net_liquidity_delta_diff is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = v_pool_key_id
		AND tick = NEW.upper_bound
		AND total_liquidity_on_tick = 0;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_state RECORD;
BEGIN
	SELECT
		liquidity_delta,
		lower_bound,
		upper_bound INTO v_state
	FROM
		position_updates pu
	WHERE
		pu.chain_id = OLD.chain_id
		AND pu.event_id = OLD.event_id;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	-- Reverse effect for lower_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff - v_state.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick - v_state.liquidity_delta
	WHERE
		pool_key_id = OLD.pool_key_id
		AND tick = v_state.lower_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (OLD.pool_key_id, OLD.lower_bound, - v_state.liquidity_delta, - v_state.liquidity_delta);
	END IF;
	-- Delete if net_liquidity_delta_diff is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = OLD.pool_key_id
		AND tick = v_state.lower_bound
		AND total_liquidity_on_tick = 0;
	-- Reverse effect for upper_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff + v_state.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick - v_state.liquidity_delta
	WHERE
		pool_key_id = OLD.pool_key_id
		AND tick = v_state.upper_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (OLD.pool_key_id, v_state.upper_bound, v_state.liquidity_delta, - v_state.liquidity_delta);
	END IF;
	-- Delete if net_liquidity_delta_diff is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = OLD.pool_key_id
		AND tick = v_state.upper_bound
		AND total_liquidity_on_tick = 0;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_update ()
	RETURNS TRIGGER
	AS $$
BEGIN
	-- Reverse OLD row effects (similar to DELETE)
	PERFORM
		net_liquidity_deltas_after_delete ();
	-- Apply NEW row effects (similar to INSERT)
	PERFORM
		net_liquidity_deltas_after_insert ();
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_insert AFTER INSERT ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_insert ();

CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_delete AFTER DELETE ON pool_balance_change FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_delete ();

CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_update AFTER UPDATE ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_update ();
