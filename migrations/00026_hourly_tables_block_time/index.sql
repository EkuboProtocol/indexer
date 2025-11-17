ALTER TABLE swaps ADD COLUMN block_time timestamptz;
ALTER TABLE protocol_fees_paid ADD COLUMN block_time timestamptz;
ALTER TABLE pool_balance_change ADD COLUMN block_time timestamptz;

ALTER TABLE swaps DISABLE TRIGGER no_updates_swaps;
ALTER TABLE protocol_fees_paid DISABLE TRIGGER no_updates_protocol_fees_paid;
ALTER TABLE pool_balance_change DISABLE TRIGGER no_updates_pool_balance_change;

UPDATE swaps s
SET block_time = b.block_time
FROM blocks b
WHERE s.block_time IS NULL
  AND s.chain_id = b.chain_id
  AND s.block_number = b.block_number;

UPDATE protocol_fees_paid p
SET block_time = b.block_time
FROM blocks b
WHERE p.block_time IS NULL
  AND p.chain_id = b.chain_id
  AND p.block_number = b.block_number;

UPDATE pool_balance_change c
SET block_time = b.block_time
FROM blocks b
WHERE c.block_time IS NULL
  AND c.chain_id = b.chain_id
  AND c.block_number = b.block_number;

ALTER TABLE swaps ALTER COLUMN block_time SET NOT NULL;
ALTER TABLE protocol_fees_paid ALTER COLUMN block_time SET NOT NULL;
ALTER TABLE pool_balance_change ALTER COLUMN block_time SET NOT NULL;

ALTER TABLE swaps ENABLE TRIGGER no_updates_swaps;
ALTER TABLE protocol_fees_paid ENABLE TRIGGER no_updates_protocol_fees_paid;
ALTER TABLE pool_balance_change ENABLE TRIGGER no_updates_pool_balance_change;

CREATE OR REPLACE FUNCTION set_block_time_from_blocks()
RETURNS trigger AS $$
BEGIN
	IF NEW.block_time IS NOT NULL THEN
		RETURN NEW;
	END IF;

	SELECT b.block_time
	INTO STRICT NEW.block_time
	FROM blocks b
	WHERE b.chain_id = NEW.chain_id
	  AND b.block_number = NEW.block_number;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_block_time_swaps ON swaps;
DROP TRIGGER IF EXISTS set_block_time_protocol_fees_paid ON protocol_fees_paid;
DROP TRIGGER IF EXISTS set_block_time_pool_balance_change ON pool_balance_change;

CREATE TRIGGER set_block_time_swaps
	BEFORE INSERT ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION set_block_time_from_blocks();

CREATE TRIGGER set_block_time_protocol_fees_paid
	BEFORE INSERT ON protocol_fees_paid
	FOR EACH ROW
	EXECUTE FUNCTION set_block_time_from_blocks();

CREATE TRIGGER set_block_time_pool_balance_change
	BEFORE INSERT ON pool_balance_change
	FOR EACH ROW
	EXECUTE FUNCTION set_block_time_from_blocks();

DROP TRIGGER IF EXISTS hourly_swap_metrics ON swaps;
DROP TRIGGER IF EXISTS hourly_protocol_revenue ON protocol_fees_paid;
DROP TRIGGER IF EXISTS hourly_tvl_delta_from_balance_change ON pool_balance_change;

DROP FUNCTION IF EXISTS upsert_hourly_swap_metrics();
DROP FUNCTION IF EXISTS upsert_hourly_revenue_from_protocol_fee();
DROP FUNCTION IF EXISTS upsert_hourly_tvl_delta_from_balance_change();

CREATE FUNCTION upsert_hourly_swap_metrics()
RETURNS trigger AS $$
DECLARE
	rec swaps%ROWTYPE;
	sign int := 1;
	v_hour timestamptz;
	v_token0 NUMERIC;
	v_token1 NUMERIC;
	v_fee NUMERIC;
	v_fee_denominator NUMERIC;
	v_volume0 NUMERIC := 0;
	v_volume1 NUMERIC := 0;
	v_fees0 NUMERIC := 0;
	v_fees1 NUMERIC := 0;
	v_k_volume NUMERIC := 0;
	v_total NUMERIC := 0;
BEGIN
	IF TG_OP = 'DELETE' THEN
		rec := OLD;
		sign := -1;
	ELSE
		rec := NEW;
	END IF;

	SELECT pk.token0,
	       pk.token1,
	       pk.fee,
	       pk.fee_denominator
	INTO STRICT v_token0,
	             v_token1,
	             v_fee,
	             v_fee_denominator
	FROM pool_keys pk
	WHERE pk.pool_key_id = rec.pool_key_id;

	v_hour := date_trunc('hour', rec.block_time);

	IF rec.delta0 > 0 THEN
		v_volume0 := rec.delta0;
		v_fees0 := CEIL((rec.delta0 * v_fee) / v_fee_denominator);
	END IF;

	IF rec.delta1 > 0 THEN
		v_volume1 := rec.delta1;
		v_fees1 := CEIL((rec.delta1 * v_fee) / v_fee_denominator);
	END IF;

	v_k_volume := abs(rec.delta0 * rec.delta1);
	v_total := rec.delta1 * rec.delta1;

	IF v_volume0 <> 0 THEN
		INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
		VALUES (rec.pool_key_id, v_hour, v_token0, sign * v_volume0, sign * v_fees0)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET volume = hourly_volume_by_token.volume + EXCLUDED.volume,
		    fees = hourly_volume_by_token.fees + EXCLUDED.fees;

		IF sign = -1 THEN
			DELETE FROM hourly_volume_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token0
			  AND volume = 0
			  AND fees = 0;
		END IF;
	END IF;

	IF v_volume1 <> 0 THEN
		INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
		VALUES (rec.pool_key_id, v_hour, v_token1, sign * v_volume1, sign * v_fees1)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET volume = hourly_volume_by_token.volume + EXCLUDED.volume,
		    fees = hourly_volume_by_token.fees + EXCLUDED.fees;

		IF sign = -1 THEN
			DELETE FROM hourly_volume_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token1
			  AND volume = 0
			  AND fees = 0;
		END IF;
	END IF;

	IF v_k_volume <> 0 OR v_total <> 0 THEN
		INSERT INTO hourly_price_data (chain_id, token0, token1, hour, k_volume, total)
		VALUES (rec.chain_id, v_token0, v_token1, v_hour, sign * v_k_volume, sign * v_total)
		ON CONFLICT (chain_id, token0, token1, hour) DO UPDATE
		SET k_volume = hourly_price_data.k_volume + EXCLUDED.k_volume,
		    total = hourly_price_data.total + EXCLUDED.total;

		IF sign = -1 THEN
			DELETE FROM hourly_price_data
			WHERE chain_id = rec.chain_id
			  AND token0 = v_token0
			  AND token1 = v_token1
			  AND hour = v_hour
			  AND k_volume = 0
			  AND total = 0;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_hourly_revenue_from_protocol_fee()
RETURNS trigger AS $$
DECLARE
	rec protocol_fees_paid%ROWTYPE;
	sign int := 1;
	v_hour timestamptz;
	v_token0 NUMERIC;
	v_token1 NUMERIC;
BEGIN
	IF TG_OP = 'DELETE' THEN
		rec := OLD;
		sign := -1;
	ELSE
		rec := NEW;
	END IF;

	IF rec.delta0 = 0 AND rec.delta1 = 0 THEN
		RETURN NULL;
	END IF;

	SELECT pk.token0,
	       pk.token1
	INTO STRICT v_token0,
	             v_token1
	FROM pool_keys pk
	WHERE pk.pool_key_id = rec.pool_key_id;

	v_hour := date_trunc('hour', rec.block_time);

	IF rec.delta0 <> 0 THEN
		INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
		VALUES (rec.pool_key_id, v_hour, v_token0, sign * -rec.delta0)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET revenue = hourly_revenue_by_token.revenue + EXCLUDED.revenue;

		IF sign = -1 THEN
			DELETE FROM hourly_revenue_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token0
			  AND revenue = 0;
		END IF;
	END IF;

	IF rec.delta1 <> 0 THEN
		INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
		VALUES (rec.pool_key_id, v_hour, v_token1, sign * -rec.delta1)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET revenue = hourly_revenue_by_token.revenue + EXCLUDED.revenue;

		IF sign = -1 THEN
			DELETE FROM hourly_revenue_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token1
			  AND revenue = 0;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_hourly_tvl_delta_from_balance_change()
RETURNS trigger AS $$
DECLARE
	rec pool_balance_change%ROWTYPE;
	sign int := 1;
	v_hour timestamptz;
	v_token0 NUMERIC;
	v_token1 NUMERIC;
BEGIN
	IF TG_OP = 'DELETE' THEN
		rec := OLD;
		sign := -1;
	ELSE
		rec := NEW;
	END IF;

	IF rec.delta0 = 0 AND rec.delta1 = 0 THEN
		RETURN NULL;
	END IF;

	SELECT pk.token0,
	       pk.token1
	INTO STRICT v_token0,
	             v_token1
	FROM pool_keys pk
	WHERE pk.pool_key_id = rec.pool_key_id;

	v_hour := date_trunc('hour', rec.block_time);

	IF rec.delta0 <> 0 THEN
		INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
		VALUES (rec.pool_key_id, v_hour, v_token0, sign * rec.delta0)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET delta = hourly_tvl_delta_by_token.delta + EXCLUDED.delta;

		IF sign = -1 THEN
			DELETE FROM hourly_tvl_delta_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token0
			  AND delta = 0;
		END IF;
	END IF;

	IF rec.delta1 <> 0 THEN
		INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
		VALUES (rec.pool_key_id, v_hour, v_token1, sign * rec.delta1)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET delta = hourly_tvl_delta_by_token.delta + EXCLUDED.delta;

		IF sign = -1 THEN
			DELETE FROM hourly_tvl_delta_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token1
			  AND delta = 0;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hourly_swap_metrics
	AFTER INSERT OR DELETE ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION upsert_hourly_swap_metrics();

CREATE TRIGGER hourly_protocol_revenue
	AFTER INSERT OR DELETE ON protocol_fees_paid
	FOR EACH ROW
	EXECUTE FUNCTION upsert_hourly_revenue_from_protocol_fee();

CREATE TRIGGER hourly_tvl_delta_from_balance_change
	AFTER INSERT OR DELETE ON pool_balance_change
	FOR EACH ROW
	EXECUTE FUNCTION upsert_hourly_tvl_delta_from_balance_change();

TRUNCATE TABLE
	hourly_volume_by_token,
	hourly_price_data,
	hourly_tvl_delta_by_token,
	hourly_revenue_by_token;

WITH swap_token0 AS (
	SELECT
		s.pool_key_id,
		date_trunc('hour', s.block_time) AS hour,
		pk.token0 AS token,
		SUM(CASE WHEN s.delta0 > 0 THEN s.delta0 ELSE 0 END) AS volume,
		SUM(CASE WHEN s.delta0 > 0 THEN CEIL((s.delta0 * pk.fee) / pk.fee_denominator) ELSE 0 END) AS fees
	FROM swaps s
	JOIN pool_keys pk ON pk.pool_key_id = s.pool_key_id
	GROUP BY s.pool_key_id, hour, pk.token0
	HAVING SUM(CASE WHEN s.delta0 > 0 THEN s.delta0 ELSE 0 END) <> 0
),
swap_token1 AS (
	SELECT
		s.pool_key_id,
		date_trunc('hour', s.block_time) AS hour,
		pk.token1 AS token,
		SUM(CASE WHEN s.delta1 > 0 THEN s.delta1 ELSE 0 END) AS volume,
		SUM(CASE WHEN s.delta1 > 0 THEN CEIL((s.delta1 * pk.fee) / pk.fee_denominator) ELSE 0 END) AS fees
	FROM swaps s
	JOIN pool_keys pk ON pk.pool_key_id = s.pool_key_id
	GROUP BY s.pool_key_id, hour, pk.token1
	HAVING SUM(CASE WHEN s.delta1 > 0 THEN s.delta1 ELSE 0 END) <> 0
)
INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
SELECT * FROM swap_token0
UNION ALL
SELECT * FROM swap_token1;

INSERT INTO hourly_price_data (chain_id, token0, token1, hour, k_volume, total)
SELECT
	s.chain_id,
	pk.token0,
	pk.token1,
	date_trunc('hour', s.block_time) AS hour,
	SUM(ABS(s.delta0 * s.delta1)) AS k_volume,
	SUM(s.delta1 * s.delta1) AS total
FROM swaps s
JOIN pool_keys pk ON pk.pool_key_id = s.pool_key_id
GROUP BY s.chain_id, pk.token0, pk.token1, hour
HAVING SUM(ABS(s.delta0 * s.delta1)) <> 0 OR SUM(s.delta1 * s.delta1) <> 0;

WITH protocol_token0 AS (
	SELECT
		p.pool_key_id,
		date_trunc('hour', p.block_time) AS hour,
		pk.token0 AS token,
		SUM(-p.delta0) AS revenue
	FROM protocol_fees_paid p
	JOIN pool_keys pk ON pk.pool_key_id = p.pool_key_id
	WHERE p.delta0 <> 0
	GROUP BY p.pool_key_id, hour, pk.token0
),
protocol_token1 AS (
	SELECT
		p.pool_key_id,
		date_trunc('hour', p.block_time) AS hour,
		pk.token1 AS token,
		SUM(-p.delta1) AS revenue
	FROM protocol_fees_paid p
	JOIN pool_keys pk ON pk.pool_key_id = p.pool_key_id
	WHERE p.delta1 <> 0
	GROUP BY p.pool_key_id, hour, pk.token1
)
INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
SELECT * FROM protocol_token0
UNION ALL
SELECT * FROM protocol_token1;

WITH balance_token0 AS (
	SELECT
		c.pool_key_id,
		date_trunc('hour', c.block_time) AS hour,
		pk.token0 AS token,
		SUM(c.delta0) AS delta
	FROM pool_balance_change c
	JOIN pool_keys pk ON pk.pool_key_id = c.pool_key_id
	WHERE c.delta0 <> 0
	GROUP BY c.pool_key_id, hour, pk.token0
),
balance_token1 AS (
	SELECT
		c.pool_key_id,
		date_trunc('hour', c.block_time) AS hour,
		pk.token1 AS token,
		SUM(c.delta1) AS delta
	FROM pool_balance_change c
	JOIN pool_keys pk ON pk.pool_key_id = c.pool_key_id
	WHERE c.delta1 <> 0
	GROUP BY c.pool_key_id, hour, pk.token1
)
INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
SELECT * FROM balance_token0
UNION ALL
SELECT * FROM balance_token1;
