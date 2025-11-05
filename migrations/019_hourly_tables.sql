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

CREATE TABLE hourly_revenue_by_token
(
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    hour     timestamptz NOT NULL,
    token    NUMERIC NOT NULL,
    revenue  NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, hour, token)
);

CREATE FUNCTION upsert_hourly_swap_metrics()
RETURNS trigger AS $$
DECLARE
    v_hour timestamptz;
    v_token0 NUMERIC;
    v_token1 NUMERIC;
    v_fee NUMERIC;
    v_fee_denominator NUMERIC;
    v_volume0 NUMERIC := 0;
    v_volume1 NUMERIC := 0;
    v_fees0 NUMERIC := 0;
    v_fees1 NUMERIC := 0;
    v_k_volume NUMERIC := abs(NEW.delta0 * NEW.delta1);
    v_total NUMERIC := NEW.delta1 * NEW.delta1;
BEGIN
    SELECT
        date_trunc('hour', b.block_time),
        pk.token0,
        pk.token1,
        pk.fee,
        pk.fee_denominator
    INTO STRICT v_hour, v_token0, v_token1, v_fee, v_fee_denominator
    FROM pool_keys pk
    JOIN blocks b ON b.chain_id = NEW.chain_id AND b.block_number = NEW.block_number
    WHERE pk.pool_key_id = NEW.pool_key_id;

    IF NEW.delta0 > 0 THEN
        v_volume0 := NEW.delta0;
        v_fees0 := CEIL((NEW.delta0 * v_fee) / v_fee_denominator);
    END IF;

    IF NEW.delta1 > 0 THEN
        v_volume1 := NEW.delta1;
        v_fees1 := CEIL((NEW.delta1 * v_fee) / v_fee_denominator);
    END IF;

    IF v_volume0 = 0 AND v_volume1 = 0 THEN
        RETURN NULL;
    END IF;

    IF v_volume0 <> 0 THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, swap_count)
        VALUES (NEW.pool_key_id, v_hour, v_token0, v_volume0, v_fees0, 1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET volume = hourly_volume_by_token.volume + EXCLUDED.volume,
            fees = hourly_volume_by_token.fees + EXCLUDED.fees,
            swap_count = hourly_volume_by_token.swap_count + EXCLUDED.swap_count;
    END IF;

    IF v_volume1 <> 0 THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, swap_count)
        VALUES (NEW.pool_key_id, v_hour, v_token1, v_volume1, v_fees1, 1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET volume = hourly_volume_by_token.volume + EXCLUDED.volume,
            fees = hourly_volume_by_token.fees + EXCLUDED.fees,
            swap_count = hourly_volume_by_token.swap_count + EXCLUDED.swap_count;
    END IF;

    IF v_k_volume <> 0 OR v_total <> 0 THEN
        INSERT INTO hourly_price_data (chain_id, token0, token1, hour, k_volume, total, swap_count)
        VALUES (NEW.chain_id, v_token0, v_token1, v_hour, v_k_volume, v_total, 1)
        ON CONFLICT (chain_id, token0, token1, hour) DO UPDATE
        SET k_volume = hourly_price_data.k_volume + EXCLUDED.k_volume,
            total = hourly_price_data.total + EXCLUDED.total,
            swap_count = hourly_price_data.swap_count + EXCLUDED.swap_count;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_hourly_revenue_from_protocol_fee()
RETURNS trigger AS $$
DECLARE
    v_hour timestamptz;
    v_token0 NUMERIC;
    v_token1 NUMERIC;
BEGIN
    IF NEW.delta0 = 0 AND NEW.delta1 = 0 THEN
        RETURN NULL;
    END IF;

    SELECT
        date_trunc('hour', b.block_time),
        pk.token0,
        pk.token1
    INTO STRICT v_hour, v_token0, v_token1
    FROM pool_keys pk
    JOIN blocks b ON b.chain_id = NEW.chain_id AND b.block_number = NEW.block_number
    WHERE pk.pool_key_id = NEW.pool_key_id;

    IF NEW.delta0 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (NEW.pool_key_id, v_hour, v_token0, -NEW.delta0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET revenue = hourly_revenue_by_token.revenue - EXCLUDED.revenue;
    END IF;

    IF NEW.delta1 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (NEW.pool_key_id, v_hour, v_token1, -NEW.delta1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET revenue = hourly_revenue_by_token.revenue - EXCLUDED.revenue;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_hourly_tvl_delta_from_balance_change()
RETURNS trigger AS $$
DECLARE
    v_hour timestamptz;
    v_token0 NUMERIC;
    v_token1 NUMERIC;
BEGIN
    IF NEW.delta0 = 0 AND NEW.delta1 = 0 THEN
        RETURN NULL;
    END IF;

    SELECT
        date_trunc('hour', b.block_time),
        pk.token0,
        pk.token1
    INTO STRICT v_hour, v_token0, v_token1
    FROM pool_keys pk
    JOIN blocks b ON b.chain_id = NEW.chain_id AND b.block_number = NEW.block_number
    WHERE pk.pool_key_id = NEW.pool_key_id;

    IF NEW.delta0 <> 0 THEN
        INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
        VALUES (NEW.pool_key_id, v_hour, v_token0, NEW.delta0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET delta = hourly_tvl_delta_by_token.delta + EXCLUDED.delta;
    END IF;

    IF NEW.delta1 <> 0 THEN
        INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
        VALUES (NEW.pool_key_id, v_hour, v_token1, NEW.delta1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET delta = hourly_tvl_delta_by_token.delta + EXCLUDED.delta;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hourly_swap_metrics
    AFTER INSERT ON swaps
    FOR EACH ROW
    EXECUTE FUNCTION upsert_hourly_swap_metrics();

CREATE TRIGGER hourly_protocol_revenue
    AFTER INSERT ON protocol_fees_paid
    FOR EACH ROW
    EXECUTE FUNCTION upsert_hourly_revenue_from_protocol_fee();

CREATE TRIGGER hourly_tvl_delta_from_balance_change
    AFTER INSERT ON pool_balance_change
    FOR EACH ROW
    EXECUTE FUNCTION upsert_hourly_tvl_delta_from_balance_change();
