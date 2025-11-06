CREATE TABLE per_pool_per_tick_liquidity (
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	tick int4 NOT NULL,
	net_liquidity_delta_diff numeric NOT NULL,
	total_liquidity_on_tick numeric NOT NULL,
	PRIMARY KEY (pool_key_id, tick)
);

CREATE FUNCTION net_liquidity_deltas_after_insert ()
	RETURNS TRIGGER
	AS $$
BEGIN
	-- Update or insert for lower_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff + NEW.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
	WHERE
		pool_key_id = NEW.pool_key_id
		AND tick = NEW.lower_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (NEW.pool_key_id, NEW.lower_bound, NEW.liquidity_delta, NEW.liquidity_delta);
	END IF;
	-- Delete if total_liquidity_on_tick is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = NEW.pool_key_id
		AND tick = NEW.lower_bound
		AND total_liquidity_on_tick = 0;
	-- Update or insert for upper_bound
	UPDATE
		per_pool_per_tick_liquidity
	SET
		net_liquidity_delta_diff = net_liquidity_delta_diff - NEW.liquidity_delta,
		total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
	WHERE
		pool_key_id = NEW.pool_key_id
		AND tick = NEW.upper_bound;
	IF NOT found THEN
		INSERT INTO per_pool_per_tick_liquidity (pool_key_id, tick, net_liquidity_delta_diff, total_liquidity_on_tick)
			VALUES (NEW.pool_key_id, NEW.upper_bound, - NEW.liquidity_delta, NEW.liquidity_delta);
	END IF;
	-- Delete if total_liquidity_on_tick is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = NEW.pool_key_id
		AND tick = NEW.upper_bound
		AND total_liquidity_on_tick = 0;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE FUNCTION net_liquidity_deltas_after_delete ()
	RETURNS TRIGGER
	AS $$
BEGIN
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
	-- Delete if total_liquidity_on_tick is zero
	DELETE FROM per_pool_per_tick_liquidity
	WHERE pool_key_id = OLD.pool_key_id
		AND tick = OLD.upper_bound
		AND total_liquidity_on_tick = 0;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER net_liquidity_deltas_after_insert
	AFTER INSERT ON position_updates
	FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_insert ();
CREATE TRIGGER net_liquidity_deltas_after_delete
	AFTER DELETE ON position_updates
	FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_delete ();
