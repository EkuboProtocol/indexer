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

