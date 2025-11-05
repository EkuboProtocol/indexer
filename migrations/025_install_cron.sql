-- install pg_cron if necessary
CREATE EXTENSION IF NOT EXISTS pg_cron;

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

-- SELECT cron.schedule ('refresh_token_pair_realized_volatility', '*/5 * * * *',
-- 	$$SELECT safe_refresh_mv ('token_pair_realized_volatility_materialized');$$);

SELECT cron.schedule ('refresh_pool_market_depth', '*/15 * * * *',
	$$SELECT safe_refresh_mv ('pool_market_depth_materialized');$$);

SELECT cron.schedule ('refresh_proposal_delegate_voting_weights', '0 * * * *',
	$$SELECT safe_refresh_mv ('proposal_delegate_voting_weights_materialized');$$);

-- SELECT cron.schedule ('refresh_last_24h_pool_stats', '*/5 * * * *',
-- 	$$SELECT safe_refresh_mv ('last_24h_pool_stats_materialized');$$);

SELECT cron.schedule ('refresh_latest_token_registrations', '*/5 * * * *',
	$$SELECT safe_refresh_mv ('latest_token_registrations_materialized');$$);
