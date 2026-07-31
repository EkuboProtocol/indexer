-- Keep the rebuild consistent with the trigger-maintained table. The migration
-- runner wraps this file in a transaction, so writers resume after commit.
LOCK TABLE position_updates IN SHARE MODE;

CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_insert()
    RETURNS TRIGGER
    AS $$
BEGIN
    -- Update or insert for lower_bound
    UPDATE per_pool_per_tick_liquidity
    SET net_liquidity_delta_diff = net_liquidity_delta_diff + NEW.liquidity_delta,
        total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
    WHERE pool_key_id = NEW.pool_key_id
      AND tick = NEW.lower_bound;

    IF NOT FOUND THEN
        INSERT INTO per_pool_per_tick_liquidity (
            pool_key_id,
            tick,
            net_liquidity_delta_diff,
            total_liquidity_on_tick
        )
        VALUES (
            NEW.pool_key_id,
            NEW.lower_bound,
            NEW.liquidity_delta,
            NEW.liquidity_delta
        );
    END IF;

    -- Only remove fully canceled aggregates.
    DELETE FROM per_pool_per_tick_liquidity
    WHERE pool_key_id = NEW.pool_key_id
      AND tick = NEW.lower_bound
      AND net_liquidity_delta_diff = 0
      AND total_liquidity_on_tick = 0;

    -- Update or insert for upper_bound
    UPDATE per_pool_per_tick_liquidity
    SET net_liquidity_delta_diff = net_liquidity_delta_diff - NEW.liquidity_delta,
        total_liquidity_on_tick = total_liquidity_on_tick + NEW.liquidity_delta
    WHERE pool_key_id = NEW.pool_key_id
      AND tick = NEW.upper_bound;

    IF NOT FOUND THEN
        INSERT INTO per_pool_per_tick_liquidity (
            pool_key_id,
            tick,
            net_liquidity_delta_diff,
            total_liquidity_on_tick
        )
        VALUES (
            NEW.pool_key_id,
            NEW.upper_bound,
            -NEW.liquidity_delta,
            NEW.liquidity_delta
        );
    END IF;

    -- Only remove fully canceled aggregates.
    DELETE FROM per_pool_per_tick_liquidity
    WHERE pool_key_id = NEW.pool_key_id
      AND tick = NEW.upper_bound
      AND net_liquidity_delta_diff = 0
      AND total_liquidity_on_tick = 0;

    RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION net_liquidity_deltas_after_delete()
    RETURNS TRIGGER
    AS $$
BEGIN
    -- Reverse effect for lower_bound
    UPDATE per_pool_per_tick_liquidity
    SET net_liquidity_delta_diff = net_liquidity_delta_diff - OLD.liquidity_delta,
        total_liquidity_on_tick = total_liquidity_on_tick - OLD.liquidity_delta
    WHERE pool_key_id = OLD.pool_key_id
      AND tick = OLD.lower_bound;

    IF NOT FOUND THEN
        INSERT INTO per_pool_per_tick_liquidity (
            pool_key_id,
            tick,
            net_liquidity_delta_diff,
            total_liquidity_on_tick
        )
        VALUES (
            OLD.pool_key_id,
            OLD.lower_bound,
            -OLD.liquidity_delta,
            -OLD.liquidity_delta
        );
    END IF;

    -- Reorg cascades can temporarily zero only one aggregate.
    DELETE FROM per_pool_per_tick_liquidity
    WHERE pool_key_id = OLD.pool_key_id
      AND tick = OLD.lower_bound
      AND net_liquidity_delta_diff = 0
      AND total_liquidity_on_tick = 0;

    -- Reverse effect for upper_bound
    UPDATE per_pool_per_tick_liquidity
    SET net_liquidity_delta_diff = net_liquidity_delta_diff + OLD.liquidity_delta,
        total_liquidity_on_tick = total_liquidity_on_tick - OLD.liquidity_delta
    WHERE pool_key_id = OLD.pool_key_id
      AND tick = OLD.upper_bound;

    IF NOT FOUND THEN
        INSERT INTO per_pool_per_tick_liquidity (
            pool_key_id,
            tick,
            net_liquidity_delta_diff,
            total_liquidity_on_tick
        )
        VALUES (
            OLD.pool_key_id,
            OLD.upper_bound,
            OLD.liquidity_delta,
            -OLD.liquidity_delta
        );
    END IF;

    -- Reorg cascades can temporarily zero only one aggregate.
    DELETE FROM per_pool_per_tick_liquidity
    WHERE pool_key_id = OLD.pool_key_id
      AND tick = OLD.upper_bound
      AND net_liquidity_delta_diff = 0
      AND total_liquidity_on_tick = 0;

    RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TEMPORARY TABLE rebuilt_per_pool_per_tick_liquidity (
    pool_key_id int8 NOT NULL,
    tick int4 NOT NULL,
    net_liquidity_delta_diff numeric NOT NULL,
    total_liquidity_on_tick numeric NOT NULL,
    PRIMARY KEY (pool_key_id, tick)
) ON COMMIT DROP;

INSERT INTO rebuilt_per_pool_per_tick_liquidity (
    pool_key_id,
    tick,
    net_liquidity_delta_diff,
    total_liquidity_on_tick
)
SELECT
    pool_key_id,
    tick,
    SUM(net_liquidity_delta_diff),
    SUM(total_liquidity_on_tick)
FROM position_updates
CROSS JOIN LATERAL (
    VALUES
        (
            lower_bound,
            liquidity_delta,
            liquidity_delta
        ),
        (
            upper_bound,
            -liquidity_delta,
            liquidity_delta
        )
) tick_liquidity_changes (
    tick,
    net_liquidity_delta_diff,
    total_liquidity_on_tick
)
GROUP BY pool_key_id, tick
HAVING SUM(net_liquidity_delta_diff) <> 0
    OR SUM(total_liquidity_on_tick) <> 0;

INSERT INTO per_pool_per_tick_liquidity AS current (
    pool_key_id,
    tick,
    net_liquidity_delta_diff,
    total_liquidity_on_tick
)
SELECT
    pool_key_id,
    tick,
    net_liquidity_delta_diff,
    total_liquidity_on_tick
FROM rebuilt_per_pool_per_tick_liquidity
ON CONFLICT (pool_key_id, tick)
DO UPDATE
SET net_liquidity_delta_diff = EXCLUDED.net_liquidity_delta_diff,
    total_liquidity_on_tick = EXCLUDED.total_liquidity_on_tick
WHERE (
    current.net_liquidity_delta_diff,
    current.total_liquidity_on_tick
) IS DISTINCT FROM (
    EXCLUDED.net_liquidity_delta_diff,
    EXCLUDED.total_liquidity_on_tick
);

DELETE FROM per_pool_per_tick_liquidity current
WHERE NOT EXISTS (
    SELECT 1
    FROM rebuilt_per_pool_per_tick_liquidity rebuilt
    WHERE rebuilt.pool_key_id = current.pool_key_id
      AND rebuilt.tick = current.tick
);
