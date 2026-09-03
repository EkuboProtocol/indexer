-- Retention deleted any observation whose round timestamp was over a day old.
-- That timestamp is the observation's own age, not the age of the write, so a
-- Chainlink equity feed -- which republishes nothing while its market is shut
-- -- had Friday's closing round pruned on Saturday evening. The in-memory
-- round dedupe then refused to re-emit an unchanged round, so the token stayed
-- unpriced until the market reopened. Retention is history cleanup and has no
-- business dropping the observation a token is currently priced from, so keep
-- anything still inside its validity window and let it age out once superseded.

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
            'DELETE FROM erc20_tokens_usd_prices WHERE "timestamp" < NOW() - INTERVAL ''1 day'' AND (valid_until IS NULL OR valid_until < NOW());'
        );
    END;
$$;
