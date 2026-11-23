-- A token's UI multiplier: a display scale applied next to its decimals, so one
-- raw unit (10^-decimals of a token) shows as `multiplier` units. Robinhood
-- Stock Tokens expose it as uiMultiplier() and raise it after stock splits and
-- as dividends compound; it can be scheduled to change at effectiveAt().
--
-- Kept out of erc20_tokens because that table is synchronized from the token
-- list, and a sync must never clobber values read from the chain. Written only
-- by the indexer's refresher, one row per token that implements uiMultiplier().
-- A token without a row has no multiplier, which means 1.
--
-- Amounts and prices everywhere else stay per raw token: this is display only.
CREATE TABLE erc20_tokens_ui_multipliers
(
    chain_id          INT8        NOT NULL,
    token_address     NUMERIC     NOT NULL,
    -- uiMultiplier(), 18 decimals: 8e18 is 8x.
    ui_multiplier     NUMERIC     NOT NULL CHECK (ui_multiplier > 0),
    -- newUIMultiplier() and effectiveAt() (unix seconds), the scheduled change.
    -- NULL when the token does not implement them.
    new_ui_multiplier NUMERIC,
    effective_at      NUMERIC,
    -- When the refresher last read these values from the chain.
    checked_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain_id, token_address)
);

-- The multiplier in effect at `at`, still 18 decimals. A scheduled change takes
-- over once its effectiveAt has passed, so it flips exactly on time whatever
-- the refresh cadence. A zero newUIMultiplier is read as nothing scheduled
-- rather than as a zero scale.
CREATE FUNCTION erc20_token_effective_ui_multiplier(
    ui_multiplier NUMERIC,
    new_ui_multiplier NUMERIC,
    effective_at NUMERIC,
    at TIMESTAMPTZ
) RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE
AS
$$
SELECT CASE
           WHEN new_ui_multiplier > 0 AND effective_at <= EXTRACT(EPOCH FROM at)
               THEN new_ui_multiplier
           ELSE ui_multiplier
           END
$$;

-- What readers join: the multiplier in effect now, 18 decimals.
CREATE VIEW erc20_tokens_effective_ui_multipliers AS
SELECT chain_id,
       token_address,
       erc20_token_effective_ui_multiplier(ui_multiplier, new_ui_multiplier, effective_at, NOW()) AS ui_multiplier
FROM erc20_tokens_ui_multipliers;
