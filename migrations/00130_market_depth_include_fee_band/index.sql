-- Market depth stops excluding a fee-width band either side of the price.
--
-- Since 00024 every depth band has been measured from one fee width out:
-- [tick - depth, tick - fee] below and [tick + fee, tick + depth] above. That
-- leaves out the ticks nearest the price, which is where concentrated liquidity
-- sits. Market depth is the denominator of every fee and reward APR the API
-- serves (getTopPairs, getTopPools, getBoostedFeesPools and the campaign view
-- from 00088), so pools concentrated inside that band showed inflated APRs.
-- Ethereum USDC/USDG (0.007% fee, about 70 ticks) is the worst case measured:
-- its ±0.106% band held $328,706 with the exclusion and $842,118 without it,
-- against a TVL of $842,433. So its APR showed 12.5% when the real figure is
-- about 4.9%. Pools whose liquidity is spread wider barely move, e.g. Ethereum
-- ETH/USDC goes from 95.4% to 94.7%.
--
-- The same filter also gave a pool no row at all for any band narrower than its
-- fee (AND fee_in_ticks < depth_in_ticks). A high-fee pool on a quiet pair then
-- had zero depth while its fees were still summed into the pair's numerator.
-- Every band is now emitted wherever it holds liquidity.
--
-- Everything else is 00126 verbatim: the median tick, the prefix-sum pass and
-- the lock_timeout reasoning. The cron job is not touched and keeps its
-- 10-minute schedule, so pool_market_depth_materialized picks the new values
-- up on its next run. It is not refreshed here: the migration runs in a
-- transaction, which rules out CONCURRENTLY, and a plain refresh would block
-- the API's reads of the materialized view for the ~10 s it takes.
--
-- Columns are unchanged. Values rise for pools with liquidity near the price.
-- The Market Depth column now means what it says: liquidity within ±X% of the
-- price.
SET LOCAL lock_timeout = '15min';

CREATE OR REPLACE VIEW pool_market_depth_view AS
WITH depth_percentages AS (SELECT (POWER(1.21, GENERATE_SERIES(0, 40)) * 0.00005)::FLOAT AS depth_percent),
     depth_bands AS (SELECT depth_percent,
                            FLOOR(LN(1::NUMERIC + depth_percent) / LN(1.000001))::INT4 AS depth_in_ticks
                     FROM depth_percentages),
     -- The most recent swap that left the pool with liquidity, per pool. Already
     -- fenced by its own LIMIT 1, and served by swaps (pool_key_id, event_id).
     last_pool_swaps AS (SELECT pk.pool_key_id,
                                ls.block_time
                         FROM pool_keys pk
                                  LEFT JOIN LATERAL (
                             SELECT s.block_time
                             FROM swaps s
                             WHERE s.pool_key_id = pk.pool_key_id
                               AND s.liquidity_after <> 0
                             ORDER BY s.event_id DESC
                             LIMIT 1
                             ) ls ON TRUE),
     -- Median tick over the hour ending at that swap. OFFSET 0 keeps this
     -- correlated so it can use swaps (pool_key_id, block_time).
     median_ticks AS (SELECT lps.pool_key_id,
                             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.tick_after) AS median_tick
                      FROM last_pool_swaps lps
                               JOIN LATERAL (
                          SELECT s.tick_after
                          FROM swaps s
                          WHERE s.pool_key_id = lps.pool_key_id
                            AND s.block_time BETWEEN (lps.block_time - INTERVAL '1 hour') AND lps.block_time
                            AND s.liquidity_after <> 0
                          OFFSET 0
                          ) s ON TRUE
                      WHERE lps.block_time IS NOT NULL
                      GROUP BY lps.pool_key_id),
     pool_params AS (SELECT pk.pool_key_id,
                            COALESCE(ROUND(mt.median_tick)::INT4, ps.tick) AS last_tick
                     FROM pool_keys pk
                              LEFT JOIN pool_states ps ON ps.pool_key_id = pk.pool_key_id
                              LEFT JOIN median_ticks mt ON mt.pool_key_id = pk.pool_key_id),
     -- Four edges per (pool, depth): the band below the current tick holds
     -- token1, the band above holds token0, and both start at the current tick.
     band_edges AS (SELECT pp.pool_key_id,
                           db.depth_percent,
                           e.side,
                           e.edge,
                           POWER(1.0000005::NUMERIC, e.tick) AS edge_price,
                           e.tick
                    FROM pool_params pp
                             CROSS JOIN depth_bands db
                             CROSS JOIN LATERAL (
                        VALUES ('below', 'lo', pp.last_tick - db.depth_in_ticks),
                               ('below', 'hi', pp.last_tick),
                               ('above', 'lo', pp.last_tick),
                               ('above', 'hi', pp.last_tick + db.depth_in_ticks)
                        ) AS e(side, edge, tick)
                    WHERE pp.last_tick IS NOT NULL),
     -- One ordered pass per pool. liquidity is what is active in
     -- [tick, next tick), so liquidity - delta is what was active in
     -- [previous tick, tick) -- the segment ending at this row.
     pool_ticks AS (SELECT t.pool_key_id,
                           t.tick,
                           t.net_liquidity_delta_diff                            AS delta,
                           SUM(t.net_liquidity_delta_diff) OVER w                AS liquidity,
                           POWER(1.0000005::NUMERIC, t.tick)                     AS price
                    FROM per_pool_per_tick_liquidity t
                    WINDOW w AS (PARTITION BY t.pool_key_id ORDER BY t.tick ROWS UNBOUNDED PRECEDING)),
     -- One POWER() per tick: the previous boundary's price is read off the
     -- previous row rather than raised again.
     pool_ticks_spanned AS (SELECT pool_key_id,
                                   tick,
                                   delta,
                                   liquidity,
                                   price,
                                   LAG(price) OVER (PARTITION BY pool_key_id ORDER BY tick) AS previous_price
                            FROM pool_ticks),
     -- Cumulative token amounts held below each tick boundary.
     pool_ticks_cumulative AS (SELECT pool_key_id,
                                      tick,
                                      liquidity,
                                      price,
                                      SUM(CASE
                                              WHEN previous_price IS NULL THEN 0
                                              ELSE (liquidity - delta) * (price - previous_price)
                                          END) OVER w AS cumulative1,
                                      SUM(CASE
                                              WHEN previous_price IS NULL THEN 0
                                              ELSE (liquidity - delta) *
                                                   (1::NUMERIC / previous_price - 1::NUMERIC / price)
                                          END) OVER w AS cumulative0
                               FROM pool_ticks_spanned
                               WINDOW w AS (PARTITION BY pool_key_id ORDER BY tick ROWS UNBOUNDED PRECEDING)),
     -- Interleave the edges with the tick boundaries so each edge can read the
     -- cumulative state of the last boundary at or before it. is_edge breaks the
     -- tie so an edge sitting exactly on a boundary sees that boundary.
     edges_and_ticks AS (SELECT pool_key_id, tick, 0 AS is_edge, liquidity, price, cumulative1, cumulative0,
                                NULL::FLOAT AS depth_percent, NULL::TEXT AS side, NULL::TEXT AS edge,
                                NULL::NUMERIC AS edge_price
                         FROM pool_ticks_cumulative
                         UNION ALL
                         SELECT pool_key_id, tick, 1, NULL, NULL, NULL, NULL,
                                depth_percent, side, edge, edge_price
                         FROM band_edges),
     segments AS (SELECT *,
                         SUM(1 - is_edge) OVER (PARTITION BY pool_key_id ORDER BY tick, is_edge
                             ROWS UNBOUNDED PRECEDING) AS segment
                  FROM edges_and_ticks),
     -- Broadcast each boundary's state to the edges that fall after it. An edge
     -- below a pool's first tick lands in segment 0, which holds no boundary, so
     -- its cumulative amounts are NULL and COALESCE to zero -- correct, there is
     -- no liquidity down there.
     edges_on_segment AS (SELECT pool_key_id, depth_percent, side, edge, edge_price, is_edge,
                                 MAX(liquidity) OVER s   AS boundary_liquidity,
                                 MAX(price) OVER s       AS boundary_price,
                                 MAX(cumulative1) OVER s AS boundary_cumulative1,
                                 MAX(cumulative0) OVER s AS boundary_cumulative0
                          FROM segments
                          WINDOW s AS (PARTITION BY pool_key_id, segment)),
     edge_amounts AS (SELECT pool_key_id,
                             depth_percent,
                             side,
                             edge,
                             COALESCE(boundary_cumulative1 +
                                      boundary_liquidity * (edge_price - boundary_price), 0) AS amount1,
                             COALESCE(boundary_cumulative0 +
                                      boundary_liquidity * (1::NUMERIC / boundary_price -
                                                            1::NUMERIC / edge_price), 0)     AS amount0
                      FROM edges_on_segment
                      WHERE is_edge = 1),
     band_amounts AS (SELECT pool_key_id,
                             depth_percent,
                             MAX(amount0) FILTER (WHERE side = 'above' AND edge = 'hi') -
                             MAX(amount0) FILTER (WHERE side = 'above' AND edge = 'lo') AS amount0,
                             MAX(amount1) FILTER (WHERE side = 'below' AND edge = 'hi') -
                             MAX(amount1) FILTER (WHERE side = 'below' AND edge = 'lo') AS amount1
                      FROM edge_amounts
                      GROUP BY pool_key_id, depth_percent)
SELECT pool_key_id,
       depth_percent,
       FLOOR(amount0) AS depth0,
       FLOOR(amount1) AS depth1
FROM band_amounts
-- The old definition emitted a row only where a tick segment overlapped the
-- band, which is exactly the case where at least one side is non-zero.
WHERE amount0 <> 0
   OR amount1 <> 0;
