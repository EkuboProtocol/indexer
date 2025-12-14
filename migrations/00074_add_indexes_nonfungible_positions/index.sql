CREATE INDEX ON nonfungible_token_owners (current_owner);

CREATE INDEX ON position_current_liquidity (locker, salt);

CREATE INDEX ON order_current_sale_rate (locker, salt);
