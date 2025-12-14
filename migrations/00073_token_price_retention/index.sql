ALTER TABLE erc20_tokens_usd_prices
    DROP CONSTRAINT IF EXISTS erc20_tokens_usd_prices_pkey;

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
        RAISE NOTICE 'pg_cron not installed; skipping erc20 token prices cleanup job.';
        RETURN;
    END IF;

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'prune_erc20_tokens_usd_prices';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'prune_erc20_tokens_usd_prices',
        '0 * * * *',
        'DELETE FROM erc20_tokens_usd_prices WHERE "timestamp" < NOW() - INTERVAL ''1 day'';'
    );
END;
$$;
