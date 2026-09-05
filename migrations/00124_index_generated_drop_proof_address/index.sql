-- Index incentives.generated_drop_proof for the lookups the API actually does.
--
-- Measured on ekubo-db-nyc1 on 2026-09-05.
--
-- The table is 3,075,770 rows / 2.6 GB with the Merkle proofs stored inline,
-- and it has exactly one index: its primary key (drop_id, id). The claims
-- endpoint (GET /claims/:address, queries.ts "WITH funded_roots ...") filters
-- it by address:
--
--     FROM incentives.generated_drop_proof gdp JOIN ... WHERE address = $1
--
-- With no index on address that is a sequential scan of the whole table per
-- request. pg_stat_statements since 2026-08-25: 17,378 calls, 1,180 ms mean,
-- 269,158 blocks read from disk per call -- 35 TB of physical reads from a
-- 2.6 GB table, a 20% cache-hit ratio, and the single largest source of I/O
-- on the instance by an order of magnitude. A second variant of the same
-- query (460 calls, 10.9 s mean) and the drop-totals aggregate
--
--     SELECT drop_id, SUM(amount) FROM incentives.generated_drop_proof GROUP BY drop_id
--
-- (54 calls, 2.3 s, 255,679 disk blocks each) scan it the same way. The live
-- plan at the time of writing:
--
--     Nested Loop
--       -> Parallel Seq Scan on generated_drop_proof gdp  (cost=0.00..340642.64)
--            Filter: (address = ...)
--
-- An address appears in at most one row per drop it was included in, so an
-- index on address turns each claims request into a handful of index probes
-- and heap fetches. The second index makes the per-drop totals an index-only
-- scan over (drop_id, amount) instead of a scan of the proof-laden heap.
--
-- Beyond latency, this is what stops the table from evicting everything else
-- from the buffer cache: 35 TB of reads through a 3.2 GB shared_buffers is why
-- computed_rewards and swaps show poor hit ratios too.
--
-- Deploy: CREATE INDEX takes SHARE on generated_drop_proof, which only the
-- out-of-band drop generator writes -- no indexer worker touches it -- so
-- there is no lock-ordering exposure with the workers and no LOCK TABLE
-- blocks here (that pattern is for migrations touching worker-written
-- tables). The build is ~3M rows; expect tens of seconds.

CREATE INDEX generated_drop_proof_address_idx
    ON incentives.generated_drop_proof (address);

CREATE INDEX generated_drop_proof_drop_id_amount_idx
    ON incentives.generated_drop_proof (drop_id, amount);

-- Column statistics were never collected on this table (n_live_tup showed
-- 346 against 3.1M rows); give the planner real numbers for address.
ANALYZE incentives.generated_drop_proof;
