CREATE TABLE hourly_volume_by_token (
    pool_key_id int8,
    hour timestamptz,
    token NUMERIC,
    volume NUMERIC,
    fees NUMERIC,
    swap_count NUMERIC,
    PRIMARY KEY (pool_key_id, hour, token)
);
CREATE TABLE hourly_price_data (
    token0 NUMERIC,
    token1 NUMERIC,
    hour timestamptz,
    k_volume NUMERIC,
    total NUMERIC,
    swap_count NUMERIC,
    PRIMARY KEY (token0, token1, hour)
);
CREATE TABLE hourly_tvl_delta_by_token (
    pool_key_id int8,
    hour timestamptz,
    token NUMERIC,
    delta NUMERIC,
    PRIMARY KEY (pool_key_id, hour, token)
);
CREATE TABLE hourly_revenue_by_token (
    pool_key_id int8,
    hour timestamptz,
    token NUMERIC,
    revenue NUMERIC,
    PRIMARY KEY (pool_key_id, hour, token)
);