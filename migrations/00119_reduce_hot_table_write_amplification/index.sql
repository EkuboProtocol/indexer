-- Three unrelated causes of avoidable CPU on the production database, measured
-- from pg_stat_statements over 2026-08-25 -> 2026-09-01 (7d10h) on
-- ekubo-db-nyc1 (gd-4vcpu-16gb, pg 18.6).

-- 1. refresh_computed_rewards_by_position runs 240x/day, not 4x/day.
--
-- 00071 set this job's schedule to '* */6 * * *'. The */6 is in the hour field,
-- so the minute field is left as "every minute" and the job fires 60 times an
-- hour during hours 0, 6, 12 and 18 -- not once every six hours. Each refresh
-- of incentives.computed_rewards_by_position_materialized (308 MB) takes ~100 s,
-- so the runs queue back to back and spill into the following hour. Measured
-- run counts per hour over 24 h: 51/9, 52/8, 58/2, 42/14 for the four windows.
--
-- That is 240 runs/day totalling 4 h 52 m of database time where 4 runs
-- totalling ~7 m were intended, and it accounts for ~10% of all database time
-- (the 39,048 s pg_temp_* entry in pg_stat_statements is REFRESH ...
-- CONCURRENTLY's internal diff, plus 7,180 s more in a second temp scan).
--
-- Rescheduled to '5 * * * *' rather than to the six-hourly cadence the broken
-- expression was reaching for. Reward periods land on hourly boundaries, so
-- hourly is the cadence that actually matches the data; minute 5 leaves four
-- minutes after compute_incentive_rewards (job 'compute_incentive_rewards',
-- minute 1) for the boundary blocks to be indexed before the matview reads
-- them. At 24 runs/day of ~100 s this is ~40 m/day, down from 4 h 52 m.
DO
$$
    DECLARE
        has_pg_cron BOOLEAN;
        job_id      INT;
    BEGIN
        SELECT EXISTS (SELECT 1
                       FROM pg_extension
                       WHERE extname = 'pg_cron')
        INTO has_pg_cron;

        IF NOT has_pg_cron THEN
            RAISE NOTICE 'pg_cron not installed; skipping computed rewards refresh reschedule.';
            RETURN;
        END IF;

        SELECT jobid
        INTO job_id
        FROM cron.job
        WHERE jobname = 'refresh_computed_rewards_by_position';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;

        PERFORM cron.schedule(
                'refresh_computed_rewards_by_position',
                '5 * * * *',
                'REFRESH MATERIALIZED VIEW CONCURRENTLY incentives.computed_rewards_by_position_materialized'
                );
    END;
$$;

-- 2. pool_states and pool_tvl are 15-20x bloated on ~5,000 real rows.
--
--     table         real rows   heap    dead tuples
--     pool_states       4,969   22 MB   40.8%
--     pool_tvl         ~4,900   15 MB   56.8%
--
-- Both take ~440,000 updates per week. HOT is already working on them (99.3% of
-- updates are HOT), but with the server default scale factor of 0.2 autovacuum
-- only triggers after ~20% of the table is dead, and at this write rate the
-- steady state sits far above that; autovacuum ran 253 and 337 times in the
-- window and still never brought them down. Neither table had any reloptions.
--
-- This matters because both are on the hot path of the all_pool_states_view
-- poll, which is the single largest consumer of database time at 34.4%
-- (2,208,760 calls, 62 ms mean, 100% buffer cache hit -- pure CPU). One
-- EXPLAIN (ANALYZE, BUFFERS) of that query on the largest chain touched 20,272
-- buffers, of which pool_states accounted for 10,328 and pool_tvl for 4,377.
--
-- The pool_tvl term is the bloat-driven one: 4,377 buffers to read 4,718 rows
-- collapses to a few hundred once the heap is the size its live rows justify.
-- The pool_states term is mostly not bloat -- 10,328 buffers over 3,256 index
-- probes is 3.17 buffers per probe, already about the floor for root + leaf +
-- heap -- so the honest expectation for the poll query is a 25-35% reduction,
-- not an order of magnitude.
--
-- NOTE: fillfactor applies only to pages written after a rewrite, and lowering
-- the scale factor makes autovacuum reclaim space in place but never returns
-- existing bloat to a smaller heap. This migration prevents the bloat from
-- coming back; it does not remove what is already there. See the operator step
-- in the README breaking changelog.
ALTER TABLE pool_states
    SET (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

ALTER TABLE pool_tvl
    SET (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

-- 3. erc20_tokens_latest_price gets 47.9M updates and zero HOT updates.
--
--     47,897,002 updates, 0 HOT, 7,360 live rows vs 749,363 dead (99% dead),
--     75 MB heap + 63 MB indexes, 10,617 autovacuum runs in the window.
--
-- A HOT update requires that no indexed column change. 00116 added an index on
-- valid_until, and recompute_erc20_token_latest_price writes valid_until on
-- every price refresh (it derives from the observation timestamp, so it moves
-- essentially every time). Every update therefore writes a new heap tuple plus
-- entries in both indexes, and autovacuum runs almost continuously without
-- keeping up -- that autovacuum load is itself a standing CPU cost.
--
-- The index earns very little. Its only consumer is
-- refresh_expired_erc20_token_latest_prices, which scans
-- "WHERE valid_until <= p_as_of FOR UPDATE SKIP LOCKED" over a 7,360-row
-- table; production shows 1,272,763 scans reading 5,493,381,022 tuples, i.e.
-- ~4,316 tuples per scan. It is selecting most of the table on each call, so
-- it is barely filtering, and FOR UPDATE forces the heap access anyway. On a
-- table this small a sequential scan is the better plan. Nothing in the API
-- filters on valid_until.
DROP INDEX IF EXISTS erc20_tokens_latest_price_valid_until_idx;

ALTER TABLE erc20_tokens_latest_price
    SET (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 80);
