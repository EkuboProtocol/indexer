ALTER TABLE ve33_pool_fees_accounted
    ADD COLUMN block_time timestamptz;

ALTER TABLE ve33_pool_fees_accounted DISABLE TRIGGER no_updates_ve33_pool_fees_accounted;

UPDATE ve33_pool_fees_accounted pfa
SET block_time = b.block_time
FROM blocks b
WHERE pfa.block_time IS NULL
  AND pfa.chain_id = b.chain_id
  AND pfa.block_number = b.block_number;

ALTER TABLE ve33_pool_fees_accounted
    ALTER COLUMN block_time SET NOT NULL;

ALTER TABLE ve33_pool_fees_accounted ENABLE TRIGGER no_updates_ve33_pool_fees_accounted;

CREATE TRIGGER set_block_time_ve33_pool_fees_accounted
    BEFORE INSERT ON ve33_pool_fees_accounted
    FOR EACH ROW
    EXECUTE FUNCTION set_block_time_from_blocks();

CREATE FUNCTION upsert_hourly_fees_from_ve33_pool_fees_accounted()
RETURNS trigger AS $$
DECLARE
    rec ve33_pool_fees_accounted%ROWTYPE;
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

    IF rec.pool_key_id IS NULL OR (rec.amount0 = 0 AND rec.amount1 = 0) THEN
        RETURN NULL;
    END IF;

    SELECT pk.token0,
           pk.token1
    INTO STRICT v_token0,
                v_token1
    FROM pool_keys pk
    WHERE pk.pool_key_id = rec.pool_key_id;

    v_hour := date_trunc('hour', rec.block_time);

    IF rec.amount0 <> 0 THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
        VALUES (rec.pool_key_id, v_hour, v_token0, 0, sign * rec.amount0)
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

    IF rec.amount1 <> 0 THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
        VALUES (rec.pool_key_id, v_hour, v_token1, 0, sign * rec.amount1)
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

CREATE TRIGGER hourly_ve33_pool_fees_accounted
    AFTER INSERT OR DELETE ON ve33_pool_fees_accounted
    FOR EACH ROW
    EXECUTE FUNCTION upsert_hourly_fees_from_ve33_pool_fees_accounted();

WITH fee_token0 AS (
    SELECT
        pfa.pool_key_id,
        date_trunc('hour', pfa.block_time) AS hour,
        pk.token0 AS token,
        SUM(pfa.amount0) AS fees
    FROM ve33_pool_fees_accounted pfa
    JOIN pool_keys pk ON pk.pool_key_id = pfa.pool_key_id
    WHERE pfa.amount0 <> 0
    GROUP BY pfa.pool_key_id, hour, pk.token0
    HAVING SUM(pfa.amount0) <> 0
),
fee_token1 AS (
    SELECT
        pfa.pool_key_id,
        date_trunc('hour', pfa.block_time) AS hour,
        pk.token1 AS token,
        SUM(pfa.amount1) AS fees
    FROM ve33_pool_fees_accounted pfa
    JOIN pool_keys pk ON pk.pool_key_id = pfa.pool_key_id
    WHERE pfa.amount1 <> 0
    GROUP BY pfa.pool_key_id, hour, pk.token1
    HAVING SUM(pfa.amount1) <> 0
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
