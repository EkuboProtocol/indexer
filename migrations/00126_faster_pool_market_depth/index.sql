-- pool_market_depth_materialized is refreshed by pg_cron and its runs averaged
-- 35.5 s over the 7 days to 2026-09-06 (max 169.7 s). Two independent problems,
-- both fixed here without adding an index -- the index this needs already
-- exists (swaps_pool_key_id_block_time_ohlc_idx, added in 00118).
--
-- 1. The median-tick step read the whole swaps table. Its LATERAL subquery had
--    no LIMIT/OFFSET, so the planner pulled it up into a plain join, lost the
--    per-pool correlation, and estimated ~513k rows per pool for the one-hour
--    window. Against that estimate a hash join over a sequential scan of all
--    46M swaps beats 5,000 index probes, so that is what it chose: ~20 s and
--    ~11 GB of buffer reads per refresh, 96 times a day. Forcing the index with
--    enable_seqscan = off does NOT fix it -- measured, it ran past 170 s and
--    the statement timeout cut it off (the plan it picked instead was not
--    captured). The estimate is the problem, so the fix is to stop the pull-up:
--    OFFSET 0 is the standard optimisation fence and changes no semantics.
--    Measured on production, read-only: the median-tick step goes
--    from ~20 s to 0.29 s, and the refresh as a whole from 35 s to 14 s.
--    The ORDER BY block_time DESC in that subquery is dropped with it; it never
--    meant anything to PERCENTILE_CONT and only invited a sort.
--
-- 2. The tick math was quadratic in disguise. For every (pool, depth) pair it
--    intersected the depth band with every one of the pool's tick segments --
--    the largest pool has 1,763 -- so a pool cost ticks x 41 range
--    intersections. Rewritten here as one ordered pass per pool: prefix sums of
--    each segment's token amounts, then each depth band's amount is the
--    difference of the cumulative value at its two edges. The biggest pool goes
--    from 1,689 ms to 93 ms, and the whole refresh from 14 s to 10 s.
--
-- Measured end to end on production against the deployed definition, in one
-- snapshot so both saw identical data: 24.5 s -> 10.0 s for the same 69,150
-- rows, every value identical.
--
-- The rewrite is exact, not approximate. NUMERIC + - * are arbitrary-precision
-- and lossless; the only rounding is inside POWER() and the 1/p divisions, and
-- both definitions evaluate those at exactly the same tick values, so the
-- reassociated sums agree bit for bit. That is asserted against the old
-- definition in tests/migrations/faster-pool-market-depth.test.ts and was
-- verified row by row against production before this shipped. (An earlier draft
-- derived the edge prices as p(last) * p(offset) via exponent laws; that is one
-- extra rounding step and drifted ~1e-12 relative, so each edge price is
-- computed directly from its own tick instead.)
--
-- No LOCK TABLE blocks preamble, unlike 00120 and 00123: CREATE OR REPLACE VIEW
-- takes ACCESS EXCLUSIVE on the view alone and only ACCESS SHARE on the tables
-- it reads, which does not conflict with the workers' ROW EXCLUSIVE. The one
-- lock this can wait on is a concurrent cron refresh reading the view, hence
-- the bounded lock_timeout: past it the migration fails, App Platform rolls the
-- deploy back, and it is re-run by hand rather than left hanging.
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
                            COALESCE(ROUND(mt.median_tick)::INT4, ps.tick)                              AS last_tick,
                            CEIL(LOG(1::NUMERIC + (pk.fee / pk.fee_denominator)) / LOG(1.000001))::INT4 AS fee_in_ticks
                     FROM pool_keys pk
                              LEFT JOIN pool_states ps ON ps.pool_key_id = pk.pool_key_id
                              LEFT JOIN median_ticks mt ON mt.pool_key_id = pk.pool_key_id),
     -- Four edges per (pool, depth): the band below the current tick holds
     -- token1, the band above holds token0, and both start one fee width out.
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
                               ('below', 'hi', pp.last_tick - pp.fee_in_ticks),
                               ('above', 'lo', pp.last_tick + pp.fee_in_ticks),
                               ('above', 'hi', pp.last_tick + db.depth_in_ticks)
                        ) AS e(side, edge, tick)
                    WHERE pp.last_tick IS NOT NULL
                      AND pp.fee_in_ticks < db.depth_in_ticks),
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

-- Cadence. Computing the view is what a run costs; the CONCURRENTLY diff on top
-- is ~0.19 s, from the mean of its two internal pg_temp statements. So a run
-- goes from 25.1 s (24 h average) to ~10.5 s, and the job's daily CPU from
-- 2,410 s to 1,008 s if the schedule is left alone.
--
-- Half of that saving is spent on freshness here. Market depth drives the APR
-- denominators, the depth column and the pool page's depth card, and it lagged
-- a liquidity change by up to 15 minutes before the API's own 600 s cache; at
-- every 10 minutes that worst case goes from 25 to 20 minutes and the job still
-- costs 1,512 s/day, 37% below today. Every 5 minutes would cost ~3,000 s/day,
-- which is *more* than today (0.87% of the four vCPUs against 0.70%) -- worth
-- knowing before reaching for it, and a one-token change here.
--
-- Buffer traffic falls either way, and that is the bigger win: ~11 GB read from
-- disk per run becomes ~0.5 GB of cache hits, about a terabyte a day.
DO
$$
    DECLARE
        has_pg_cron BOOLEAN;
        job_id      INT;
    BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_pg_cron;

        IF NOT has_pg_cron THEN
            RAISE NOTICE 'pg_cron not installed; skipping market depth refresh reschedule.';
            RETURN;
        END IF;

        SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'refresh_pool_market_depth';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;

        PERFORM cron.schedule(
                'refresh_pool_market_depth',
                '*/10 * * * *',
                'REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth_materialized'
                );
    END
$$;
