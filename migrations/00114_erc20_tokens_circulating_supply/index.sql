ALTER TABLE erc20_tokens
    ADD COLUMN circulating_supply NUMERIC
    CONSTRAINT erc20_tokens_circulating_supply_nonnegative_integer
    CHECK (
        circulating_supply >= 0
        AND circulating_supply = TRUNC(circulating_supply)
    );

COMMENT ON COLUMN erc20_tokens.circulating_supply IS
    'Latest known circulating supply in the token''s indivisible units; NULL when unknown';
