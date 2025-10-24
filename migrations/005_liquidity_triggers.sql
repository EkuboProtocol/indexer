CREATE OR REPLACE VIEW per_pool_per_tick_liquidity_view AS (
        WITH all_tick_deltas AS (
            SELECT pool_key_id,
                lower_bound AS tick,
                SUM(liquidity_delta) net_liquidity_delta,
                SUM(liquidity_delta) total_liquidity_on_tick
            FROM position_updates pu
                join pool_balance_change_event pbc on pu.chain_id = pbc.chain_id
                and pu.pool_balance_change_id = pbc.event_id
            GROUP BY pool_key_id,
                lower_bound
            UNION ALL
            SELECT pool_key_id,
                upper_bound AS tick,
                SUM(- liquidity_delta) net_liquidity_delta,
                SUM(liquidity_delta) total_liquidity_on_tick
            FROM position_updates pu
                join pool_balance_change_event pbc on pu.chain_id = pbc.chain_id
                and pu.pool_balance_change_id = pbc.event_id
            GROUP BY pool_key_id,
                upper_bound
        ),
        summed AS (
            SELECT pool_key_id,
                tick,
                SUM(net_liquidity_delta) AS net_liquidity_delta_diff,
                SUM(total_liquidity_on_tick) AS total_liquidity_on_tick
            FROM all_tick_deltas
            GROUP BY pool_key_id,
                tick
        )
        SELECT pool_key_id,
            tick,
            net_liquidity_delta_diff,
            total_liquidity_on_tick
        FROM summed
        WHERE net_liquidity_delta_diff != 0
        ORDER BY tick
    );
CREATE TABLE per_pool_per_tick_liquidity_incremental_view (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    tick int4,
    net_liquidity_delta_diff NUMERIC,
    total_liquidity_on_tick NUMERIC,
    PRIMARY KEY (pool_key_id, tick)
);
CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert() RETURNS TRIGGER AS $$ BEGIN -- Update or insert for lower_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff + new.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick + new.liquidity_delta
WHERE pool_key_id = new.pool_key_id
    AND tick = new.lower_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        new.pool_key_id,
        new.lower_bound,
        new.liquidity_delta,
        new.liquidity_delta
    );
END IF;
-- Delete if total_liquidity_on_tick is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = new.pool_key_id
    AND tick = new.lower_bound
    AND total_liquidity_on_tick = 0;
-- Update or insert for upper_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff - new.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick + new.liquidity_delta
WHERE pool_key_id = new.pool_key_id
    AND tick = new.upper_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        new.pool_key_id,
        new.upper_bound,
        - new.liquidity_delta,
        new.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = new.pool_key_id
    AND tick = new.upper_bound
    AND total_liquidity_on_tick = 0;
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete() RETURNS TRIGGER AS $$ BEGIN -- Reverse effect for lower_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff - old.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick - old.liquidity_delta
WHERE pool_key_id = old.pool_key_id
    AND tick = old.lower_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        old.pool_key_id,
        old.lower_bound,
        - old.liquidity_delta,
        - old.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = old.pool_key_id
    AND tick = old.lower_bound
    AND total_liquidity_on_tick = 0;
-- Reverse effect for upper_bound
UPDATE per_pool_per_tick_liquidity_incremental_view
SET net_liquidity_delta_diff = net_liquidity_delta_diff + old.liquidity_delta,
    total_liquidity_on_tick = total_liquidity_on_tick - old.liquidity_delta
WHERE pool_key_id = old.pool_key_id
    AND tick = old.upper_bound;
IF NOT found THEN
INSERT INTO per_pool_per_tick_liquidity_incremental_view (
        pool_key_id,
        tick,
        net_liquidity_delta_diff,
        total_liquidity_on_tick
    )
VALUES (
        old.pool_key_id,
        old.upper_bound,
        old.liquidity_delta,
        - old.liquidity_delta
    );
END IF;
-- Delete if net_liquidity_delta_diff is zero
DELETE FROM per_pool_per_tick_liquidity_incremental_view
WHERE pool_key_id = old.pool_key_id
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