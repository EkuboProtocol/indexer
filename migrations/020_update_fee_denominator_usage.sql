CREATE OR REPLACE FUNCTION apply_hourly_volume_from_swap(
        p_chain_id bigint,
        p_pool_balance_change_id bigint,
        p_multiplier NUMERIC
    ) RETURNS void AS $$
DECLARE v_pool_key_id bigint;
v_hour timestamptz;
v_token NUMERIC;
v_volume NUMERIC;
v_fees NUMERIC;
BEGIN
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) AS hour,
    CASE
        WHEN pbc.delta0 >= 0 THEN pk.token0
        ELSE pk.token1
    END AS token,
    CASE
        WHEN pbc.delta0 >= 0 THEN pbc.delta0
        ELSE pbc.delta1
    END AS volume,
    COALESCE(
        FLOOR(
            (
                CASE
                    WHEN pbc.delta0 >= 0 THEN pbc.delta0
                    ELSE pbc.delta1
                END * pk.fee
            ) / NULLIF(pk.fee_denominator, 0)
        ),
        0
    ) AS fees INTO v_pool_key_id,
    v_hour,
    v_token,
    v_volume,
    v_fees
FROM pool_balance_change pbc
    JOIN event_keys ek USING (chain_id, event_id)
    JOIN blocks b USING (chain_id, block_number)
    JOIN pool_keys pk ON pk.id = pbc.pool_key_id
WHERE pbc.chain_id = p_chain_id
    AND pbc.event_id = p_pool_balance_change_id;
IF NOT FOUND THEN RETURN;
END IF;
v_volume := v_volume * p_multiplier;
v_fees := v_fees * p_multiplier;
PERFORM apply_hourly_volume_delta(
    v_pool_key_id,
    v_hour,
    v_token,
    v_volume,
    v_fees,
    p_multiplier,
    p_multiplier > 0
);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_tvl_from_pool_balance_change(
        p_chain_id bigint,
        p_event_id bigint,
        p_multiplier NUMERIC
    ) RETURNS void AS $$
DECLARE v_pool_key_id bigint;
v_hour timestamptz;
v_token0 NUMERIC;
v_token1 NUMERIC;
v_delta0 NUMERIC;
v_delta1 NUMERIC;
v_liquidity_delta NUMERIC;
v_fee NUMERIC;
v_fee_denominator NUMERIC;
BEGIN
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) AS hour,
    pk.token0,
    pk.token1,
    pbc.delta0,
    pbc.delta1,
    pu.liquidity_delta,
    pk.fee,
    pk.fee_denominator INTO v_pool_key_id,
    v_hour,
    v_token0,
    v_token1,
    v_delta0,
    v_delta1,
    v_liquidity_delta,
    v_fee,
    v_fee_denominator
FROM pool_balance_change pbc
    JOIN event_keys ek USING (chain_id, event_id)
    JOIN blocks b USING (chain_id, block_number)
    LEFT JOIN position_updates pu USING (chain_id, event_id)
    JOIN pool_keys pk ON pk.id = pbc.pool_key_id
WHERE pbc.chain_id = p_chain_id
    AND pbc.event_id = p_event_id;
IF NOT FOUND THEN RETURN;
END IF;
IF v_liquidity_delta IS NOT NULL
AND v_liquidity_delta < 0 THEN v_delta0 := CEIL(
    (v_delta0 * v_fee_denominator) / (v_fee_denominator - v_fee)
);
v_delta1 := CEIL(
    (v_delta1 * v_fee_denominator) / (v_fee_denominator - v_fee)
);
END IF;
v_delta0 := v_delta0 * p_multiplier;
v_delta1 := v_delta1 * p_multiplier;
PERFORM apply_hourly_tvl_delta(
    v_pool_key_id,
    v_hour,
    v_token0,
    v_delta0,
    p_multiplier > 0
);
PERFORM apply_hourly_tvl_delta(
    v_pool_key_id,
    v_hour,
    v_token1,
    v_delta1,
    p_multiplier > 0
);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_revenue_from_position_update(
        p_chain_id bigint,
        p_pool_balance_change_id bigint,
        p_multiplier NUMERIC
    ) RETURNS void AS $$
DECLARE v_pool_key_id bigint;
v_hour timestamptz;
v_token0 NUMERIC;
v_token1 NUMERIC;
v_revenue0 NUMERIC;
v_revenue1 NUMERIC;
BEGIN
SELECT pbc.pool_key_id,
    DATE_TRUNC('hour', b.time) AS hour,
    pk.token0,
    pk.token1,
    CASE
        WHEN pbc.delta0 < 0
        AND pk.fee <> 0 THEN CEIL(
            (- pbc.delta0 * pk.fee_denominator) / (pk.fee_denominator - pk.fee)
        ) + pbc.delta0
        ELSE 0
    END AS revenue0,
    CASE
        WHEN pbc.delta1 < 0
        AND pk.fee <> 0 THEN CEIL(
            (- pbc.delta1 * pk.fee_denominator) / (pk.fee_denominator - pk.fee)
        ) + pbc.delta1
        ELSE 0
    END AS revenue1 INTO v_pool_key_id,
    v_hour,
    v_token0,
    v_token1,
    v_revenue0,
    v_revenue1
FROM position_updates pu
    JOIN pool_balance_change pbc USING (chain_id, event_id)
    JOIN event_keys ek USING (chain_id, event_id)
    JOIN blocks b USING (chain_id, block_number)
    JOIN pool_keys pk ON pk.id = pbc.pool_key_id
WHERE pu.chain_id = p_chain_id
    AND pu.event_id = p_pool_balance_change_id;
IF NOT FOUND THEN RETURN;
END IF;
IF v_revenue0 <> 0 THEN PERFORM apply_hourly_revenue_delta(
    v_pool_key_id,
    v_hour,
    v_token0,
    v_revenue0 * p_multiplier,
    p_multiplier > 0
);
END IF;
IF v_revenue1 <> 0 THEN PERFORM apply_hourly_revenue_delta(
    v_pool_key_id,
    v_hour,
    v_token1,
    v_revenue1 * p_multiplier,
    p_multiplier > 0
);
END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW pool_market_depth_view AS WITH depth_percentages AS (
    SELECT (POWER(1.21, generate_series(0, 40)) * 0.00005)::float AS depth_percent
),
last_swap_per_pair AS (
    SELECT s.chain_id,
        token0,
        token1,
        max(event_id) AS event_id
    FROM swaps s
        JOIN pool_balance_change pbc USING (chain_id, event_id)
        JOIN pool_keys pk ON pbc.pool_key_id = pk.id
    WHERE liquidity_after != 0
    GROUP BY s.chain_id,
        token0,
        token1
),
last_swap_time_per_pair AS (
    SELECT chain_id,
        token0,
        token1,
        b.time
    FROM last_swap_per_pair ls
        JOIN event_keys ek USING (chain_id, event_id)
        JOIN blocks b USING (chain_id, block_number)
),
median_ticks AS (
    SELECT pk.chain_id,
        pk.token0,
        pk.token1,
        percentile_cont(0.5) WITHIN GROUP (
            ORDER BY tick_after
        ) AS median_tick
    FROM swaps s
        JOIN pool_balance_change pbc USING (chain_id, event_id)
        JOIN event_keys ek USING (chain_id, event_id)
        JOIN blocks b USING (chain_id, block_number)
        JOIN pool_keys pk ON pbc.pool_key_id = pk.id
        JOIN last_swap_time_per_pair lstpp ON pk.chain_id = lstpp.chain_id
        AND pk.token0 = lstpp.token0
        AND pk.token1 = lstpp.token1
    WHERE b.time >= lstpp.time - interval '1 hour'
        AND liquidity_after != 0
    GROUP BY pk.chain_id,
        pk.token0,
        pk.token1
),
pool_states AS (
    SELECT pk.id as pool_key_id,
        pk.token0,
        pk.token1,
        dp.depth_percent,
        floor(ln(1::numeric + dp.depth_percent) / ln(1.000001))::int4 AS depth_in_ticks,
        ceil(
            log(
                1::numeric + (pk.fee / pk.fee_denominator)
            ) / log(1.000001)
        )::int4 AS fee_in_ticks,
        round(mt.median_tick)::int4 AS last_tick
    FROM pool_keys pk
        CROSS JOIN depth_percentages dp
        LEFT JOIN median_ticks mt ON pk.chain_id = mt.chain_id
        AND pk.token0 = mt.token0
        AND pk.token1 = mt.token1
),
pool_ticks AS (
    SELECT pool_key_id,
        sum(net_liquidity_delta_diff) OVER (
            PARTITION BY ppptliv.pool_key_id
            ORDER BY ppptliv.tick ROWS UNBOUNDED PRECEDING
        ) AS liquidity,
        tick AS tick_start,
        lead(tick) OVER (
            PARTITION BY ppptliv.pool_key_id
            ORDER BY ppptliv.tick
        ) AS tick_end
    FROM per_pool_per_tick_liquidity_incremental_view ppptliv
),
depth_liquidity_ranges AS (
    SELECT pt.pool_key_id,
        pt.liquidity,
        ps.depth_percent,
        int4range(
            ps.last_tick - ps.depth_in_ticks,
            ps.last_tick - ps.fee_in_ticks
        ) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_below,
        int4range(
            ps.last_tick + ps.fee_in_ticks,
            ps.last_tick + ps.depth_in_ticks
        ) * int4range(pt.tick_start, pt.tick_end) AS overlap_range_above
    FROM pool_ticks pt
        JOIN pool_states ps ON pt.pool_key_id = ps.pool_key_id
    WHERE liquidity != 0
        AND ps.fee_in_ticks < ps.depth_in_ticks
),
token_amounts_by_pool AS (
    SELECT pool_key_id,
        depth_percent,
        floor(
            sum(
                liquidity * (
                    power(1.0000005::numeric, upper(overlap_range_below)) - power(1.0000005::numeric, lower(overlap_range_below))
                )
            )
        ) AS amount1,
        floor(
            sum(
                liquidity * (
                    (
                        1::numeric / power(1.0000005::numeric, lower(overlap_range_above))
                    ) - (
                        1::numeric / power(1.0000005::numeric, upper(overlap_range_above))
                    )
                )
            )
        ) AS amount0
    FROM depth_liquidity_ranges
    WHERE NOT isempty(overlap_range_below)
        OR NOT isempty(overlap_range_above)
    GROUP BY pool_key_id,
        depth_percent
),
total_depth AS (
    SELECT pool_key_id,
        depth_percent,
        coalesce(sum(amount0), 0) AS depth0,
        coalesce(sum(amount1), 0) AS depth1
    FROM token_amounts_by_pool tabp
    GROUP BY pool_key_id,
        depth_percent
)
SELECT td.pool_key_id,
    td.depth_percent AS depth_percent,
    td.depth0,
    td.depth1
FROM total_depth td;

REFRESH MATERIALIZED VIEW pool_market_depth;
