-- Make the hourly DeFi Spring rewards matview refresh cost nothing when
-- nothing changed.
--
-- Measured on ekubo-db-nyc1 (gd-4vcpu-16gb, pg 18.6) on 2026-09-04, from
-- cron.job_run_details and pg_stat_statements.
--
-- 00119 fixed the cadence of 'refresh_computed_rewards_by_position' -- the
-- '* */6 * * *' expression was firing 240 times a day instead of 4 -- and
-- rescheduled it to '5 * * * *'. That removed the duplicate runs. It did not
-- make a single run any cheaper, and a single run is not cheap:
--
--     job 57, REFRESH MATERIALIZED VIEW CONCURRENTLY
--     incentives.computed_rewards_by_position_materialized
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
-- rows of incentives.computed_rewards (3.8 GB heap, 9.2 GB with its index)
-- joined to campaign_reward_periods and LEFT JOINed to
-- generated_drop_reward_periods -- materializes all 1,465,501 result rows into
-- a temp table, FULL JOINs that against the existing 308 MB matview on every
-- column to compute a diff, and then applies that diff. The cost is a function
-- of how big the inputs are, not of how much actually changed.
--
-- What actually changes is almost nothing:
--
--   * All 29,593 reward periods present in computed_rewards have already
--     ended (max end_time = 2026-09-04 00:00, and no period ended in the two
--     hours before this was measured). Rewards for an ended period are
--     immutable in normal operation.
--   * ~205 new reward rows land per day, i.e. ~8 per hour.
--
-- So each hourly run re-reads ~40M immutable rows to discover ~8 new ones:
-- roughly 5 million rows scanned per row that changed, 23 hours out of 24 for
-- no output difference at all.
--
-- This migration makes the refresh conditional on one of its inputs actually
-- having been written.
--
-- Expected saving, and why it is 23 runs and not some of them. Every reward
-- period ends on a midnight boundary -- over the last 30 days all 270 periods
-- have extract(hour from end_time) = 0, at a flat 9 periods per day -- and
-- compute_pending_reward_periods only computes periods whose end_time has
-- passed. So every write to computed_rewards happens in the 00:01 run, and
-- the 00:05 refresh is the only one of the day with anything to do. Writes to
-- the other three inputs are correspondingly rare: over the 10-day window,
-- campaigns took 0 writes, campaign_reward_periods 90 inserts and 90 updates
-- (the rewards_last_computed_at stamp, which rides along with the same 00:01
-- run), and generated_drop_reward_periods 126 inserts.
--
-- That makes this 24 refreshes/day -> 1, or 3,488 s/day -> ~145 s/day.
--
-- Note that a statement-level trigger fires even when the statement matches no
-- rows, so this errs toward refreshing: it can refresh when nothing really
-- changed, but it cannot skip when something did. That is the direction the
-- error has to point.
--
-- Why a trigger-set flag and not a watermark. The obvious guard is to compare
-- max(campaign_reward_period_id) and count(*) against the values at the last
-- refresh. That is wrong here: incentives.compute_rewards_for_period_v1 starts
-- with
--
--     DELETE FROM incentives.computed_rewards WHERE campaign_reward_period_id = $1
--
-- and re-inserts, so recomputing an existing period -- which is exactly what
-- that function is for -- can leave both the row count and the max id
-- unchanged while every reward amount underneath differs. A guard that missed
-- that would serve stale reward totals indefinitely, which is far worse than
-- spending 145 s an hour. A statement-level trigger fires for any write from
-- any path, including that delete/re-insert, so it cannot miss one.

CREATE TABLE incentives.rewards_mv_refresh_state
(
    id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- TRUE when an input has been written since the last completed refresh.
    stale                    BOOLEAN     NOT NULL DEFAULT TRUE,
    last_refresh_finished_at TIMESTAMPTZ,
    last_refresh_duration    INTERVAL,
    refresh_count            BIGINT      NOT NULL DEFAULT 0,
    skip_count               BIGINT      NOT NULL DEFAULT 0
);

-- Seeded stale so the first run after deployment always refreshes.
INSERT INTO incentives.rewards_mv_refresh_state (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION incentives.mark_rewards_by_position_stale()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    -- Statement level, so this is one cheap update per writing statement, not
    -- per row. The "AND NOT stale" predicate matters: once the flag is already
    -- set the UPDATE matches no row, takes no row lock, and so concurrent
    -- writers do not serialise behind each other on this table.
    UPDATE incentives.rewards_mv_refresh_state
    SET stale = TRUE
    WHERE id
      AND NOT stale;

    RETURN NULL;
END;
$$;

-- Every relation the matview's defining query reads. campaigns and
-- campaign_reward_periods change rarely, but they do change the output
-- (core_address is projected, and period membership decides which computed
-- rewards are aggregated at all), so they get the same treatment.
DO
$$
    DECLARE
        input_table TEXT;
    BEGIN
        FOREACH input_table IN ARRAY ARRAY [
            'computed_rewards',
            'generated_drop_reward_periods',
            'campaign_reward_periods',
            'campaigns'
            ]
            LOOP
                -- TRUNCATE cannot be combined with row events in a single
                -- CREATE TRIGGER, so it needs its own.
                EXECUTE FORMAT(
                        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON incentives.%I '
                            || 'FOR EACH STATEMENT EXECUTE FUNCTION incentives.mark_rewards_by_position_stale()',
                        input_table || '_mark_rewards_mv_stale',
                        input_table
                        );

                EXECUTE FORMAT(
                        'CREATE TRIGGER %I AFTER TRUNCATE ON incentives.%I '
                            || 'FOR EACH STATEMENT EXECUTE FUNCTION incentives.mark_rewards_by_position_stale()',
                        input_table || '_mark_rewards_mv_stale_truncate',
                        input_table
                        );
            END LOOP;
    END;
$$;

CREATE OR REPLACE FUNCTION incentives.refresh_rewards_by_position_if_stale(
    p_max_staleness INTERVAL DEFAULT INTERVAL '24 hours'
)
    RETURNS BOOLEAN
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_should_refresh BOOLEAN;
    v_started        TIMESTAMPTZ;
BEGIN
    -- p_max_staleness is a backstop, not the mechanism: it forces a refresh
    -- once a day even if the flag was somehow never set (a restore that
    -- bypassed the triggers, a manual disable). It bounds the blast radius of
    -- a missed signal to one day at the cost of one extra refresh.
    UPDATE incentives.rewards_mv_refresh_state
    SET stale = FALSE
    WHERE id
      AND (
        stale
            OR last_refresh_finished_at IS NULL
            OR last_refresh_finished_at < NOW() - p_max_staleness
        )
    RETURNING TRUE
    INTO v_should_refresh;

    IF v_should_refresh IS NULL THEN
        UPDATE incentives.rewards_mv_refresh_state
        SET skip_count = skip_count + 1
        WHERE id;

        RETURN FALSE;
    END IF;

    -- Ordering note. The flag is cleared before the refresh reads anything.
    -- Under READ COMMITTED each statement takes its own snapshot, so the
    -- REFRESH below sees at least everything the clearing UPDATE saw. A writer
    -- committing after that snapshot is blocked on this row's lock until this
    -- transaction commits and then sets the flag again, so its change is
    -- picked up by the next run rather than being swallowed by this one.
    -- Clearing afterwards instead would lose exactly that write.
    v_started := CLOCK_TIMESTAMP();

    REFRESH MATERIALIZED VIEW CONCURRENTLY
        incentives.computed_rewards_by_position_materialized;

    UPDATE incentives.rewards_mv_refresh_state
    SET last_refresh_finished_at = NOW(),
        last_refresh_duration    = CLOCK_TIMESTAMP() - v_started,
        refresh_count            = refresh_count + 1
    WHERE id;

    RETURN TRUE;
END;
$$;

-- Point the existing hourly job at the guard. The schedule stays at minute 5,
-- for the reason 00119 gives: compute_incentive_rewards runs at minute 1 and
-- the boundary blocks need to be indexed before the matview reads them.
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
            RAISE NOTICE 'pg_cron not installed; skipping rewards refresh reschedule.';
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
                'SELECT incentives.refresh_rewards_by_position_if_stale()'
                );
    END;
$$;
