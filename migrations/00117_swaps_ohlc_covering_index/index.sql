-- The pair OHLC route (getPairOhlcHistory) locates swaps by
-- (pool_key_id, block_time) but projects delta0, delta1 and event_id, none of
-- which the existing index carries. Every qualifying row therefore costs a
-- heap fetch, and a single pool's swaps are scattered across the whole 11 GB
-- table because inserts interleave all chains and pools.
--
-- Measured on a 15 day window for one pair (2641 rows): the current index
-- touches 1963 buffers of which 1789 are random reads, 164 ms cold. The same
-- rows read index-only touch 32 buffers, 2.7 ms. The INCLUDE payload averages
-- 28.4 bytes/row.
--
-- Same key columns as the index it replaces, so every existing consumer is
-- served identically; a btree scans backward at no cost, which covers the
-- pool_market_depth view's ORDER BY block_time DESC (00056). That view selects
-- only event_id and block_time, so it gains an index-only scan too.
CREATE INDEX IF NOT EXISTS swaps_pool_key_id_block_time_ohlc_idx
    ON swaps (pool_key_id, block_time)
    INCLUDE (event_id, delta0, delta1);

DROP INDEX IF EXISTS swaps_pool_key_id_block_time_idx;

-- Index-only scans skip the heap only for pages marked all-visible. swaps is
-- append-only, but the server defaults (insert_scale_factor 0.2) mean an
-- insert-vacuum only every ~9M rows at current size, so the newest pages --
-- exactly the ones every chart request reads -- would never be all-visible and
-- would keep doing heap fetches.
ALTER TABLE swaps SET (
    autovacuum_vacuum_insert_scale_factor = 0.0,
    autovacuum_vacuum_insert_threshold = 20000
);
