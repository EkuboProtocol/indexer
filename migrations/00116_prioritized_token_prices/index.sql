DROP TRIGGER IF EXISTS erc20_tokens_usd_prices_latest_on_insert ON erc20_tokens_usd_prices;
DROP TRIGGER IF EXISTS erc20_tokens_usd_prices_latest_on_delete ON erc20_tokens_usd_prices;
DROP FUNCTION IF EXISTS erc20_tokens_latest_price_on_insert();
DROP FUNCTION IF EXISTS erc20_tokens_latest_price_on_delete();

-- Per-source confidence policy. Seeded here and nowhere else: the price worker
-- never writes this table, so adjustments (made in a later migration) survive
-- deploys. The quoter ranks first because the interface derives price-impact
-- loss from it; Chainlink reference feeds outrank the aggregator APIs.
CREATE TABLE erc20_token_price_sources
(
    source     CHAR(3)  PRIMARY KEY,
    confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 255)
);

INSERT INTO erc20_token_price_sources (source, confidence)
VALUES ('qp1', 4),
       ('cl1', 3),
       ('cg1', 2),
       ('cgn', 2),
       ('ss1', 1),
       ('ov1', 0),
       ('LEG', 0);

-- Freshness is a property of the observation, not the source: sync jobs stamp
-- three of their own sync intervals, and Chainlink stamps the feed's heartbeat
-- window anchored at the round's updatedAt. Rows predating this column fall
-- back to five minutes past their timestamp.
ALTER TABLE erc20_tokens_usd_prices
    ADD COLUMN valid_until timestamptz;

-- Cache one observation per token/source. Confidence and expiry are copied
-- here when an observation arrives so the high-volume history remains narrow.
CREATE TABLE erc20_tokens_latest_price_by_source
(
    chain_id      BIGINT           NOT NULL,
    token_address NUMERIC          NOT NULL,
    source        CHAR(3)          NOT NULL,
    "timestamp"   timestamptz      NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    confidence    SMALLINT         NOT NULL CHECK (confidence BETWEEN 0 AND 255),
    valid_until   timestamptz      NOT NULL,
    PRIMARY KEY (chain_id, token_address, source)
);

INSERT INTO erc20_tokens_latest_price_by_source
    (chain_id, token_address, source, "timestamp", value, confidence, valid_until)
SELECT DISTINCT ON (up.chain_id, up.token_address, up.source)
       up.chain_id,
       up.token_address,
       up.source,
       up."timestamp",
       up.value,
       s.confidence,
       COALESCE(up.valid_until, up."timestamp" + INTERVAL '5 minutes')
FROM erc20_tokens_usd_prices up
         JOIN erc20_token_price_sources s USING (source)
ORDER BY up.chain_id, up.token_address, up.source, up."timestamp" DESC;

-- Keep the existing physical table and primary key because the quoter reads it
-- on every block. Source aggregation happens on writes, never on this hot path.
ALTER TABLE erc20_tokens_latest_price
    ADD COLUMN confidence SMALLINT,
    ADD COLUMN valid_until timestamptz;

CREATE OR REPLACE FUNCTION recompute_erc20_token_latest_price(
    p_chain_id BIGINT,
    p_token_address NUMERIC,
    p_as_of timestamptz DEFAULT CURRENT_TIMESTAMP
)
    RETURNS VOID
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_source       CHAR(3);
    v_timestamp    timestamptz;
    v_value        DOUBLE PRECISION;
    v_confidence   SMALLINT;
    v_valid_until  timestamptz;
BEGIN
    WITH fresh_prices AS (
        SELECT lp.source,
               lp."timestamp",
               lp.value,
               lp.confidence,
               lp.valid_until
        FROM erc20_tokens_latest_price_by_source lp
        WHERE lp.chain_id = p_chain_id
          AND lp.token_address = p_token_address
          AND lp.valid_until > p_as_of
    ),
    winning_prices AS (
        SELECT *
        FROM fresh_prices
        WHERE confidence = (SELECT MAX(confidence) FROM fresh_prices)
    )
    SELECT CASE
               WHEN COUNT(*) = 1 THEN MIN(source)
               ELSE 'AVG'::CHAR(3)
               END,
           MAX("timestamp"),
           AVG(value)::DOUBLE PRECISION,
           MAX(confidence)::SMALLINT,
           MIN(valid_until)
    INTO v_source, v_timestamp, v_value, v_confidence, v_valid_until
    FROM winning_prices
    HAVING COUNT(*) > 0;

    IF NOT FOUND THEN
        DELETE FROM erc20_tokens_latest_price
        WHERE chain_id = p_chain_id
          AND token_address = p_token_address;
        RETURN;
    END IF;

    INSERT INTO erc20_tokens_latest_price
        (chain_id, token_address, source, "timestamp", value, confidence, valid_until)
    VALUES (p_chain_id, p_token_address, v_source, v_timestamp, v_value,
            v_confidence, v_valid_until)
    ON CONFLICT (chain_id, token_address) DO UPDATE
        SET source       = excluded.source,
            "timestamp"  = excluded."timestamp",
            value        = excluded.value,
            confidence   = excluded.confidence,
            valid_until  = excluded.valid_until
    WHERE (erc20_tokens_latest_price.source,
           erc20_tokens_latest_price."timestamp",
           erc20_tokens_latest_price.value,
           erc20_tokens_latest_price.confidence,
           erc20_tokens_latest_price.valid_until)
              IS DISTINCT FROM
          (excluded.source,
           excluded."timestamp",
           excluded.value,
           excluded.confidence,
           excluded.valid_until);
END;
$$;

TRUNCATE erc20_tokens_latest_price;

SELECT recompute_erc20_token_latest_price(chain_id, token_address)
FROM (
    SELECT DISTINCT chain_id, token_address
    FROM erc20_tokens_latest_price_by_source
) tokens;

ALTER TABLE erc20_tokens_latest_price
    ALTER COLUMN confidence SET NOT NULL,
    ALTER COLUMN valid_until SET NOT NULL,
    ADD CHECK (confidence BETWEEN 0 AND 255);

CREATE INDEX erc20_tokens_latest_price_valid_until_idx
    ON erc20_tokens_latest_price (valid_until);

CREATE OR REPLACE FUNCTION erc20_tokens_latest_price_on_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    affected RECORD;
BEGIN
    INSERT INTO erc20_tokens_latest_price_by_source
        (chain_id, token_address, source, "timestamp", value, confidence, valid_until)
    SELECT latest.chain_id,
           latest.token_address,
           latest.source,
           latest."timestamp",
           latest.value,
           latest.confidence,
           latest.valid_until
    FROM (
        SELECT DISTINCT ON (new_prices.chain_id, new_prices.token_address, new_prices.source)
               new_prices.chain_id,
               new_prices.token_address,
               new_prices.source,
               new_prices."timestamp",
               new_prices.value,
               s.confidence,
               COALESCE(new_prices.valid_until,
                        new_prices."timestamp" + INTERVAL '5 minutes') AS valid_until
        FROM inserted_prices new_prices
                 JOIN erc20_token_price_sources s USING (source)
        ORDER BY new_prices.chain_id,
                 new_prices.token_address,
                 new_prices.source,
                 new_prices."timestamp" DESC
    ) latest
    ON CONFLICT (chain_id, token_address, source) DO UPDATE
        SET "timestamp" = excluded."timestamp",
            value       = excluded.value,
            confidence  = excluded.confidence,
            valid_until = excluded.valid_until
    WHERE excluded."timestamp" >= erc20_tokens_latest_price_by_source."timestamp";

    FOR affected IN
        SELECT DISTINCT chain_id, token_address
        FROM inserted_prices
        ORDER BY chain_id, token_address
    LOOP
        PERFORM recompute_erc20_token_latest_price(
            affected.chain_id,
            affected.token_address
        );
    END LOOP;

    RETURN NULL;
END;
$$;

CREATE TRIGGER erc20_tokens_usd_prices_latest_on_insert
    AFTER INSERT
    ON erc20_tokens_usd_prices
    REFERENCING NEW TABLE AS inserted_prices
    FOR EACH STATEMENT
EXECUTE FUNCTION erc20_tokens_latest_price_on_insert();

CREATE OR REPLACE FUNCTION erc20_tokens_latest_price_on_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    affected RECORD;
BEGIN
    -- Hourly retention deletes old history in bulk. Only rebuild a source cache
    -- when the deleted statement actually contained its cached observation.
    FOR affected IN
        SELECT DISTINCT lp.chain_id, lp.token_address, lp.source
        FROM erc20_tokens_latest_price_by_source lp
                 JOIN deleted_prices old_prices
                      ON old_prices.chain_id = lp.chain_id
                          AND old_prices.token_address = lp.token_address
                          AND old_prices.source = lp.source
                          AND old_prices."timestamp" >= lp."timestamp"
        ORDER BY lp.chain_id, lp.token_address, lp.source
    LOOP
        DELETE FROM erc20_tokens_latest_price_by_source
        WHERE chain_id = affected.chain_id
          AND token_address = affected.token_address
          AND source = affected.source;

        INSERT INTO erc20_tokens_latest_price_by_source
            (chain_id, token_address, source, "timestamp", value, confidence, valid_until)
        SELECT up.chain_id,
               up.token_address,
               up.source,
               up."timestamp",
               up.value,
               s.confidence,
               COALESCE(up.valid_until, up."timestamp" + INTERVAL '5 minutes')
        FROM erc20_tokens_usd_prices up
                 JOIN erc20_token_price_sources s USING (source)
        WHERE up.chain_id = affected.chain_id
          AND up.token_address = affected.token_address
          AND up.source = affected.source
        ORDER BY up."timestamp" DESC
        LIMIT 1;

        PERFORM recompute_erc20_token_latest_price(
            affected.chain_id,
            affected.token_address
        );
    END LOOP;

    RETURN NULL;
END;
$$;

CREATE TRIGGER erc20_tokens_usd_prices_latest_on_delete
    AFTER DELETE
    ON erc20_tokens_usd_prices
    REFERENCING OLD TABLE AS deleted_prices
    FOR EACH STATEMENT
EXECUTE FUNCTION erc20_tokens_latest_price_on_delete();

-- Called by the price worker as expiry deadlines pass. The valid-until index
-- makes the normal no-op poll cheap, and only expired tokens are recomputed.
CREATE OR REPLACE FUNCTION refresh_expired_erc20_token_latest_prices(
    p_as_of timestamptz DEFAULT CURRENT_TIMESTAMP
)
    RETURNS BIGINT
    LANGUAGE plpgsql
AS
$$
DECLARE
    expired RECORD;
    refreshed BIGINT := 0;
BEGIN
    FOR expired IN
        SELECT chain_id, token_address
        FROM erc20_tokens_latest_price
        WHERE valid_until <= p_as_of
        FOR UPDATE
        SKIP LOCKED
    LOOP
        PERFORM recompute_erc20_token_latest_price(
            expired.chain_id,
            expired.token_address,
            p_as_of
        );
        refreshed := refreshed + 1;
    END LOOP;

    RETURN refreshed;
END;
$$;
