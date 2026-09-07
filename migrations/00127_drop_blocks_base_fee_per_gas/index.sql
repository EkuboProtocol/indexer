-- Drop blocks.base_fee_per_gas. Nothing reads it.
--
-- It was added by 00062 to price gas into quotes. 00122 moved that job to
-- indexer_cursor.head_base_fee_per_gas, for the reason recorded there: the
-- quoter only ever wants the *head* block's base fee, and reading it from
-- `blocks` meant keeping a row per block alive purely so one column could be
-- read from the newest of them. Since 00122 the quoter reads indexer_cursor,
-- which is one row per chain and always present.
--
-- What was left behind is a write with no reader. Confirmed against the schema
-- rather than assumed:
--
--   * No view, materialized view, index, constraint or generated column
--     references it -- checked via pg_depend on the restored production
--     snapshot, not only by grepping the migrations.
--   * The only remaining SQL touching it is dao.ts insertBlock, which this
--     change stops writing, and 00122's one-time backfill, already applied.
--   * indexer_cursor.head_base_fee_per_gas is NOT affected and must stay; it
--     is the column the quoter actually reads.
--
-- The header-free EVM stream is what makes this worth doing now rather than
-- later. It derives blocks from eth_getLogs, which carries blockHash and
-- blockTimestamp but no base fee, so keeping the column would mean fetching a
-- header per block for a value nothing consumes -- exactly the per-block
-- request that change exists to remove.
--
-- Deploy: ALTER TABLE ... DROP COLUMN needs ACCESS EXCLUSIVE on blocks, which
-- the workers hold ROW EXCLUSIVE on for the length of each block transaction.
-- Migrations run PRE_DEPLOY with those workers live and all in one
-- transaction, so blocks is locked first and explicitly -- the same ordering
-- 00087, 00120 and 00123 use, and the one whose absence caused the deadlock in
-- #173. Deploy outside :00-:08 so the hourly cron jobs are not holding it.
--
-- NOTE: between this running and the new workers rolling, the old image is
-- still executing an INSERT that names this column, and will fail until it is
-- replaced. That is bounded and self-healing -- restart.sh restarts, the
-- cursor is durable, and indexing resumes exactly where it stopped, so no
-- event is missed -- but it is a real gap, and the alternative is to land the
-- code change one deploy ahead of this migration.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks;

ALTER TABLE blocks
    DROP COLUMN IF EXISTS base_fee_per_gas;
