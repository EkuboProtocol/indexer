DROP MATERIALIZED VIEW IF EXISTS incentives.campaign_rewards_overview_materialized;

CREATE MATERIALIZED VIEW incentives.campaign_rewards_overview_materialized AS
SELECT *
FROM incentives.campaign_rewards_overview;

CREATE UNIQUE INDEX ON incentives.campaign_rewards_overview_materialized (slug);

DO
$$
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
        RAISE NOTICE 'pg_cron not installed; skipping campaign rewards overview refresh job.';
        RETURN;
    END IF;

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_campaign_rewards_overview_materialized';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_campaign_rewards_overview_materialized',
        '*/5 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY incentives.campaign_rewards_overview_materialized'
    );
END;
$$;
