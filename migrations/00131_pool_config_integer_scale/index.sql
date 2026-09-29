-- 00060 and 00065 computed pool_config with POWER(2::NUMERIC, n), which returns a
-- numeric with fractional digits, so the rows they wrote are stored as e.g.
-- '…6184842.0000000'. The values are integers; only the scale is wrong. Readers
-- that parse the text form as an integer (the API's BigInt) reject them, which
-- is why /poolKeys for the v2 core returned 500. Rows written by the indexer
-- already have scale 0.
--
-- Plain UPDATE: ROW EXCLUSIVE on pool_keys does not conflict with the workers,
-- which only insert into it, so there is no need to park them.
UPDATE pool_keys
SET pool_config = trunc(pool_config)
WHERE scale(pool_config) > 0;
