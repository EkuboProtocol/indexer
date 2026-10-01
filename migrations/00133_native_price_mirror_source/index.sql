-- em1: Ethereum's native price copied onto chains that pay gas in bridged ETH
-- (Unichain, World Chain, Ink), so they keep a native price while CoinGecko is
-- out. Confidence 1 puts it below cgn, which stays the primary.
--
-- This must be applied before the worker that writes em1 starts: the insert
-- trigger inner-joins this table, so em1 rows written without the row here
-- would stay in history and never reach the latest-price tables, with no
-- error. The PRE_DEPLOY run-migrations job orders that on deploy.
INSERT INTO erc20_token_price_sources (source, confidence)
VALUES ('em1', 1)
ON CONFLICT (source) DO NOTHING;
