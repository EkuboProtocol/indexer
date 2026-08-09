CREATE INDEX erc20_tokens_usd_prices_history_covering_idx
    ON erc20_tokens_usd_prices (chain_id, token_address, "timestamp" DESC)
    INCLUDE (value, source);

DROP INDEX IF EXISTS erc20_tokens_usd_prices_latest_idx;
