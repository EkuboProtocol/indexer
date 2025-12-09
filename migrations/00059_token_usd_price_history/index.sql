CREATE TABLE erc20_tokens_usd_prices
(
    chain_id      int8             NOT NULL,
    token_address NUMERIC          NOT NULL,
    "timestamp"   timestamptz      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source        CHAR(3)          NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (chain_id, token_address, "timestamp", source),
    FOREIGN KEY (chain_id, token_address) REFERENCES erc20_tokens (chain_id, token_address)
);

CREATE INDEX erc20_tokens_usd_prices_latest_idx
    ON erc20_tokens_usd_prices (chain_id, token_address, "timestamp" DESC);

INSERT INTO erc20_tokens_usd_prices (chain_id, token_address, "timestamp", source, value)
SELECT chain_id,
       token_address,
       COALESCE(last_updated, CURRENT_TIMESTAMP),
       'LEG',
       usd_price
FROM erc20_tokens
WHERE usd_price IS NOT NULL;

DROP TRIGGER IF EXISTS set_last_updated_on_erc20_tokens ON erc20_tokens;
DROP FUNCTION IF EXISTS set_last_updated_to_now();

ALTER TABLE erc20_tokens
    DROP COLUMN IF EXISTS usd_price,
    DROP COLUMN IF EXISTS last_updated;
