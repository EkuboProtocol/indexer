CREATE TABLE hourly_volume_by_token (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    hour timestamptz NOT NULL,
    token NUMERIC NOT NULL,
    volume NUMERIC NOT NULL,
    fees NUMERIC NOT NULL,
    swap_count NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);
CREATE TABLE hourly_price_data (
    chain_id int8 NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    hour timestamptz NOT NULL,
    k_volume NUMERIC NOT NULL,
    total NUMERIC NOT NULL,
    swap_count NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, token0, token1, hour)
);
CREATE TABLE hourly_tvl_delta_by_token (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    hour timestamptz NOT NULL,
    token NUMERIC NOT NULL,
    delta NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);
CREATE TABLE hourly_revenue_by_token (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    hour timestamptz NOT NULL,
    token NUMERIC NOT NULL,
    revenue NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);
CREATE OR REPLACE FUNCTION refresh_hourly_volume_by_token_for_hour(
        p_chain_id bigint,
        p_pool_key_id bigint,
        p_hour timestamptz
    ) RETURNS void AS $$
DECLARE v_hour timestamptz := DATE_TRUNC('hour', p_hour);
BEGIN
DELETE FROM hourly_volume_by_token
WHERE pool_key_id = p_pool_key_id
    AND hour = v_hour;
INSERT INTO hourly_volume_by_token (
        pool_key_id,
        hour,
        token,
        volume,
        fees,
        swap_count
    ) WITH swap_data AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            CASE
                WHEN pbc.delta0 >= 0 THEN pk.token0
                ELSE pk.token1
            END AS token,
            SUM(
                CASE
                    WHEN pbc.delta0 >= 0 THEN pbc.delta0
                    ELSE pbc.delta1
                END
            ) AS volume,
            SUM(
                FLOOR(
                    (
                        CASE
                            WHEN pbc.delta0 >= 0 THEN pbc.delta0
                            ELSE pbc.delta1
                        END * pk.fee
                    ) / 18446744073709551616::NUMERIC
                )
            ) AS fees,
            COUNT(1)::NUMERIC AS swap_count
        FROM swaps s
            JOIN pool_balance_change pbc ON s.chain_id = pbc.chain_id
            AND s.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = s.chain_id
            AND ek.sort_id = s.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE s.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND DATE_TRUNC('hour', b.time) = v_hour
        GROUP BY pbc.pool_key_id,
            CASE
                WHEN pbc.delta0 >= 0 THEN pk.token0
                ELSE pk.token1
            END
    ),
    fees_token0 AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            pk.token0 AS token,
            0::NUMERIC AS volume,
            SUM(pbc.delta0) AS fees,
            0::NUMERIC AS swap_count
        FROM fees_accumulated fa
            JOIN pool_balance_change pbc ON fa.chain_id = pbc.chain_id
            AND fa.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = fa.chain_id
            AND ek.sort_id = fa.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE fa.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND pbc.delta0 > 0
            AND DATE_TRUNC('hour', b.time) = v_hour
        GROUP BY pbc.pool_key_id,
            pk.token0
    ),
    fees_token1 AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            pk.token1 AS token,
            0::NUMERIC AS volume,
            SUM(pbc.delta1) AS fees,
            0::NUMERIC AS swap_count
        FROM fees_accumulated fa
            JOIN pool_balance_change pbc ON fa.chain_id = pbc.chain_id
            AND fa.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = fa.chain_id
            AND ek.sort_id = fa.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE fa.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND pbc.delta1 > 0
            AND DATE_TRUNC('hour', b.time) = v_hour
        GROUP BY pbc.pool_key_id,
            pk.token1
    ),
    combined_data AS (
        SELECT *
        FROM swap_data
        UNION ALL
        SELECT *
        FROM fees_token0
        UNION ALL
        SELECT *
        FROM fees_token1
    )
SELECT pool_key_id,
    v_hour AS hour,
    token,
    SUM(volume) AS volume,
    SUM(fees) AS fees,
    SUM(swap_count) AS swap_count
FROM combined_data
GROUP BY pool_key_id,
    token;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION refresh_hourly_price_data_for_hour(
        p_chain_id bigint,
        p_token0 NUMERIC,
        p_token1 NUMERIC,
        p_hour timestamptz
    ) RETURNS void AS $$
DECLARE v_hour timestamptz := DATE_TRUNC('hour', p_hour);
BEGIN
DELETE FROM hourly_price_data
WHERE chain_id = p_chain_id
    AND token0 = p_token0
    AND token1 = p_token1
    AND hour = v_hour;
INSERT INTO hourly_price_data (
        chain_id,
        token0,
        token1,
        hour,
        k_volume,
        total,
        swap_count
    ) WITH block_totals AS (
        SELECT ek.block_number,
            SUM(pbc.delta0) AS total_delta0,
            SUM(pbc.delta1) AS total_delta1,
            COUNT(1)::NUMERIC AS swap_count
        FROM swaps s
            JOIN pool_balance_change pbc ON s.chain_id = pbc.chain_id
            AND s.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = s.chain_id
            AND ek.sort_id = s.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE s.chain_id = p_chain_id
            AND pk.token0 = p_token0
            AND pk.token1 = p_token1
            AND DATE_TRUNC('hour', b.time) = v_hour
        GROUP BY ek.block_number
    )
SELECT p_chain_id AS chain_id,
    p_token0 AS token0,
    p_token1 AS token1,
    v_hour AS hour,
    SUM(ABS(total_delta0 * total_delta1)) AS k_volume,
    SUM(total_delta1 * total_delta1) AS total,
    SUM(swap_count) AS swap_count
FROM block_totals
WHERE total_delta0 <> 0
    AND total_delta1 <> 0
GROUP BY 1,
    2,
    3,
    4;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION refresh_hourly_tvl_delta_by_token_for_hour(
        p_chain_id bigint,
        p_pool_key_id bigint,
        p_hour timestamptz
    ) RETURNS void AS $$
DECLARE v_hour timestamptz := DATE_TRUNC('hour', p_hour);
BEGIN
DELETE FROM hourly_tvl_delta_by_token
WHERE pool_key_id = p_pool_key_id
    AND hour = v_hour;
INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta) WITH adjusted_pool_balance_changes AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            CASE
                WHEN pu.liquidity_delta IS NOT NULL
                AND pu.liquidity_delta < 0 THEN CEIL(
                    (pbc.delta0 * 18446744073709551616::NUMERIC) / (18446744073709551616::NUMERIC - pk.fee)
                )
                ELSE pbc.delta0
            END AS delta0,
            CASE
                WHEN pu.liquidity_delta IS NOT NULL
                AND pu.liquidity_delta < 0 THEN CEIL(
                    (pbc.delta1 * 18446744073709551616::NUMERIC) / (18446744073709551616::NUMERIC - pk.fee)
                )
                ELSE pbc.delta1
            END AS delta1
        FROM pool_balance_change pbc
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = pbc.chain_id
            AND ek.sort_id = pbc.event_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
            LEFT JOIN position_updates pu ON pu.chain_id = pbc.chain_id
            AND pu.pool_balance_change_id = pbc.event_id
        WHERE pbc.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND DATE_TRUNC('hour', b.time) = v_hour
    ),
    grouped AS (
        SELECT pool_key_id,
            SUM(delta0) AS delta0,
            SUM(delta1) AS delta1
        FROM adjusted_pool_balance_changes
        GROUP BY pool_key_id
    ),
    token_deltas AS (
        SELECT g.pool_key_id,
            v_hour AS hour,
            pk.token0 AS token,
            g.delta0 AS delta
        FROM grouped g
            JOIN pool_keys pk ON pk.id = g.pool_key_id
        UNION ALL
        SELECT g.pool_key_id,
            v_hour AS hour,
            pk.token1 AS token,
            g.delta1 AS delta
        FROM grouped g
            JOIN pool_keys pk ON pk.id = g.pool_key_id
    )
SELECT pool_key_id,
    hour,
    token,
    SUM(delta) AS delta
FROM token_deltas
GROUP BY pool_key_id,
    hour,
    token;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION refresh_hourly_revenue_by_token_for_hour(
        p_chain_id bigint,
        p_pool_key_id bigint,
        p_hour timestamptz
    ) RETURNS void AS $$
DECLARE v_hour timestamptz := DATE_TRUNC('hour', p_hour);
BEGIN
DELETE FROM hourly_revenue_by_token
WHERE pool_key_id = p_pool_key_id
    AND hour = v_hour;
INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue) WITH rev0 AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            pk.token0 AS token,
            SUM(
                CEIL(
                    (- pbc.delta0 * 18446744073709551616::NUMERIC) / (18446744073709551616::NUMERIC - pk.fee)
                ) + pbc.delta0
            ) AS revenue
        FROM position_updates pu
            JOIN pool_balance_change pbc ON pu.chain_id = pbc.chain_id
            AND pu.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = pu.chain_id
            AND ek.sort_id = pu.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE pu.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND DATE_TRUNC('hour', b.time) = v_hour
            AND pbc.delta0 < 0
            AND pk.fee <> 0
        GROUP BY pbc.pool_key_id,
            pk.token0
    ),
    rev1 AS (
        SELECT pbc.pool_key_id,
            v_hour AS hour,
            pk.token1 AS token,
            SUM(
                CEIL(
                    (- pbc.delta1 * 18446744073709551616::NUMERIC) / (18446744073709551616::NUMERIC - pk.fee)
                ) + pbc.delta1
            ) AS revenue
        FROM position_updates pu
            JOIN pool_balance_change pbc ON pu.chain_id = pbc.chain_id
            AND pu.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pk.id = pbc.pool_key_id
            JOIN event_keys ek ON ek.chain_id = pu.chain_id
            AND ek.sort_id = pu.pool_balance_change_id
            JOIN blocks b ON b.chain_id = ek.chain_id
            AND b.number = ek.block_number
        WHERE pu.chain_id = p_chain_id
            AND pbc.pool_key_id = p_pool_key_id
            AND DATE_TRUNC('hour', b.time) = v_hour
            AND pbc.delta1 < 0
            AND pk.fee <> 0
        GROUP BY pbc.pool_key_id,
            pk.token1
    ),
    total AS (
        SELECT *
        FROM rev0
        UNION ALL
        SELECT *
        FROM rev1
    )
SELECT pool_key_id,
    hour,
    token,
    SUM(revenue) AS revenue
FROM total
GROUP BY pool_key_id,
    hour,
    token;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION maintain_hourly_metrics_from_swaps() RETURNS TRIGGER AS $$
DECLARE v_chain_id bigint;
v_event_id bigint;
v_pool_key_id bigint;
v_token0 NUMERIC;
v_token1 NUMERIC;
v_hour timestamptz;
BEGIN IF TG_OP IN ('INSERT', 'UPDATE') THEN v_chain_id := NEW.chain_id;
v_event_id := NEW.pool_balance_change_id;
ELSE v_chain_id := OLD.chain_id;
v_event_id := OLD.pool_balance_change_id;
END IF;
SELECT pbc.pool_key_id,
    pk.token0,
    pk.token1,
    DATE_TRUNC('hour', b.time) INTO v_pool_key_id,
    v_token0,
    v_token1,
    v_hour
FROM pool_balance_change pbc
    JOIN pool_keys pk ON pk.id = pbc.pool_key_id
    JOIN event_keys ek ON ek.chain_id = pbc.chain_id
    AND ek.sort_id = pbc.event_id
    JOIN blocks b ON b.chain_id = ek.chain_id
    AND b.number = ek.block_number
WHERE pbc.chain_id = v_chain_id
    AND pbc.event_id = v_event_id;
IF NOT FOUND THEN RETURN NULL;
END IF;
PERFORM refresh_hourly_volume_by_token_for_hour(v_chain_id, v_pool_key_id, v_hour);
PERFORM refresh_hourly_price_data_for_hour(v_chain_id, v_token0, v_token1, v_hour);
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION maintain_hourly_volume_from_fees_accumulated() RETURNS TRIGGER AS $$
DECLARE v_chain_id bigint;
v_event_id bigint;
v_pool_key_id bigint;
v_hour timestamptz;
BEGIN IF TG_OP IN ('INSERT', 'UPDATE') THEN v_chain_id := NEW.chain_id;
v_event_id := NEW.pool_balance_change_id;
ELSE v_chain_id := OLD.chain_id;
v_event_id := OLD.pool_balance_change_id;
END IF;
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) INTO v_pool_key_id,
    v_hour
FROM pool_balance_change pbc
    JOIN event_keys ek ON ek.chain_id = pbc.chain_id
    AND ek.sort_id = pbc.event_id
    JOIN blocks b ON b.chain_id = ek.chain_id
    AND b.number = ek.block_number
WHERE pbc.chain_id = v_chain_id
    AND pbc.event_id = v_event_id;
IF NOT FOUND THEN RETURN NULL;
END IF;
PERFORM refresh_hourly_volume_by_token_for_hour(v_chain_id, v_pool_key_id, v_hour);
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change() RETURNS TRIGGER AS $$
DECLARE v_chain_id bigint;
v_event_id bigint;
v_pool_key_id bigint;
v_hour timestamptz;
BEGIN IF TG_OP IN ('INSERT', 'UPDATE') THEN v_chain_id := NEW.chain_id;
v_event_id := NEW.event_id;
ELSE v_chain_id := OLD.chain_id;
v_event_id := OLD.event_id;
END IF;
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) INTO v_pool_key_id,
    v_hour
FROM pool_balance_change pbc
    JOIN event_keys ek ON ek.chain_id = pbc.chain_id
    AND ek.sort_id = pbc.event_id
    JOIN blocks b ON b.chain_id = ek.chain_id
    AND b.number = ek.block_number
WHERE pbc.chain_id = v_chain_id
    AND pbc.event_id = v_event_id;
IF NOT FOUND THEN RETURN NULL;
END IF;
PERFORM refresh_hourly_tvl_delta_by_token_for_hour(v_chain_id, v_pool_key_id, v_hour);
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION maintain_hourly_revenue_from_position_updates() RETURNS TRIGGER AS $$
DECLARE v_chain_id bigint;
v_event_id bigint;
v_pool_key_id bigint;
v_hour timestamptz;
BEGIN IF TG_OP IN ('INSERT', 'UPDATE') THEN v_chain_id := NEW.chain_id;
v_event_id := NEW.pool_balance_change_id;
ELSE v_chain_id := OLD.chain_id;
v_event_id := OLD.pool_balance_change_id;
END IF;
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) INTO v_pool_key_id,
    v_hour
FROM pool_balance_change pbc
    JOIN event_keys ek ON ek.chain_id = pbc.chain_id
    AND ek.sort_id = pbc.event_id
    JOIN blocks b ON b.chain_id = ek.chain_id
    AND b.number = ek.block_number
WHERE pbc.chain_id = v_chain_id
    AND pbc.event_id = v_event_id;
IF NOT FOUND THEN RETURN NULL;
END IF;
PERFORM refresh_hourly_revenue_by_token_for_hour(v_chain_id, v_pool_key_id, v_hour);
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER maintain_hourly_metrics_from_swaps
AFTER
INSERT
    OR
UPDATE ON swaps FOR EACH ROW EXECUTE FUNCTION maintain_hourly_metrics_from_swaps();
CREATE TRIGGER maintain_hourly_volume_from_fees_accumulated
AFTER
INSERT
    OR
UPDATE ON fees_accumulated FOR EACH ROW EXECUTE FUNCTION maintain_hourly_volume_from_fees_accumulated();
CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_pool_balance_change
AFTER
INSERT
    OR
UPDATE ON pool_balance_change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change();
CREATE TRIGGER maintain_hourly_revenue_from_position_updates
AFTER
INSERT
    OR
UPDATE ON position_updates FOR EACH ROW EXECUTE FUNCTION maintain_hourly_revenue_from_position_updates();