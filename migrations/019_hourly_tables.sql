CREATE TABLE hourly_volume_by_token
(
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    hour       timestamptz NOT NULL,
    token      NUMERIC NOT NULL,
    volume     NUMERIC NOT NULL,
    fees       NUMERIC NOT NULL,
    swap_count NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);

CREATE TABLE hourly_price_data
(
    chain_id   int8 NOT NULL,
    token0     NUMERIC NOT NULL,
    token1     NUMERIC NOT NULL,
    hour       timestamptz NOT NULL,
    k_volume   NUMERIC NOT NULL,
    total      NUMERIC NOT NULL,
    swap_count NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, token0, token1, hour)
);

CREATE TABLE hourly_tvl_delta_by_token
(
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    hour     timestamptz NOT NULL,
    token    NUMERIC NOT NULL,
    delta    NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);

CREATE TABLE IF NOT EXISTS hourly_revenue_by_token
(
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    hour     timestamptz NOT NULL,
    token    NUMERIC NOT NULL,
    revenue  NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);
