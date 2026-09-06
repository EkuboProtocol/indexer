-- Three findings from the I/O sweep after 00124, measured on ekubo-db-nyc1 on
-- 2026-09-05 (cumulative counters since the 08-25 restart; live figures from a
-- 5-minute pg_statio delta).
--
-- 1. erc20_tokens_latest_price_by_source is the largest live source of disk
--    I/O on the instance: 1,031 MB read from disk in five minutes (~300 GB/day)
--    through 73,538 index scans. It holds 17,223 live rows in 978 MB -- 91,076
--    dead tuples, 85% of the table -- after 87M updates at 50% HOT with 16,648
--    autovacuum runs that never caught up. 00119 gave erc20_tokens_latest_price
--    fillfactor + an aggressive scale factor; this table, which the price sync
--    writes just as hard, got nothing. Every recompute_erc20_token_latest_price
--    (138 calls/s) walks its token's rows through pages that are mostly dead
--    tuples, and that cost is what shows up as 39k buffers per call on the
--    INSERT INTO erc20_tokens_usd_prices batches that fire it.
--
--    The reloptions below stop the bloat from coming back; they do not remove
--    what is there, because fillfactor only applies to pages written after a
--    rewrite and a smaller scale factor makes autovacuum reclaim space in
--    place, never shrink the heap. The one-time repack is an operator step
--    (VACUUM FULL cannot run inside this migration's transaction) -- see the
--    README changelog. At 17k live rows it takes seconds.
--
-- 2. Planner statistics on the big event tables are months out of date and
--    autoanalyze will not fix them. Statistics were reset at the 08-25
--    restart, and the default analyze threshold is 10% of the table, which for
--    these tables is hundreds of thousands of rows away:
--
--      table                         n_live_tup   actual rows
--      nonfungible_token_transfers       13,645     3,100,464
--      nonfungible_token_owners          10,751     2,347,419
--      protocol_fees_paid                   426     1,864,404
--      position_fees_collected            2,251     1,808,361
--
--    and hourly_volume_by_token / hourly_tvl_delta_by_token / hourly_price_data
--    show 0-1 autovacuum runs ever. The planner consequence is visible in the
--    positions-history query (WITH transfers ..., 28,048 calls at 909 ms, the
--    slowest API statement left): it estimates ONE row for chain_id = 4663 on
--    nonfungible_token_transfers, picks the (chain_id, block_number) index on
--    chain_id alone, and filters millions of rows by token_id. ANALYZE now,
--    and a 1% analyze threshold so it stays current.
--
-- 3. nonfungible_token_transfers has no index the positions-history query can
--    use. Its predicate is token_id = $1 AND chain_id = $2 AND (emitter = $3
--    OR nlm.locker = $4); the OR reaches into a LEFT JOINed table, so the
--    existing (chain_id, emitter, token_id, ...) index cannot serve it. A token
--    has ~10 transfers, so (chain_id, token_id) turns both of that query's
--    CTEs into a handful of probes.
--
-- Lock notes. ANALYZE and ALTER TABLE ... SET (reloptions) take SHARE UPDATE
-- EXCLUSIVE, which does not conflict with the workers' ROW EXCLUSIVE writes,
-- so they can run against live workers. CREATE INDEX takes SHARE, which does
-- block inserts into nonfungible_token_transfers (workers write it on every
-- position mint/transfer); it therefore goes FIRST, while this transaction
-- holds nothing else -- a worker mid-transaction can only make the index
-- build wait for it to finish, never form a cycle -- and the wait is the
-- ~3M-row build, seconds. No LOCK TABLE blocks: parking every worker for the
-- minute the ANALYZEs take would be a needless stall.

CREATE INDEX nonfungible_token_transfers_chain_id_token_id_idx
    ON nonfungible_token_transfers (chain_id, token_id);

-- 1. Stop the price-source table from bloating again.
ALTER TABLE erc20_tokens_latest_price_by_source
    SET (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

-- 2. Fresh statistics now, and a threshold that keeps them fresh.
DO
$$
    DECLARE
        t TEXT;
    BEGIN
        FOREACH t IN ARRAY ARRAY [
            'nonfungible_token_transfers',
            'nonfungible_token_owners',
            'protocol_fees_paid',
            'position_fees_collected',
            'position_updates',
            'pool_balance_change',
            'swaps',
            'hourly_volume_by_token',
            'hourly_tvl_delta_by_token',
            'hourly_price_data',
            'erc20_tokens_latest_price_by_source'
            ]
            LOOP
                EXECUTE FORMAT('ALTER TABLE %I SET (autovacuum_analyze_scale_factor = 0.01)', t);
                EXECUTE FORMAT('ANALYZE %I', t);
            END LOOP;

        ALTER TABLE incentives.computed_rewards SET (autovacuum_analyze_scale_factor = 0.01);
        ANALYZE incentives.computed_rewards;
    END;
$$;
