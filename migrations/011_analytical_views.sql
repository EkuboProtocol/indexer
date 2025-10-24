CREATE OR REPLACE VIEW last_24h_pool_stats_view AS (
        WITH volume AS (
            SELECT vbt.pool_key_id,
                SUM(
                    CASE
                        WHEN vbt.token = token0 THEN vbt.volume
                        ELSE 0
                    END
                ) AS volume0,
                SUM(
                    CASE
                        WHEN vbt.token = token1 THEN vbt.volume
                        ELSE 0
                    END
                ) AS volume1,
                SUM(
                    CASE
                        WHEN vbt.token = token0 THEN vbt.fees
                        ELSE 0
                    END
                ) AS fees0,
                SUM(
                    CASE
                        WHEN vbt.token = token1 THEN vbt.fees
                        ELSE 0
                    END
                ) AS fees1
            FROM hourly_volume_by_token vbt
                JOIN pool_keys ON vbt.pool_key_id = pool_keys.id
            WHERE hour >= NOW() - INTERVAL '24 hours'
            GROUP BY vbt.pool_key_id
        ),
        tvl_total AS (
            SELECT tbt.pool_key_id,
                SUM(
                    CASE
                        WHEN token = token0 THEN delta
                        ELSE 0
                    END
                ) AS tvl0,
                SUM(
                    CASE
                        WHEN token = token1 THEN delta
                        ELSE 0
                    END
                ) AS tvl1
            FROM hourly_tvl_delta_by_token tbt
                JOIN pool_keys pk ON tbt.pool_key_id = pk.id
            GROUP BY tbt.pool_key_id
        ),
        tvl_delta_24h AS (
            SELECT tbt.pool_key_id,
                SUM(
                    CASE
                        WHEN token = token0 THEN delta
                        ELSE 0
                    END
                ) AS tvl0,
                SUM(
                    CASE
                        WHEN token = token1 THEN delta
                        ELSE 0
                    END
                ) AS tvl1
            FROM hourly_tvl_delta_by_token tbt
                JOIN pool_keys pk ON tbt.pool_key_id = pk.id
            WHERE hour >= NOW() - INTERVAL '24 hours'
            GROUP BY tbt.pool_key_id
        )
        SELECT pool_keys.id,
            COALESCE(volume.volume0, 0) AS volume0_24h,
            COALESCE(volume.volume1, 0) AS volume1_24h,
            COALESCE(volume.fees0, 0) AS fees0_24h,
            COALESCE(volume.fees1, 0) AS fees1_24h,
            COALESCE(tvl_total.tvl0, 0) AS tvl0_total,
            COALESCE(tvl_total.tvl1, 0) AS tvl1_total,
            COALESCE(tvl_delta_24h.tvl0, 0) AS tvl0_delta_24h,
            COALESCE(tvl_delta_24h.tvl1, 0) AS tvl1_delta_24h
        FROM pool_keys
            LEFT JOIN volume ON volume.pool_key_id = pool_keys.id
            LEFT JOIN tvl_total ON pool_keys.id = tvl_total.pool_key_id
            LEFT JOIN tvl_delta_24h ON tvl_delta_24h.pool_key_id = pool_keys.id
    );
CREATE MATERIALIZED VIEW last_24h_pool_stats_materialized AS (
    SELECT pool_key_id,
        volume0_24h,
        volume1_24h,
        fees0_24h,
        fees1_24h,
        tvl0_total,
        tvl1_total,
        tvl0_delta_24h,
        tvl1_delta_24h
    FROM last_24h_pool_stats_view
);
CREATE UNIQUE INDEX idx_last_24h_pool_stats_materialized_pool_key_id ON last_24h_pool_stats_materialized USING btree (pool_key_id);
CREATE OR REPLACE VIEW token_pair_realized_volatility_view AS WITH times AS (
        SELECT blocks.time - INTERVAL '7 days' AS start_time,
            blocks.time AS end_time
        FROM blocks
        ORDER BY number DESC
        LIMIT 1
    ), prices AS (
        SELECT token0,
            token1,
            hour,
            LN(total / k_volume) AS log_price,
            ROW_NUMBER() OVER (
                PARTITION BY token0,
                token1
                ORDER BY hour
            ) AS row_no
        FROM hourly_price_data hpd,
            times t
        WHERE hpd.hour BETWEEN t.start_time AND t.end_time
            AND hpd.k_volume <> 0
    ),
    log_price_changes AS (
        SELECT token0,
            token1,
            log_price - LAG(log_price) OVER (
                PARTITION BY token0,
                token1
                ORDER BY row_no
            ) AS price_change,
            EXTRACT(
                HOURS
                FROM hour - LAG(hour) OVER (
                        PARTITION BY token0,
                        token1
                        ORDER BY row_no
                    )
            ) AS hours_since_last
        FROM prices p
        WHERE p.row_no != 1
    ),
    realized_volatility_by_pair AS (
        SELECT token0,
            token1,
            COUNT(1) AS observation_count,
            SQRT(SUM(price_change * price_change)) AS realized_volatility
        FROM log_price_changes lpc
        GROUP BY token0,
            token1
    )
SELECT token0,
    token1,
    realized_volatility,
    observation_count,
    int4(
        FLOOR(realized_volatility / LN(1.000001::NUMERIC))
    ) AS volatility_in_ticks
FROM realized_volatility_by_pair
WHERE realized_volatility IS NOT NULL;
CREATE MATERIALIZED VIEW token_pair_realized_volatility AS
SELECT *
FROM token_pair_realized_volatility_view;
CREATE UNIQUE INDEX idx_token_pair_realized_volatility_pair ON token_pair_realized_volatility (token0, token1);
CREATE OR REPLACE VIEW pool_market_depth_view AS WITH depth_percentages AS (
        SELECT (POWER(1.21, generate_series(0, 40)) * 0.00005)::float AS depth_percent
    ),
    last_swap_per_pair AS (
        SELECT token0,
            token1,
            max(pool_balance_change_id) AS last_swap_event_id
        FROM swaps s
            JOIN pool_balance_change_event pbc on s.chain_id = pbc.chain_id
            and s.pool_balance_change_id = pbc.event_id
            JOIN pool_keys pk ON pbc.pool_key_id = pk.id
        WHERE liquidity_after != 0
        GROUP BY token0,
            token1
    ),
    last_swap_time_per_pair AS (
        SELECT token0,
            token1,
            b.time
        FROM last_swap_per_pair ls
            JOIN event_keys ek ON ls.last_swap_event_id = ek.sort_id
            JOIN blocks b ON ek.block_number = b.number
    ),
    median_ticks AS (
        SELECT pk.token0,
            pk.token1,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY tick_after
            ) AS median_tick
        FROM swaps s
            JOIN pool_keys pk ON s.pool_key_id = pk.id
            JOIN event_keys ek ON s.pool_balance_change_id = ek.sort_id
            JOIN blocks b ON b.number = ek.block_number
            JOIN last_swap_time_per_pair lstpp ON pk.token0 = lstpp.token0
            AND pk.token1 = lstpp.token1
        WHERE b.time >= lstpp.time - interval '1 hour'
            AND liquidity_after != 0
        GROUP BY pk.token0,
            pk.token1
    ),
    pool_states AS (
        SELECT pk.id,
            pk.token0,
            pk.token1,
            dp.depth_percent,
            floor(ln(1::numeric + dp.depth_percent) / ln(1.000001))::int4 AS depth_in_ticks,
            ceil(
                log(
                    1::numeric + (pk.fee / 0x10000000000000000::numeric)
                ) / log(1.000001)
            )::int4 AS fee_in_ticks,
            round(mt.median_tick)::int4 AS last_tick
        FROM pool_keys pk
            CROSS JOIN depth_percentages dp
            LEFT JOIN median_ticks mt ON pk.token0 = mt.token0
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
CREATE MATERIALIZED VIEW pool_market_depth AS
SELECT *
FROM pool_market_depth_view;
CREATE UNIQUE INDEX idx_pool_market_depth ON pool_market_depth (pool_key_id, depth_percent);