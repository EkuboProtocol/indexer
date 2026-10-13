-- bm1: a token's price copied from the token it is bridged to or from on
-- another chain, for tokens no source prices directly (an L2's canonically
-- bridged AAVE priced from AAVE on Ethereum). Confidence 0 ranks it below every
-- direct observation, so it only ever fills a gap.
--
-- This must be applied before the worker that writes bm1 starts: the insert
-- trigger inner-joins this table, so bm1 rows written without the row here
-- would stay in history and never reach the latest-price tables, with no
-- error. The PRE_DEPLOY run-migrations job orders that on deploy.
INSERT INTO erc20_token_price_sources (source, confidence)
VALUES ('bm1', 0)
ON CONFLICT (source) DO NOTHING;
