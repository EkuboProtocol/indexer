DROP VIEW IF EXISTS all_pool_states_view;

CREATE VIEW all_pool_states_view AS
SELECT pk.pool_key_id,
       pk.chain_id,
       pk.core_address,
       pk.token0,
       pk.token1,
       pk.fee,
       pk.tick_spacing,
       pk.pool_extension,
       pk.pool_config,
       pk.pool_config_type,
       pk.stableswap_center_tick,
       pk.stableswap_amplification,
       ps.sqrt_ratio,
       ps.liquidity,
       ps.tick,
       GREATEST(ps.last_event_id, tps.last_event_id)             AS last_event_id,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', ppptl.tick, 'd',
                                            ppptl.net_liquidity_delta_diff::TEXT) ORDER BY ppptl.tick)
        FROM per_pool_per_tick_liquidity ppptl
        WHERE ppptl.pool_key_id = pk.pool_key_id)                AS ticks,
       (COALESCE(pt.balance0, 0)
           / POWER(10::NUMERIC, COALESCE(t0.token_decimals, 0)))
           * COALESCE(p0.usd_price, 0) +
       (COALESCE(pt.balance1, 0)
           / POWER(10::NUMERIC, COALESCE(t1.token_decimals, 0)))
           * COALESCE(p1.usd_price, 0)                           AS tvl_usd,

       -- twamm state
       EXTRACT(EPOCH FROM tps.last_virtual_execution_time)::int8 AS twamm_last_virtual_execution_time,
       tps.token0_sale_rate                                      AS twamm_token0_sale_rate,
       tps.token1_sale_rate                                      AS twamm_token1_sale_rate,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', EXTRACT(EPOCH FROM tsrdm.time)::int8, 's0',
                                            tsrdm.net_sale_rate_delta0::TEXT,
                                            's1',
                                            tsrdm.net_sale_rate_delta1::TEXT) ORDER BY tsrdm.time)
        FROM twamm_sale_rate_deltas tsrdm
        WHERE tsrdm.pool_key_id = pk.pool_key_id
          AND time > last_virtual_execution_time)                AS twamm_orders,
       ops.last_snapshot_block_timestamp                         AS oracle_last_snapshot_block_timestamp,
       (mcpk.pool_key_id IS NOT NULL)                            AS is_mev_capture_pool,
       (sp.pool_key_id IS NOT NULL)                              AS is_spline_pool,
       (lops.pool_key_id IS NOT NULL)                            AS is_limit_order_pool
FROM pool_keys pk
         JOIN pool_states ps USING (pool_key_id)
         LEFT JOIN pool_tvl pt USING (pool_key_id)
         LEFT JOIN erc20_tokens t0 ON t0.chain_id = pk.chain_id AND t0.token_address = pk.token0
         LEFT JOIN LATERAL (SELECT value AS usd_price
                            FROM erc20_tokens_usd_prices up
                            WHERE up.chain_id = t0.chain_id
                              AND up.token_address = t0.token_address
                            ORDER BY up.timestamp DESC
                            LIMIT 1) AS p0 ON TRUE
         LEFT JOIN erc20_tokens t1 ON t1.chain_id = pk.chain_id AND t1.token_address = pk.token1
         LEFT JOIN LATERAL (SELECT value AS usd_price
                            FROM erc20_tokens_usd_prices up
                            WHERE up.chain_id = t1.chain_id
                              AND up.token_address = t1.token_address
                            ORDER BY up.timestamp DESC
                            LIMIT 1) AS p1 ON TRUE
         LEFT JOIN twamm_pool_states tps ON pk.pool_key_id = tps.pool_key_id
         LEFT JOIN oracle_pool_states ops ON ops.pool_key_id = pk.pool_key_id
         LEFT JOIN mev_capture_pool_keys mcpk ON mcpk.pool_key_id = pk.pool_key_id
         LEFT JOIN spline_pools sp ON sp.pool_key_id = pk.pool_key_id
         LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
-- only the following pool extensions are supported in our quoter
WHERE (pool_extension = 0 OR ops.last_snapshot_block_timestamp IS NOT NULL OR tps.last_event_id IS NOT NULL OR
       mcpk.pool_key_id IS NOT NULL OR sp.pool_key_id IS NOT NULL OR lops.pool_key_id IS NOT NULL);
