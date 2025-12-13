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
        RAISE NOTICE 'pg_cron not installed; skipping latest_token_registrations cron removal.';
        RETURN;
    END IF;

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_latest_token_registrations';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;
END;
$$;
