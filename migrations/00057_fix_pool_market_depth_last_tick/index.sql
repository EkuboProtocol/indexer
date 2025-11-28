CREATE OR REPLACE VIEW pool_market_depth_view AS
WITH depth_percentages AS (SELECT (POWER(1.21, GENERATE_SERIES(0, 40)) * 0.00005)::FLOAT AS depth_percent),
     last_pool_swaps AS (SELECT pk.pool_key_id,
                                pk.chain_id,
                                pk.token0,
                                pk.token1,
                                ls.event_id,
                                ls.block_time
                         FROM pool_keys pk
                                  LEFT JOIN LATERAL (
                             SELECT s.event_id, s.block_time
                             FROM swaps s
                             WHERE s.pool_key_id = pk.pool_key_id
                               AND s.liquidity_after <> 0
                             ORDER BY s.event_id DESC
                             LIMIT 1
                             ) ls ON TRUE),
     median_ticks AS (SELECT lps.pool_key_id,
                             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.tick_after) AS median_tick
                      FROM last_pool_swaps lps
                               JOIN LATERAL (
                          SELECT tick_after
                          FROM swaps s
                          WHERE s.pool_key_id = lps.pool_key_id
                            AND s.block_time BETWEEN (lps.block_time - INTERVAL '1 hour') AND lps.block_time
                            AND s.liquidity_after <> 0
                          ORDER BY s.block_time DESC
                          ) s ON TRUE
                      WHERE lps.block_time IS NOT NULL
                      GROUP BY lps.pool_key_id),
     pool_last_ticks AS (SELECT pk.pool_key_id,
                                pk.token0,
                                pk.token1,
                                pk.fee,
                                pk.fee_denominator,
                                COALESCE(ROUND(mt.median_tick)::int4, ps.tick) AS last_tick
                         FROM pool_keys pk
                                  LEFT JOIN pool_states ps ON ps.pool_key_id = pk.pool_key_id
                                  LEFT JOIN median_ticks mt ON pk.pool_key_id = mt.pool_key_id),
     pool_states AS (SELECT plt.pool_key_id,
                            plt.token0,
                            plt.token1,
                            dp.depth_percent,
                            FLOOR(LN(1::NUMERIC + dp.depth_percent) / LN(1.000001))::int4                 AS depth_in_ticks,
                            CEIL(LOG(1::NUMERIC + (plt.fee / plt.fee_denominator)) / LOG(1.000001))::int4 AS fee_in_ticks,
                            plt.last_tick
                     FROM pool_last_ticks plt
                              CROSS JOIN depth_percentages dp
                     WHERE plt.last_tick IS NOT NULL),
     pool_ticks AS (SELECT pool_key_id,
                           SUM(net_liquidity_delta_diff) OVER (
                               PARTITION BY ppptliv.pool_key_id
                               ORDER BY ppptliv.tick ROWS UNBOUNDED PRECEDING
                               )                                                                    AS liquidity,
                           tick                                                                     AS tick_start,
                           LEAD(tick) OVER (PARTITION BY ppptliv.pool_key_id ORDER BY ppptliv.tick) AS tick_end
                    FROM per_pool_per_tick_liquidity ppptliv),
     depth_liquidity_ranges AS (SELECT pt.pool_key_id,
                                       pt.liquidity,
                                       ps.depth_percent,
                                       INT4RANGE(ps.last_tick - ps.depth_in_ticks, ps.last_tick - ps.fee_in_ticks)
                                           * INT4RANGE(pt.tick_start, pt.tick_end) AS overlap_range_below,
                                       INT4RANGE(ps.last_tick + ps.fee_in_ticks, ps.last_tick + ps.depth_in_ticks)
                                           * INT4RANGE(pt.tick_start, pt.tick_end) AS overlap_range_above
                                FROM pool_ticks pt
                                         JOIN pool_states ps ON pt.pool_key_id = ps.pool_key_id
                                WHERE pt.liquidity <> 0
                                  AND ps.fee_in_ticks < ps.depth_in_ticks),
     token_amounts_by_pool AS (SELECT pool_key_id,
                                      depth_percent,
                                      FLOOR(SUM(
                                              liquidity * (
                                                  POWER(1.0000005::NUMERIC, UPPER(overlap_range_below))
                                                      - POWER(1.0000005::NUMERIC, LOWER(overlap_range_below))
                                                  )
                                            )) AS amount1,
                                      FLOOR(SUM(
                                              liquidity * (
                                                  (1::NUMERIC / POWER(1.0000005::NUMERIC, LOWER(overlap_range_above)))
                                                      -
                                                  (1::NUMERIC / POWER(1.0000005::NUMERIC, UPPER(overlap_range_above)))
                                                  )
                                            )) AS amount0
                               FROM depth_liquidity_ranges
                               WHERE NOT ISEMPTY(overlap_range_below)
                                  OR NOT ISEMPTY(overlap_range_above)
                               GROUP BY pool_key_id, depth_percent),
     total_depth AS (SELECT pool_key_id,
                            depth_percent,
                            COALESCE(SUM(amount0), 0) AS depth0,
                            COALESCE(SUM(amount1), 0) AS depth1
                     FROM token_amounts_by_pool
                     GROUP BY pool_key_id, depth_percent)
SELECT td.pool_key_id,
       td.depth_percent,
       td.depth0,
       td.depth1
FROM total_depth td;

REFRESH MATERIALIZED VIEW pool_market_depth_materialized;
