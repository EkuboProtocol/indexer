CREATE OR REPLACE FUNCTION safe_refresh_mv(viewname TEXT)
    RETURNS VOID
    LANGUAGE plpgsql
AS
$$
DECLARE
    ok        BOOLEAN;
    parts     TEXT[];
    qualified TEXT;
BEGIN
    parts := REGEXP_SPLIT_TO_ARRAY(viewname, '\.');
    IF ARRAY_LENGTH(parts, 1) = 2 THEN
        qualified := FORMAT('%I.%I', parts[1], parts[2]);
    ELSE
        qualified := FORMAT('%I', viewname);
    END IF;

    ok := PG_TRY_ADVISORY_LOCK(hashtext(viewname)::BIGINT);
    IF ok THEN
        EXECUTE FORMAT('REFRESH MATERIALIZED VIEW CONCURRENTLY %s', qualified);
        PERFORM PG_ADVISORY_UNLOCK(hashtext(viewname)::BIGINT);
    END IF;
END;
$$;

DROP MATERIALIZED VIEW IF EXISTS incentives.computed_rewards_by_position_materialized;

CREATE MATERIALIZED VIEW incentives.computed_rewards_by_position_materialized AS
SELECT c.id                  AS campaign_id,
       cr.locker,
       cr.salt,
       SUM(cr.reward_amount) AS total_reward_amount,
       SUM(
               CASE
                   WHEN gdrp.drop_id IS NULL THEN cr.reward_amount
                   ELSE 0
                   END
       )                     AS pending_reward_amount
FROM incentives.campaign_reward_periods crp
         JOIN incentives.campaigns c ON c.id = crp.campaign_id
         JOIN incentives.computed_rewards cr ON cr.campaign_reward_period_id = crp.id
         LEFT JOIN incentives.generated_drop_reward_periods gdrp
                   ON gdrp.campaign_reward_period_id = crp.id
GROUP BY c.id, cr.locker, cr.salt;

CREATE UNIQUE INDEX ON incentives.computed_rewards_by_position_materialized (campaign_id, locker, salt);

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
            RAISE NOTICE 'pg_cron not installed; skipping computed rewards materialized view refresh job.';
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
                '*/15 * * * *',
                'SELECT safe_refresh_mv (''incentives.computed_rewards_by_position_materialized'');'
                );
    END;
$$;
