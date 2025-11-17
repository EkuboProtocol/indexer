DROP MATERIALIZED VIEW IF EXISTS last_24h_pool_stats_materialized;
DROP VIEW IF EXISTS last_24h_pool_stats_view;

CREATE VIEW last_24h_pool_stats_view AS
WITH volume AS (SELECT pool_key_id,
                       SUM(
                               CASE
                                   WHEN vbt.token = token0 THEN vbt.volume
                                   ELSE 0
                                   END
                       ) AS volume0,
                       SUM(
                               CASE
                                   WHEN vbt.token = token1 THEN vbt.volume
                                   ELSE 0
                                   END
                       ) AS volume1,
                       SUM(
                               CASE
                                   WHEN vbt.token = token0 THEN vbt.fees
                                   ELSE 0
                                   END
                       ) AS fees0,
                       SUM(
                               CASE
                                   WHEN vbt.token = token1 THEN vbt.fees
                                   ELSE 0
                                   END
                       ) AS fees1
                FROM hourly_volume_by_token vbt
                         JOIN pool_keys USING (pool_key_id)
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
SELECT pool_key_id,
       ptvl.balance0                   AS tvl0_total,
       ptvl.balance1                   AS tvl1_total,
       COALESCE(volume.volume0, 0)     AS volume0_24h,
       COALESCE(volume.volume1, 0)     AS volume1_24h,
       COALESCE(volume.fees0, 0)       AS fees0_24h,
       COALESCE(volume.fees1, 0)       AS fees1_24h,
       COALESCE(tvl_delta_24h.tvl0, 0) AS tvl0_delta_24h,
       COALESCE(tvl_delta_24h.tvl1, 0) AS tvl1_delta_24h
FROM pool_tvl ptvl
         LEFT JOIN volume USING (pool_key_id)
         LEFT JOIN tvl_delta_24h USING (pool_key_id)
ORDER BY pool_key_id;

CREATE MATERIALIZED VIEW last_24h_pool_stats_materialized AS
SELECT pool_key_id,
       tvl0_total,
       tvl1_total,
       volume0_24h,
       volume1_24h,
       fees0_24h,
       fees1_24h,
       tvl0_delta_24h,
       tvl1_delta_24h
FROM last_24h_pool_stats_view;

CREATE UNIQUE INDEX ON last_24h_pool_stats_materialized (pool_key_id);
