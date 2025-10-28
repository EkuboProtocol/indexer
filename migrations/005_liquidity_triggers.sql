CREATE TABLE per_pool_per_tick_liquidity_incremental_view (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    tick int4 NOT NULL,
    net_liquidity_delta_diff NUMERIC,
    total_liquidity_on_tick NUMERIC,
    PRIMARY KEY (pool_key_id, tick)
);
CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert() RETURNS TRIGGER AS $$
DECLARE v_pool_key_id int8;
BEGIN
SELECT pool_key_id INTO STRICT v_pool_key_id
FROM pool_balance_change pbc
WHERE pbc.chain_id = new.chain_id
    AND pbc.event_id = new.event_id;
-- Update or insert for lower_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff + new.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick + new.liquidity_delta
WHERE pool_key_id = v_pool_key_id
    AND tick = new.lower_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        v_pool_key_id,
        new.lower_bound,
        new.liquidity_delta,
        new.liquidity_delta
    );
END IF;
-- Delete if total_liquidity_on_tick is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = v_pool_key_id
    AND tick = new.lower_bound
    AND total_liquidity_on_tick = 0;
-- Update or insert for upper_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff - new.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick + new.liquidity_delta
WHERE pool_key_id = v_pool_key_id
    AND tick = new.upper_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        v_pool_key_id,
        new.upper_bound,
        - new.liquidity_delta,
        new.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = v_pool_key_id
    AND tick = new.upper_bound
    AND total_liquidity_on_tick = 0;
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete() RETURNS TRIGGER AS $$
DECLARE v_pool_key_id int8;
BEGIN
SELECT pool_key_id INTO STRICT v_pool_key_id
FROM pool_balance_change pbc
WHERE pbc.chain_id = old.chain_id
    AND pbc.event_id = old.event_id;
-- Reverse effect for lower_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff - old.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick - old.liquidity_delta
WHERE pool_key_id = v_pool_key_id
    AND tick = old.lower_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        v_pool_key_id,
        old.lower_bound,
        - old.liquidity_delta,
        - old.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = v_pool_key_id
    AND tick = old.lower_bound
    AND total_liquidity_on_tick = 0;
-- Reverse effect for upper_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff + old.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick - old.liquidity_delta
WHERE pool_key_id = v_pool_key_id
    AND tick = old.upper_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        v_pool_key_id,
        old.upper_bound,
        old.liquidity_delta,
        - old.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = v_pool_key_id
    AND tick = old.upper_bound
    AND total_liquidity_on_tick = 0;
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_update() RETURNS TRIGGER AS $$ BEGIN -- Reverse OLD row effects (similar to DELETE)
    PERFORM net_liquidity_deltas_after_delete();
-- Apply NEW row effects (similar to INSERT)
PERFORM net_liquidity_deltas_after_insert();
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_insert
AFTER
INSERT ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_insert();
CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_delete
AFTER DELETE ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_delete();
CREATE OR REPLACE TRIGGER net_liquidity_deltas_after_update
AFTER
UPDATE ON position_updates FOR EACH ROW EXECUTE FUNCTION net_liquidity_deltas_after_update();