ALTER TABLE hourly_volume_by_token
    ADD COLUMN ve33_fees NUMERIC NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION upsert_hourly_fees_from_ve33_pool_fees_accounted()
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

    IF rec.amount0 = 0 AND rec.amount1 = 0 THEN
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
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, ve33_fees)
        VALUES (rec.pool_key_id, v_hour, v_token0, 0, sign * rec.amount0, sign * rec.amount0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET fees = hourly_volume_by_token.fees + EXCLUDED.fees,
            ve33_fees = hourly_volume_by_token.ve33_fees + EXCLUDED.ve33_fees;

        IF sign = -1 THEN
            DELETE FROM hourly_volume_by_token
            WHERE pool_key_id = rec.pool_key_id
              AND hour = v_hour
              AND token = v_token0
              AND volume = 0
              AND fees = 0
              AND ve33_fees = 0;
        END IF;
    END IF;

    IF rec.amount1 <> 0 THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, ve33_fees)
        VALUES (rec.pool_key_id, v_hour, v_token1, 0, sign * rec.amount1, sign * rec.amount1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
        SET fees = hourly_volume_by_token.fees + EXCLUDED.fees,
            ve33_fees = hourly_volume_by_token.ve33_fees + EXCLUDED.ve33_fees;

        IF sign = -1 THEN
            DELETE FROM hourly_volume_by_token
            WHERE pool_key_id = rec.pool_key_id
              AND hour = v_hour
              AND token = v_token1
              AND volume = 0
              AND fees = 0
              AND ve33_fees = 0;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

WITH fee_token0 AS (
    SELECT pfa.pool_key_id,
           date_trunc('hour', pfa.block_time) AS hour,
           pk.token0 AS token,
           SUM(pfa.amount0) AS ve33_fees
    FROM ve33_pool_fees_accounted pfa
             JOIN pool_keys pk USING (pool_key_id)
    WHERE pfa.amount0 <> 0
    GROUP BY pfa.pool_key_id, hour, pk.token0
    HAVING SUM(pfa.amount0) <> 0
),
fee_token1 AS (
    SELECT pfa.pool_key_id,
           date_trunc('hour', pfa.block_time) AS hour,
           pk.token1 AS token,
           SUM(pfa.amount1) AS ve33_fees
    FROM ve33_pool_fees_accounted pfa
             JOIN pool_keys pk USING (pool_key_id)
    WHERE pfa.amount1 <> 0
    GROUP BY pfa.pool_key_id, hour, pk.token1
    HAVING SUM(pfa.amount1) <> 0
),
fee_totals AS (
    SELECT pool_key_id, hour, token, ve33_fees FROM fee_token0
    UNION ALL
    SELECT pool_key_id, hour, token, ve33_fees FROM fee_token1
)
INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, ve33_fees)
SELECT pool_key_id, hour, token, 0, ve33_fees, ve33_fees
FROM fee_totals
ON CONFLICT (pool_key_id, hour, token) DO UPDATE
SET ve33_fees = EXCLUDED.ve33_fees;

DROP MATERIALIZED VIEW IF EXISTS last_24h_pool_stats_materialized;
DROP VIEW IF EXISTS last_24h_pool_stats_view;

CREATE VIEW last_24h_pool_stats_view AS
WITH volume AS (SELECT vbt.pool_key_id,
                       SUM(vbt.volume)
                           FILTER (WHERE vbt.token = pk.token0) AS volume0,
                       SUM(vbt.volume)
                           FILTER (WHERE vbt.token = pk.token1) AS volume1,
                       SUM(vbt.fees)
                           FILTER (WHERE vbt.token = pk.token0) AS fees0,
                       SUM(vbt.fees)
                           FILTER (WHERE vbt.token = pk.token1) AS fees1,
                       SUM(vbt.ve33_fees)
                           FILTER (WHERE vbt.token = pk.token0) AS ve33_fees0,
                       SUM(vbt.ve33_fees)
                           FILTER (WHERE vbt.token = pk.token1) AS ve33_fees1
                FROM hourly_volume_by_token vbt
                         JOIN pool_keys pk USING (pool_key_id)
                WHERE hour >= NOW() - INTERVAL '24 hours'
                GROUP BY vbt.pool_key_id),
     tvl_delta_24h AS (SELECT tbt.pool_key_id,
                              SUM(
                                      CASE
                                          WHEN token = token0 THEN delta
                                          ELSE 0
                                          END
                              ) AS tvl0,
                              SUM(
                                      CASE
                                          WHEN token = token1 THEN delta
                                          ELSE 0
                                          END
                              ) AS tvl1
                       FROM hourly_tvl_delta_by_token tbt
                                JOIN pool_keys pk ON tbt.pool_key_id = pk.pool_key_id
                       WHERE hour >= NOW() - INTERVAL '24 hours'
                       GROUP BY tbt.pool_key_id)
SELECT ptvl.pool_key_id,
       ptvl.balance0                        AS tvl0_total,
       ptvl.balance1                        AS tvl1_total,
       COALESCE(volume.volume0, 0)          AS volume0_24h,
       COALESCE(volume.volume1, 0)          AS volume1_24h,
       COALESCE(volume.fees0, 0)            AS fees0_24h,
       COALESCE(volume.fees1, 0)            AS fees1_24h,
       COALESCE(volume.ve33_fees0, 0)       AS ve33_fees0_24h,
       COALESCE(volume.ve33_fees1, 0)       AS ve33_fees1_24h,
       COALESCE(tvl_delta_24h.tvl0, 0)      AS tvl0_delta_24h,
       COALESCE(tvl_delta_24h.tvl1, 0)      AS tvl1_delta_24h
FROM pool_tvl ptvl
         LEFT JOIN volume USING (pool_key_id)
         LEFT JOIN tvl_delta_24h USING (pool_key_id)
ORDER BY ptvl.pool_key_id;

CREATE MATERIALIZED VIEW last_24h_pool_stats_materialized AS
SELECT pool_key_id,
       tvl0_total,
       tvl1_total,
       volume0_24h,
       volume1_24h,
       fees0_24h,
       fees1_24h,
       ve33_fees0_24h,
       ve33_fees1_24h,
       tvl0_delta_24h,
       tvl1_delta_24h
FROM last_24h_pool_stats_view;

CREATE UNIQUE INDEX ON last_24h_pool_stats_materialized (pool_key_id);
