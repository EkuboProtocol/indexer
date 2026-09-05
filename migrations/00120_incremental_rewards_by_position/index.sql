-- Park every indexer worker before taking any other lock. THIS MUST STAY THE
-- FIRST STATEMENT OF THIS FILE.
--
-- 00120, 00121 and 00122 run inside one transaction (scripts/migrate.ts), and
-- between them they take table locks on ~20 relations one at a time -- index
-- builds, trigger creation, the matview swap, ALTERs on blocks and
-- indexer_cursor -- while 14 workers keep running short write transactions
-- that touch the same relations in whatever order the block's events dictate.
-- That is a textbook lock-ordering deadlock, and it happened on the first
-- deploy attempt (2026-09-05 02:44:02, 40P01): the migration held
-- indexer_cursor from ADD COLUMN and wanted blocks for DISABLE TRIGGER; a
-- worker held blocks from its insert and wanted indexer_cursor for its cursor
-- write. Postgres killed the migration 137 s in and DO rolled the deploy back.
--
-- Every worker transaction's first statement is the reorg-protection
-- DELETE FROM blocks, which needs ROW EXCLUSIVE on blocks. SHARE ROW EXCLUSIVE
-- conflicts with that but not with the ACCESS SHARE readers take, so once this
-- lock is held every worker is parked at its first statement holding nothing,
-- and no cycle is possible for the rest of the transaction. Acquiring it may
-- itself wait a little for in-flight worker transactions to finish -- they
-- hold nothing the migration wants yet, so that wait is bounded by one block's
-- processing. The hourly delete_old_empty_blocks() job holds blocks for
-- minutes; deploy outside the top of the hour.
--
-- lock_timeout is a backstop against waiting forever behind something idle in
-- transaction; a deploy that hits it fails cleanly and is rerun.
SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

-- Replace the DeFi Spring rewards matview with a table maintained incrementally
-- by triggers, and drop the hourly refresh entirely.
--
-- Measured on ekubo-db-nyc1 (gd-4vcpu-16gb, pg 18.6) on 2026-09-04, from
-- cron.job_run_details and pg_stat_statements.
--
-- 00119 fixed the cadence of 'refresh_computed_rewards_by_position' -- the
-- '* */6 * * *' expression was firing 240 times a day instead of 4 -- and
-- rescheduled it to '5 * * * *'. That removed the duplicate runs. It did not
-- make a single run any cheaper, and a single run is not cheap:
--
--     day           runs   avg      max
--     2026-09-02       9   71.9 s   85.7 s
--     2026-09-03      24   82.4 s  146.0 s
--     2026-09-04      19  158.2 s  187.4 s
--
--     = 3,488 s/day, the second largest cron job on the instance.
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY has no change detection. Every run
-- re-executes the view's defining query in full -- aggregating all 40,032,777
-- rows of incentives.computed_rewards (3.8 GB heap, 9.2 GB with its index) --
-- materializes all 1,465,501 result rows into a temp table, FULL JOINs that
-- against the existing 308 MB matview on every column to compute a diff, and
-- applies it. The cost is a function of how big the inputs are, not of how
-- much actually changed, and what actually changes is ~205 rows a day.
--
-- Both aggregates are SUM, which is distributive, so the answer can be
-- maintained forward instead of recomputed. The write rates make that
-- obviously affordable: over the 10-day window computed_rewards took 2,067
-- inserts and no updates or deletes, generated_drop_reward_periods 126
-- inserts, campaign_reward_periods 90 inserts and 90 updates, and campaigns
-- none at all. Every reward period ends at midnight (270 of 270 over the last
-- 30 days, at a flat 9/day), so even those arrive in one batch a day.
--
-- So this trades an hourly 145 s recompute for ~205 single-row upserts a day,
-- and the table is exactly correct at every instant rather than up to an hour
-- stale. Cron job 'refresh_computed_rewards_by_position' is removed.
--
-- Two details that constrain the design, both found by measuring rather than
-- reading the view definition:
--
-- 1. reward_amount can be zero: 259 of the 40,032,777 rows are, and 6 groups
--    sum to exactly zero. So "total_reward_amount = 0" does NOT mean "no
--    underlying rows", and a group cannot be deleted on that basis without
--    silently dropping those 6 from the API. The table therefore carries
--    source_row_count and a group is removed only when it reaches zero.
--
-- 2. generated_drop_reward_periods has PRIMARY KEY (drop_id,
--    campaign_reward_period_id), which on its own would let one period sit in
--    several drops and make the matview's LEFT JOIN multiply that period's
--    rows. It cannot, because idx_generated_drop_reward_periods_crp_id is a
--    separate UNIQUE index on campaign_reward_period_id alone -- so at most
--    one drop per period, and the matview was never at risk. (That index is
--    easy to miss: being an index rather than a constraint, it does not show
--    up in pg_constraint.)
--
--    The trigger path below still tests for the drop with EXISTS and acts only
--    on the 0 <-> 1 transition. Under the unique index those are equivalent to
--    the simpler formulations, and they stay correct if it is ever dropped.

CREATE TABLE incentives.computed_rewards_by_position
(
    campaign_id           BIGINT  NOT NULL,
    -- Projected from campaigns, functionally dependent on campaign_id, kept
    -- here because the old matview exposed it and the API selects it.
    core_address          NUMERIC NOT NULL,
    locker                NUMERIC NOT NULL,
    salt                  NUMERIC NOT NULL,
    total_reward_amount   NUMERIC NOT NULL,
    pending_reward_amount NUMERIC NOT NULL,
    -- How many incentives.computed_rewards rows are behind this group. The
    -- group exists exactly while this is > 0; see note 1 above.
    source_row_count      BIGINT  NOT NULL,
    PRIMARY KEY (campaign_id, locker, salt)
);

-- Applies one row's contribution to its group. p_amount and p_rows are signed:
-- an insert passes (+amount, +1), a delete passes (-amount, -1), and an update
-- is applied as a delete of the old row followed by an insert of the new one,
-- which is also what makes a change of campaign_reward_period_id, locker or
-- salt move the contribution between groups correctly.
CREATE OR REPLACE FUNCTION incentives.rewards_by_position_apply(
    p_campaign_reward_period_id BIGINT,
    p_locker NUMERIC,
    p_salt NUMERIC,
    p_amount NUMERIC,
    p_rows BIGINT
)
    RETURNS VOID
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_campaign_id  BIGINT;
    v_core_address NUMERIC;
    v_pending      NUMERIC;
BEGIN
    SELECT crp.campaign_id, c.core_address
    INTO v_campaign_id, v_core_address
    FROM incentives.campaign_reward_periods crp
             JOIN incentives.campaigns c ON c.id = crp.campaign_id
    WHERE crp.id = p_campaign_reward_period_id;

    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION 'campaign reward period % has no campaign', p_campaign_reward_period_id;
    END IF;

    -- A row counts toward pending exactly while its period has no generated
    -- drop. EXISTS rather than a join, so a period appearing in several drops
    -- is still counted once (see note 2 at the top).
    v_pending := CASE
                     WHEN EXISTS (SELECT 1
                                  FROM incentives.generated_drop_reward_periods g
                                  WHERE g.campaign_reward_period_id = p_campaign_reward_period_id)
                         THEN 0
                     ELSE p_amount
        END;

    INSERT INTO incentives.computed_rewards_by_position AS t
    (campaign_id, core_address, locker, salt,
     total_reward_amount, pending_reward_amount, source_row_count)
    VALUES (v_campaign_id, v_core_address, p_locker, p_salt,
            p_amount, v_pending, p_rows)
    ON CONFLICT (campaign_id, locker, salt) DO UPDATE
        SET total_reward_amount   = t.total_reward_amount + EXCLUDED.total_reward_amount,
            pending_reward_amount = t.pending_reward_amount + EXCLUDED.pending_reward_amount,
            source_row_count      = t.source_row_count + EXCLUDED.source_row_count,
            core_address          = EXCLUDED.core_address;

    DELETE
    FROM incentives.computed_rewards_by_position
    WHERE campaign_id = v_campaign_id
      AND locker = p_locker
      AND salt = p_salt
      AND source_row_count = 0;
END;
$$;

CREATE OR REPLACE FUNCTION incentives.trg_computed_rewards_by_position()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    -- Row level rather than statement level with transition tables, because
    -- the volume does not justify the complexity: ~205 rows a day, and the
    -- largest single statement in normal operation is
    -- compute_rewards_for_period_v1 clearing one period. If a bulk recompute
    -- of every period is ever needed, disable these triggers and use
    -- incentives.rebuild_rewards_by_position() instead of firing 40M of them.
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        PERFORM incentives.rewards_by_position_apply(
                OLD.campaign_reward_period_id, OLD.locker, OLD.salt, -OLD.reward_amount, -1);
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM incentives.rewards_by_position_apply(
                NEW.campaign_reward_period_id, NEW.locker, NEW.salt, NEW.reward_amount, 1);
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER computed_rewards_maintain_by_position
    AFTER INSERT OR UPDATE OR DELETE
    ON incentives.computed_rewards
    FOR EACH ROW
EXECUTE FUNCTION incentives.trg_computed_rewards_by_position();

-- Generating a drop for a period flips every one of that period's rows from
-- pending to not pending at once; deleting one (generated_drop cascades here)
-- flips them back.
CREATE OR REPLACE FUNCTION incentives.trg_drop_reward_periods_by_position()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_period    BIGINT;
    v_remaining BIGINT;
    v_sign      NUMERIC;
BEGIN
    v_period := CASE WHEN TG_OP = 'INSERT' THEN NEW.campaign_reward_period_id
                     ELSE OLD.campaign_reward_period_id END;

    SELECT COUNT(*)
    INTO v_remaining
    FROM incentives.generated_drop_reward_periods g
    WHERE g.campaign_reward_period_id = v_period;

    -- This is an AFTER trigger, so v_remaining already reflects the change.
    -- Only the 0 <-> 1 transition alters what is pending: a second drop row
    -- for a period that already had one changes nothing, and removing one of
    -- two leaves the period still dropped.
    IF TG_OP = 'INSERT' AND v_remaining <> 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' AND v_remaining <> 0 THEN
        RETURN NULL;
    END IF;

    v_sign := CASE WHEN TG_OP = 'INSERT' THEN -1 ELSE 1 END;

    UPDATE incentives.computed_rewards_by_position t
    SET pending_reward_amount = t.pending_reward_amount + v_sign * s.amount
    FROM (SELECT crp.campaign_id,
                 cr.locker,
                 cr.salt,
                 SUM(cr.reward_amount) AS amount
          FROM incentives.computed_rewards cr
                   JOIN incentives.campaign_reward_periods crp ON crp.id = cr.campaign_reward_period_id
          WHERE cr.campaign_reward_period_id = v_period
          GROUP BY 1, 2, 3) s
    WHERE t.campaign_id = s.campaign_id
      AND t.locker = s.locker
      AND t.salt = s.salt;

    RETURN NULL;
END;
$$;

CREATE TRIGGER drop_reward_periods_maintain_by_position
    AFTER INSERT OR DELETE
    ON incentives.generated_drop_reward_periods
    FOR EACH ROW
EXECUTE FUNCTION incentives.trg_drop_reward_periods_by_position();

-- core_address is projected into the table, so it has to follow its source.
-- campaigns has taken no writes at all in the measurement window; this exists
-- so the denormalisation cannot silently go stale.
CREATE OR REPLACE FUNCTION incentives.trg_campaign_core_address_by_position()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    UPDATE incentives.computed_rewards_by_position
    SET core_address = NEW.core_address
    WHERE campaign_id = NEW.id;

    RETURN NULL;
END;
$$;

CREATE TRIGGER campaigns_maintain_by_position_core_address
    AFTER UPDATE OF core_address
    ON incentives.campaigns
    FOR EACH ROW
    WHEN (OLD.core_address IS DISTINCT FROM NEW.core_address)
EXECUTE FUNCTION incentives.trg_campaign_core_address_by_position();

-- Full recompute. This is the definition the triggers are maintaining, kept in
-- one place so drift can be repaired and so verify below has something to
-- compare against. Needed after anything the triggers deliberately do not
-- cover -- in particular moving a reward period to a different campaign, which
-- would re-key rows and which nothing does today.
CREATE OR REPLACE FUNCTION incentives.rebuild_rewards_by_position()
    RETURNS BIGINT
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_rows BIGINT;
BEGIN
    PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXT('rebuild_rewards_by_position')::BIGINT);

    DELETE FROM incentives.computed_rewards_by_position;

    INSERT INTO incentives.computed_rewards_by_position
    (campaign_id, core_address, locker, salt,
     total_reward_amount, pending_reward_amount, source_row_count)
    SELECT c.id,
           c.core_address,
           cr.locker,
           cr.salt,
           SUM(cr.reward_amount),
           -- FILTER matching nothing yields NULL, not 0, and that happens for
           -- every group whose periods have all been dropped -- which is most
           -- of them (29,701 of 29,710 periods have a drop).
           COALESCE(SUM(cr.reward_amount)
                    FILTER (WHERE NOT EXISTS (SELECT 1
                                              FROM incentives.generated_drop_reward_periods g
                                              WHERE g.campaign_reward_period_id = crp.id)), 0),
           COUNT(*)
    FROM incentives.campaign_reward_periods crp
             JOIN incentives.campaigns c ON c.id = crp.campaign_id
             JOIN incentives.computed_rewards cr ON cr.campaign_reward_period_id = crp.id
    GROUP BY c.id, c.core_address, cr.locker, cr.salt;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RETURN v_rows;
END;
$$;

-- Returns the groups where the maintained table disagrees with a fresh
-- aggregate, so drift is detectable rather than silent. Empty means correct.
-- This costs about what the old hourly refresh did, so run it occasionally
-- (daily or weekly out of band), not on the read path.
CREATE OR REPLACE FUNCTION incentives.verify_rewards_by_position()
    RETURNS TABLE
            (
                campaign_id     BIGINT,
                locker          NUMERIC,
                salt            NUMERIC,
                stored_total    NUMERIC,
                expected_total  NUMERIC,
                stored_pending  NUMERIC,
                expected_pending NUMERIC
            )
    LANGUAGE sql
AS
$$
WITH expected AS (SELECT c.id AS campaign_id,
                         cr.locker,
                         cr.salt,
                         SUM(cr.reward_amount) AS total,
                         COALESCE(SUM(cr.reward_amount)
                                  FILTER (WHERE NOT EXISTS (SELECT 1
                                                            FROM incentives.generated_drop_reward_periods g
                                                            WHERE g.campaign_reward_period_id = crp.id)), 0) AS pending
                  FROM incentives.campaign_reward_periods crp
                           JOIN incentives.campaigns c ON c.id = crp.campaign_id
                           JOIN incentives.computed_rewards cr ON cr.campaign_reward_period_id = crp.id
                  GROUP BY c.id, cr.locker, cr.salt)
SELECT COALESCE(e.campaign_id, t.campaign_id),
       COALESCE(e.locker, t.locker),
       COALESCE(e.salt, t.salt),
       t.total_reward_amount,
       e.total,
       t.pending_reward_amount,
       e.pending
FROM expected e
         FULL JOIN incentives.computed_rewards_by_position t
                   ON t.campaign_id = e.campaign_id AND t.locker = e.locker AND t.salt = e.salt
WHERE t.campaign_id IS NULL
   OR e.campaign_id IS NULL
   OR t.total_reward_amount IS DISTINCT FROM e.total
   OR t.pending_reward_amount IS DISTINCT FROM e.pending;
$$;

-- Seed from the base tables rather than from the matview's current contents,
-- so a stale matview is not baked in. This is the one expensive statement in
-- the migration -- the same ~145 s aggregate the hourly job was running -- and
-- it happens once. It is in the same transaction as the triggers above, so
-- there is no window in which a write could be missed.
SELECT incentives.rebuild_rewards_by_position();

-- The API selects from the matview by name. Swap it for a view over the table
-- so that keeps working unchanged, atomically within this transaction, while
-- the real object gets an honest name. The view exposes exactly the matview's
-- columns, so source_row_count stays an implementation detail.
DROP MATERIALIZED VIEW incentives.computed_rewards_by_position_materialized;

CREATE VIEW incentives.computed_rewards_by_position_materialized AS
SELECT campaign_id,
       core_address,
       locker,
       salt,
       total_reward_amount,
       pending_reward_amount
FROM incentives.computed_rewards_by_position;

-- Nothing left to refresh.
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
            RAISE NOTICE 'pg_cron not installed; skipping rewards refresh unschedule.';
            RETURN;
        END IF;

        SELECT jobid
        INTO job_id
        FROM cron.job
        WHERE jobname = 'refresh_computed_rewards_by_position';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;
    END;
$$;
