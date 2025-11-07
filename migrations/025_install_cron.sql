-- install pg_cron if necessary
-- create a function for refreshing any arbitrary view, using the hash of the name as the advisory lock
CREATE FUNCTION safe_refresh_mv (viewname text)
	RETURNS void
	LANGUAGE plpgsql
	AS $$
DECLARE
	ok boolean;
BEGIN
	ok := pg_try_advisory_lock(hashtext(viewname)::bigint);
	IF ok THEN
		EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', viewname);
		PERFORM
			pg_advisory_unlock(hashtext(viewname)::bigint);
	END IF;
END;
$$;

DO $$
DECLARE
	has_pg_cron boolean;
	pg_cron_available boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1
		FROM pg_available_extensions
		WHERE name = 'pg_cron'
	) INTO pg_cron_available;

	IF NOT pg_cron_available THEN
		RAISE NOTICE 'pg_cron extension not available; skipping cron job installation.';
		RETURN;
	END IF;

	BEGIN
		EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
	EXCEPTION
		WHEN insufficient_privilege THEN
			RAISE NOTICE 'insufficient privileges to install pg_cron; skipping cron job installation.';
	END;

	SELECT EXISTS (
		SELECT 1
		FROM pg_extension
		WHERE extname = 'pg_cron'
	) INTO has_pg_cron;

	IF NOT has_pg_cron THEN
		RETURN;
	END IF;

	PERFORM cron.schedule (
		'refresh_token_pair_realized_volatility',
		'*/5 * * * *',
		'SELECT safe_refresh_mv (''token_pair_realized_volatility_materialized'');'
	);

	PERFORM cron.schedule (
		'refresh_pool_market_depth',
		'*/15 * * * *',
		'SELECT safe_refresh_mv (''pool_market_depth_materialized'');'
	);

	PERFORM cron.schedule (
		'refresh_proposal_delegate_voting_weights',
		'0 * * * *',
		'SELECT safe_refresh_mv (''proposal_delegate_voting_weights_materialized'');'
	);

	PERFORM cron.schedule (
		'refresh_last_24h_pool_stats',
		'*/5 * * * *',
		'SELECT safe_refresh_mv (''last_24h_pool_stats_materialized'');'
	);

	PERFORM cron.schedule (
		'refresh_latest_token_registrations',
		'*/5 * * * *',
		'SELECT safe_refresh_mv (''latest_token_registrations_materialized'');'
	);
END;
$$;
