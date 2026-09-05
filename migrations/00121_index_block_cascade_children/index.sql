-- Index the (chain_id, block_number) foreign keys into blocks, so deleting a
-- block stops sequentially scanning its ve33 children.
--
-- Measured on ekubo-db-nyc1 (gd-4vcpu-16gb, pg 18.6) on 2026-09-04.
--
-- delete_old_empty_blocks() is the single most expensive thing on the
-- instance, and it has been growing since the new chain indexers landed on
-- 2026-08-01:
--
--     day           runs  avg      max
--     2026-07-31      24   12.9 s   24.8 s
--     2026-08-01      24   22.9 s   46.8 s
--     2026-08-05      24   55.9 s   80.6 s
--     2026-08-11      24  112.1 s  213.8 s
--     2026-08-18      24  158.6 s  234.4 s
--     2026-08-25      24  188.5 s  424.6 s
--     2026-09-01      24  263.6 s  437.4 s
--     2026-09-02      24  366.0 s  740.8 s
--     2026-09-04      19  256.4 s  284.9 s
--
--     = 6,003 s/day, ~20x what it cost five weeks ago.
--
-- The block writes themselves are not the problem. Over the 10-day window
-- INSERT INTO blocks was 17,221 s of 615,060 s of top-level execution time
-- (0.48% of a 4-vCPU box) across 4.7M inserts, and the reorg-protection
-- DELETE ... WHERE chain_id = $1 AND block_number >= $2 was 7,402 s (0.21%).
-- Writing blocks is cheap. Deleting them is not, for two compounding reasons:
--
-- 1. public.blocks has 43 foreign keys pointing at it, every one of them
--    ON DELETE CASCADE. Each deleted block row runs all 43 cascade lookups.
--    4,291,310 block rows were deleted in the window (2,298,518 by the hourly
--    empty-block sweep, 1,992,792 by reorg protection), so the cascade
--    machinery executed 184,559,526 times for 56,140 s of CPU.
--
-- 2. 13 of those 43 child tables have no index whose leading columns are
--    (chain_id, block_number), so their cascade lookup is a sequential scan.
--    Three of the 13 have grown real data:
--
--      child table                    heap     seq scans   cascade time
--      ve33_pool_fees_accounted       109 MB     470,226      27,035 s
--      ve33_pool_emissions_accrued    105 MB     460,437      25,420 s
--      ve33_rewards_claimed            11 MB     460,430       2,299 s
--
--    That is 54,754 s, or 97.5% of all cascade cost, from three missing
--    indexes. The remaining 40 children, which are indexed, cost 1,386 s
--    combined -- 4 microseconds per lookup against 6.3 ms for the scans.
--
-- The two effects multiply, which is why the curve above is superlinear
-- rather than flat: the number of block deletions per hour is set by the
-- indexers, and the cost of each deletion is set by how big the ve33 tables
-- have grown. Both have been rising since 2026-08-01.
--
-- 85% of the blocks written are empty (no events at all): over one hour, 13
-- chains wrote 15,177 blocks of which 12,916 had num_events = 0. Those are
-- inserted, kept for a day, then deleted by the sweep -- and each one pays all
-- 43 cascade lookups on the way out despite never having had a child row.
-- Not persisting them at all would remove the work rather than speed it up,
-- but that is an indexer change with reorg-detection consequences, so this
-- migration only makes the deletions cheap.
--
-- CREATE INDEX is deliberately not CONCURRENTLY: scripts/migrate.ts runs the
-- whole migration set inside one transaction (postgres-shift calls
-- sql.begin), and CREATE INDEX CONCURRENTLY cannot run in a transaction
-- block. The two large tables are ~109 MB and ~105 MB, so the build is
-- seconds, but it does take a SHARE lock that blocks writes to them for the
-- duration. See the README breaking changelog.

-- The three that are actually costing something today.
CREATE INDEX IF NOT EXISTS ve33_pool_fees_accounted_chain_id_block_number_idx
    ON ve33_pool_fees_accounted (chain_id, block_number);

CREATE INDEX IF NOT EXISTS ve33_pool_emissions_accrued_chain_id_block_number_idx
    ON ve33_pool_emissions_accrued (chain_id, block_number);

CREATE INDEX IF NOT EXISTS ve33_rewards_claimed_chain_id_block_number_idx
    ON ve33_rewards_claimed (chain_id, block_number);

-- The other ten. These are empty or nearly so today, so they cost almost
-- nothing yet -- but they are the same latent bug, and indexing them while
-- they are small is free. ve33_stake_changed (4,502 rows) and
-- ve33_vote_weight_applied (2,845 rows) are already accumulating.
CREATE INDEX IF NOT EXISTS ve33_stake_changed_chain_id_block_number_idx
    ON ve33_stake_changed (chain_id, block_number);

CREATE INDEX IF NOT EXISTS ve33_vote_weight_applied_chain_id_block_number_idx
    ON ve33_vote_weight_applied (chain_id, block_number);

CREATE INDEX IF NOT EXISTS ve33_pool_fees_claimed_chain_id_block_number_idx
    ON ve33_pool_fees_claimed (chain_id, block_number);

CREATE INDEX IF NOT EXISTS ve33_emissions_scheduled_chain_id_block_number_idx
    ON ve33_emissions_scheduled (chain_id, block_number);

CREATE INDEX IF NOT EXISTS boosted_fees_donated_chain_id_block_number_idx
    ON boosted_fees_donated (chain_id, block_number);

CREATE INDEX IF NOT EXISTS boosted_fees_events_chain_id_block_number_idx
    ON boosted_fees_events (chain_id, block_number);

CREATE INDEX IF NOT EXISTS auction_completed_chain_id_block_number_idx
    ON auction_completed (chain_id, block_number);

CREATE INDEX IF NOT EXISTS auction_boost_started_chain_id_block_number_idx
    ON auction_boost_started (chain_id, block_number);

CREATE INDEX IF NOT EXISTS auction_funds_added_chain_id_block_number_idx
    ON auction_funds_added (chain_id, block_number);

CREATE INDEX IF NOT EXISTS auction_creator_proceeds_collected_chain_id_block_number_idx
    ON auction_creator_proceeds_collected (chain_id, block_number);
