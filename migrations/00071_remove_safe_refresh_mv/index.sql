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
        RAISE NOTICE 'pg_cron not installed; skipping materialized view refresh reschedule.';
        RETURN;
    END IF;

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_token_pair_realized_volatility';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_token_pair_realized_volatility',
        '*/5 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY token_pair_realized_volatility_materialized'
    );

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_pool_market_depth';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_pool_market_depth',
        '*/15 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY pool_market_depth_materialized'
    );

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_proposal_delegate_voting_weights';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_proposal_delegate_voting_weights',
        '0 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY proposal_delegate_voting_weights_materialized'
    );

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_last_24h_pool_stats';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_last_24h_pool_stats',
        '*/5 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY last_24h_pool_stats_materialized'
    );

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_latest_token_registrations';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_latest_token_registrations',
        '*/5 * * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY latest_token_registrations_materialized'
    );

    SELECT jobid
    INTO job_id
    FROM cron.job
    WHERE jobname = 'refresh_computed_rewards_by_position';

    IF job_id IS NOT NULL THEN
        PERFORM cron.unschedule(job_id);
    END IF;

    PERFORM cron.schedule(
        'refresh_computed_rewards_by_position',
        '* */6 * * *',
        'REFRESH MATERIALIZED VIEW CONCURRENTLY incentives.computed_rewards_by_position_materialized'
    );
END;
$$;

DROP FUNCTION IF EXISTS safe_refresh_mv(text);
