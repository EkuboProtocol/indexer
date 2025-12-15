DROP INDEX IF EXISTS erc20_tokens_usd_prices_latest_covering_idx;
DROP INDEX IF EXISTS erc20_tokens_usd_prices_latest_idx;

CREATE TABLE IF NOT EXISTS erc20_tokens_latest_price
(
    chain_id      BIGINT           NOT NULL,
    token_address NUMERIC          NOT NULL,
    source        CHAR(3)          NOT NULL,
    "timestamp"   timestamptz      NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (chain_id, token_address)
);

CREATE INDEX IF NOT EXISTS erc20_tokens_usd_prices_latest_idx
    ON erc20_tokens_usd_prices (chain_id, token_address, "timestamp" DESC);

INSERT INTO erc20_tokens_latest_price (chain_id, token_address, source, "timestamp", value)
SELECT DISTINCT ON (chain_id, token_address) chain_id,
                                             token_address,
                                             source,
                                             "timestamp",
                                             value
FROM erc20_tokens_usd_prices
ORDER BY chain_id, token_address, "timestamp" DESC
ON CONFLICT (chain_id, token_address) DO NOTHING;

CREATE OR REPLACE FUNCTION erc20_tokens_latest_price_on_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    INSERT INTO erc20_tokens_latest_price (chain_id, token_address, source, "timestamp", value)
    VALUES (new.chain_id, new.token_address, new.source, new."timestamp", new.value)
    ON CONFLICT (chain_id, token_address) DO UPDATE
        SET "timestamp" = excluded."timestamp",
            value       = excluded.value,
            source      = excluded.source
    WHERE excluded."timestamp" >= erc20_tokens_latest_price."timestamp";

    RETURN NULL;
END;
$$;

CREATE TRIGGER erc20_tokens_usd_prices_latest_on_insert
    AFTER INSERT
    ON erc20_tokens_usd_prices
    FOR EACH ROW
EXECUTE FUNCTION erc20_tokens_latest_price_on_insert();

CREATE OR REPLACE FUNCTION erc20_tokens_latest_price_on_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_current_ts         timestamptz;
    v_replacement_ts     timestamptz;
    v_replacement_value  DOUBLE PRECISION;
    v_replacement_source CHAR(3);
BEGIN
    SELECT "timestamp"
    INTO v_current_ts
    FROM erc20_tokens_latest_price lp
    WHERE lp.chain_id = old.chain_id
      AND lp.token_address = old.token_address;

    IF v_current_ts IS NULL OR v_current_ts > old."timestamp" THEN
        RETURN NULL;
    END IF;

    SELECT up."timestamp", up.value, up.source
    INTO v_replacement_ts, v_replacement_value, v_replacement_source
    FROM erc20_tokens_usd_prices up
    WHERE up.chain_id = old.chain_id
      AND up.token_address = old.token_address
    ORDER BY up."timestamp" DESC
    LIMIT 1;

    IF v_replacement_ts IS NULL THEN
        DELETE
        FROM erc20_tokens_latest_price
        WHERE chain_id = old.chain_id
          AND token_address = old.token_address;
    ELSE
        UPDATE erc20_tokens_latest_price
        SET "timestamp" = v_replacement_ts,
            value       = v_replacement_value,
            source      = v_replacement_source
        WHERE chain_id = old.chain_id
          AND token_address = old.token_address;
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER erc20_tokens_usd_prices_latest_on_delete
    AFTER DELETE
    ON erc20_tokens_usd_prices
    FOR EACH ROW
EXECUTE FUNCTION erc20_tokens_latest_price_on_delete();

CREATE TRIGGER erc20_tokens_usd_prices_no_updates
    BEFORE UPDATE
    ON erc20_tokens_usd_prices
    FOR EACH ROW
EXECUTE FUNCTION block_updates();
