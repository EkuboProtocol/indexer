CREATE OR REPLACE FUNCTION incentives.compute_pending_reward_periods()
    RETURNS INTEGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_period RECORD;
    v_rows   INTEGER;
    v_total  INTEGER := 0;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext('compute_pending_reward_periods')::bigint) THEN
        RAISE NOTICE 'compute_pending_reward_periods already running; skipping.';
        RETURN 0;
    END IF;

    FOR v_period IN
        SELECT crp.id         AS reward_period_id,
               c.slug         AS campaign_slug,
               c.chain_id     AS chain_id,
               crp.end_time   AS period_end
        FROM incentives.campaign_reward_periods crp
                 JOIN incentives.campaigns c ON crp.campaign_id = c.id
        WHERE crp.rewards_last_computed_at IS NULL
          AND crp.end_time <= (
            SELECT MAX(block_time)
            FROM blocks
            WHERE chain_id = c.chain_id
        )
        ORDER BY crp.end_time, crp.id
    LOOP
        BEGIN
            v_rows := incentives.compute_rewards_for_period_v1(v_period.reward_period_id);
            v_total := v_total + v_rows;
            RAISE NOTICE 'Computed incentive rewards for period % (campaign %, chain %) inserted % rows',
                v_period.reward_period_id, v_period.campaign_slug, v_period.chain_id, v_rows;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'Failed to compute rewards for period % (campaign %, chain %): %',
                    v_period.reward_period_id, v_period.campaign_slug, v_period.chain_id, SQLERRM;
        END;
    END LOOP;

    RETURN v_total;
END;
$$; 

DO $$
DECLARE
    has_pg_cron BOOLEAN;
    job_id      INT;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'pg_cron'
    )
    INTO has_pg_cron;

    IF NOT has_pg_cron THEN
        RAISE NOTICE 'pg_cron not installed; skipping incentives job scheduling.';
        RETURN;
    END IF;

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'compute_incentive_rewards';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'compute_incentive_rewards',
        '1 * * * *',
        'SELECT incentives.compute_pending_reward_periods();'
    );
END;
$$;
