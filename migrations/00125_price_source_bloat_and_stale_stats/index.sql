-- Two findings from the I/O sweep after 00124, measured on ekubo-db-nyc1 on
-- 2026-09-05 (cumulative counters since the 08-25 restart; live figures from a
-- 5-minute pg_statio delta). This migration takes no lock that conflicts with
-- the workers: ALTER TABLE ... SET (reloptions) and ANALYZE take SHARE UPDATE
-- EXCLUSIVE, which is compatible with their ROW EXCLUSIVE writes. It is also
-- why there is no LOCK TABLE blocks here -- that pattern is for DDL that would
-- otherwise queue against a worker mid-transaction.
--
-- 1. erc20_tokens_latest_price_by_source is the largest live source of disk
--    I/O on the instance: 1,031 MB read from disk in five minutes (~300 GB/day)
--    through 73,538 index scans. It holds 17,223 live rows in 978 MB (594 MB
--    heap, 384 MB index), i.e. ~6 MB of live data. Every
--    recompute_erc20_token_latest_price (138 calls/s) walks its token's rows
--    through pages that are almost entirely dead tuples, and that cost is
--    what shows up as 39k buffers per call on the INSERT INTO
--    erc20_tokens_usd_prices batches that fire it.
--
--    Where the bloat came from matters for what fixes it. Autovacuum is not
--    behind on this table -- it fires on essentially every naptime (17,457
--    runs in 17,555 minutes) and dead tuples sit at a minute or two of
--    updates. The heap is the residue of the 2026-09-01 incident 00119
--    describes: a worker blocked 22 hours inside pg_advisory_lock pinned the
--    vacuum horizon, and at ~90 updates/s that is ~7M dead tuples vacuum could
--    not remove until the session ended -- roughly the heap size measured.
--    Vacuum reclaims that space in place; nothing shrinks the heap except a
--    rewrite, which is the operator step in the README (pg_repack, not VACUUM
--    FULL: the latter takes ACCESS EXCLUSIVE and freezes the price sync's
--    reads as well as its writes).
--
--    fillfactor = 70 is set here so that, once repacked, updates have room to
--    stay HOT (the table's only index is its primary key, so they are
--    eligible). The vacuum scale factor matches the sibling table's setting
--    from 00119; at this update rate the default threshold is crossed every
--    naptime anyway, so it changes little -- what would actually prevent a
--    repeat is not letting a session pin the horizon for a day, i.e.
--    lock_timeout/statement_timeout on the indexer role and an alert on
--    age(backend_xmin). That is a separate change.
--
-- 2. Planner statistics on four large event tables are months out of date and
--    autoanalyze will not fix them. Statistics were reset at the 08-25
--    restart, and the default analyze threshold is 10% of the table -- for
--    these, hundreds of thousands of rows away:
--
--      table                         n_live_tup   actual rows
--      nonfungible_token_transfers       13,645     3,100,464
--      nonfungible_token_owners          10,751     2,347,419
--      protocol_fees_paid                   426     1,864,404
--      position_fees_collected            2,251     1,808,361
--
--    The consequence is visible in the positions-history query (WITH
--    transfers ..., 28,048 calls at 909 ms, the slowest API statement left).
--    Its predicate is token_id = $1 AND chain_id = $2 AND (emitter = $3 OR
--    nlm.locker = $4). With current statistics the planner serves that from
--    the existing (chain_id, emitter, token_id, ...) index -- PostgreSQL 18
--    skip-scans over emitter -- in a few probes. With stale statistics it
--    estimates ONE row for the whole chain, picks the (chain_id, block_number)
--    index on chain_id alone, and filters millions of rows by token_id. ANALYZE
--    alone repairs the plan; no new index is needed (one was tried and dropped
--    in review: it saved ~14 buffers a call against the skip scan and nothing
--    at all under stale statistics, which is the actual failure mode).
--
--    ANALYZE now, and a 1% analyze threshold so it stays current. Only these
--    four: the hourly_* tables already autoanalyze every few days at the
--    default threshold, and swaps / computed_rewards had accurate estimates.

-- 1. Price-source table: HOT headroom for after the repack.
ALTER TABLE erc20_tokens_latest_price_by_source
    SET (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);

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
            'position_fees_collected'
            ]
            LOOP
                EXECUTE FORMAT('ALTER TABLE %I SET (autovacuum_analyze_scale_factor = 0.01)', t);
                EXECUTE FORMAT('ANALYZE %I', t);
            END LOOP;
    END;
$$;
