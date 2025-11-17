ALTER TABLE fees_accumulated ADD COLUMN block_time timestamptz;

ALTER TABLE fees_accumulated DISABLE TRIGGER no_updates_fees_accumulated;

UPDATE fees_accumulated fa
SET block_time = b.block_time
FROM blocks b
WHERE fa.block_time IS NULL
  AND fa.chain_id = b.chain_id
  AND fa.block_number = b.block_number;

ALTER TABLE fees_accumulated ALTER COLUMN block_time SET NOT NULL;

ALTER TABLE fees_accumulated ENABLE TRIGGER no_updates_fees_accumulated;

DROP TRIGGER IF EXISTS set_block_time_fees_accumulated ON fees_accumulated;

CREATE TRIGGER set_block_time_fees_accumulated
	BEFORE INSERT ON fees_accumulated
	FOR EACH ROW
	EXECUTE FUNCTION set_block_time_from_blocks();

DROP FUNCTION IF EXISTS upsert_hourly_volume_from_fees_accumulated();

CREATE FUNCTION upsert_hourly_volume_from_fees_accumulated()
RETURNS trigger AS $$
DECLARE
	rec fees_accumulated%ROWTYPE;
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

	v_hour := date_trunc('hour', rec.block_time);

	SELECT pk.token0,
	       pk.token1
	INTO STRICT v_token0,
	             v_token1
	FROM pool_keys pk
	WHERE pk.pool_key_id = rec.pool_key_id;

	IF rec.delta0 <> 0 THEN
		INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
		VALUES (rec.pool_key_id, v_hour, v_token0, 0, sign * rec.delta0)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET fees = hourly_volume_by_token.fees + EXCLUDED.fees;

		IF sign = -1 THEN
			DELETE FROM hourly_volume_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token0
			  AND volume = 0
			  AND fees = 0;
		END IF;
	END IF;

	IF rec.delta1 <> 0 THEN
		INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
		VALUES (rec.pool_key_id, v_hour, v_token1, 0, sign * rec.delta1)
		ON CONFLICT (pool_key_id, hour, token) DO UPDATE
		SET fees = hourly_volume_by_token.fees + EXCLUDED.fees;

		IF sign = -1 THEN
			DELETE FROM hourly_volume_by_token
			WHERE pool_key_id = rec.pool_key_id
			  AND hour = v_hour
			  AND token = v_token1
			  AND volume = 0
			  AND fees = 0;
		END IF;
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hourly_fees_accumulated ON fees_accumulated;

CREATE TRIGGER hourly_fees_accumulated
	AFTER INSERT OR DELETE ON fees_accumulated
	FOR EACH ROW
	EXECUTE FUNCTION upsert_hourly_volume_from_fees_accumulated();

WITH fee_token0 AS (
	SELECT
		fa.pool_key_id,
		date_trunc('hour', fa.block_time) AS hour,
		pk.token0 AS token,
		SUM(fa.delta0) AS fees
	FROM fees_accumulated fa
	JOIN pool_keys pk ON pk.pool_key_id = fa.pool_key_id
	WHERE fa.delta0 <> 0
	GROUP BY fa.pool_key_id, hour, pk.token0
	HAVING SUM(fa.delta0) <> 0
),
fee_token1 AS (
	SELECT
		fa.pool_key_id,
		date_trunc('hour', fa.block_time) AS hour,
		pk.token1 AS token,
		SUM(fa.delta1) AS fees
	FROM fees_accumulated fa
	JOIN pool_keys pk ON pk.pool_key_id = fa.pool_key_id
	WHERE fa.delta1 <> 0
	GROUP BY fa.pool_key_id, hour, pk.token1
	HAVING SUM(fa.delta1) <> 0
),
fee_totals AS (
	SELECT pool_key_id, hour, token, fees FROM fee_token0
	UNION ALL
	SELECT pool_key_id, hour, token, fees FROM fee_token1
)
INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
SELECT pool_key_id, hour, token, 0, fees
FROM fee_totals
ON CONFLICT (pool_key_id, hour, token) DO UPDATE
SET fees = hourly_volume_by_token.fees + EXCLUDED.fees;
