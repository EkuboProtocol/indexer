DROP INDEX IF EXISTS idx_latest_token_registrations_by_address;

DROP MATERIALIZED VIEW IF EXISTS latest_token_registrations_materialized;

DO $$
DECLARE
	has_pg_cron boolean;
	job_id int4;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM pg_extension
		WHERE extname = 'pg_cron'
	) INTO has_pg_cron;

	IF NOT has_pg_cron THEN
		RAISE NOTICE 'pg_cron not installed; skipping unschedule.';
		RETURN;
	END IF;

	SELECT jobid
	INTO job_id
	FROM cron.job
	WHERE jobname = 'refresh_latest_token_registrations';

	IF job_id IS NULL THEN
		RAISE NOTICE 'refresh_latest_token_registrations job not found; skipping unschedule.';
		RETURN;
	END IF;

	PERFORM cron.unschedule(job_id);
END;
$$;
