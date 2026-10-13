-- Keep a month of token USD price history at hourly resolution.
--
-- erc20_tokens_usd_prices keeps every observation for a day: about 465,000
-- rows an hour across ~14,400 priced tokens (measured on ekubo-db-nyc1,
-- 2026-10-13), 3.2 GB with its index. A month of that would be ~350M rows, so
-- the raw table keeps its one-day window and older observations are rolled up
-- as they are pruned: for each token and UTC hour, the latest observation of
-- that hour is kept, which is what the price-history API reports for a bucket.
-- Any bucket made of whole hours (the API bins from 2000-01-01 00:00 UTC) is
-- therefore answered exactly by the union of the raw table and this one.
-- A month is ~14,400 tokens x 744 hours, about 11M rows.
--
-- The hourly table has no foreign key to erc20_tokens: adding one would take
-- a SHARE ROW EXCLUSIVE lock on a table the workers write, and orphaned rows
-- age out with the rest of the history anyway.

CREATE TABLE erc20_tokens_usd_prices_hourly
(
    chain_id      int8             NOT NULL,
    token_address NUMERIC          NOT NULL,
    hour          timestamptz      NOT NULL,
    "timestamp"   timestamptz      NOT NULL,
    source        CHAR(3)          NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (chain_id, token_address, hour)
);

-- Rows arrive in hour order, so a BRIN index makes expiry cheap.
CREATE INDEX erc20_tokens_usd_prices_hourly_hour_brin_idx
    ON erc20_tokens_usd_prices_hourly USING brin (hour);

-- Deletes the raw history retention no longer needs (unchanged from 00117:
-- older than a day and no longer valid) and folds it into the hourly table in
-- the same statement, so every observation is in exactly one of the two.
-- Observations retained past a day because they were still valid fold in when
-- they are finally pruned and replace their hour's row only if they are later.
-- The hour is binned rather than truncated so that the session time zone
-- cannot shift it.
CREATE OR REPLACE FUNCTION prune_erc20_tokens_usd_prices(
    p_as_of timestamptz DEFAULT CURRENT_TIMESTAMP
)
    RETURNS BIGINT
    LANGUAGE plpgsql
AS
$$
DECLARE
    pruned BIGINT;
BEGIN
    WITH pruned_prices AS (
        DELETE FROM erc20_tokens_usd_prices
        WHERE "timestamp" < p_as_of - INTERVAL '1 day'
          AND (valid_until IS NULL OR valid_until < p_as_of)
        RETURNING chain_id, token_address, "timestamp", source, value
    ),
    rolled_up AS (
        INSERT INTO erc20_tokens_usd_prices_hourly
            (chain_id, token_address, hour, "timestamp", source, value)
        SELECT DISTINCT ON (chain_id, token_address, hour)
               chain_id, token_address, hour, "timestamp", source, value
        FROM (
            SELECT chain_id,
                   token_address,
                   date_bin(INTERVAL '1 hour', "timestamp",
                            TIMESTAMPTZ '2000-01-01 00:00:00+00') AS hour,
                   "timestamp",
                   source,
                   value
            FROM pruned_prices
        ) binned
        ORDER BY chain_id, token_address, hour, "timestamp" DESC, source DESC
        ON CONFLICT (chain_id, token_address, hour) DO UPDATE
            SET "timestamp" = excluded."timestamp",
                source      = excluded.source,
                value       = excluded.value
        WHERE (excluded."timestamp", excluded.source)
                  > (erc20_tokens_usd_prices_hourly."timestamp",
                     erc20_tokens_usd_prices_hourly.source)
    )
    SELECT COUNT(*) INTO pruned FROM pruned_prices;

    DELETE FROM erc20_tokens_usd_prices_hourly
    WHERE hour < p_as_of - INTERVAL '31 days';

    RETURN pruned;
END;
$$;

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
            'SELECT prune_erc20_tokens_usd_prices();'
        );
    END;
$$;
