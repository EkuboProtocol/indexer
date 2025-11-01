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
	v_pool_key_id int8 := NEW.pool_key_id;
	v_delta numeric := NEW.liquidity_delta;
BEGIN
	-- Update or insert for lower_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff + v_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + v_delta
	WHERE
		pool_key_id = v_pool_key_id
		AND tick = NEW.lower_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (v_pool_key_id, NEW.lower_bound, v_delta, v_delta);
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
		net_liquidity_delta_diff = net_liquidity_delta_diff - v_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + v_delta
	WHERE
		pool_key_id = v_pool_key_id
		AND tick = NEW.upper_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (v_pool_key_id, NEW.upper_bound, - v_delta, v_delta);
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
BEGIN
	IF OLD.pool_key_id IS NULL THEN
		RETURN NULL;
	END IF;
	-- Reverse effect for lower_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff - OLD.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick - OLD.liquidity_delta
	WHERE
		pool_key_id = OLD.pool_key_id
		AND tick = OLD.lower_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (OLD.pool_key_id, OLD.lower_bound, - OLD.liquidity_delta, - OLD.liquidity_delta);
	END IF;
	-- Delete if net_liquidity_delta_diff is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = OLD.pool_key_id
		AND tick = OLD.lower_bound
		AND total_liquidity_on_tick = 0;
	-- Reverse effect for upper_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff + OLD.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick - OLD.liquidity_delta
	WHERE
		pool_key_id = OLD.pool_key_id
		AND tick = OLD.upper_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (OLD.pool_key_id, OLD.upper_bound, OLD.liquidity_delta, - OLD.liquidity_delta);
	END IF;
	-- Delete if net_liquidity_delta_diff is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = OLD.pool_key_id
		AND tick = OLD.upper_bound
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

CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_delete AFTER DELETE ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_delete ();

CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_update AFTER UPDATE ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_update ();
