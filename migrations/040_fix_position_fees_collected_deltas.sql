ALTER TABLE position_fees_collected
    DISABLE TRIGGER no_updates_position_fees_collected;
ALTER TABLE pool_balance_change
    DISABLE TRIGGER no_updates_pool_balance_change;

WITH corrected AS (SELECT chain_id,
                          event_id,
                          CASE WHEN delta0 > 0 THEN -delta0 ELSE delta0 END AS new_delta0,
                          CASE WHEN delta1 > 0 THEN -delta1 ELSE delta1 END AS new_delta1
                   FROM position_fees_collected
                   WHERE delta0 > 0
                      OR delta1 > 0),
     updated AS (
         UPDATE position_fees_collected p
             SET
                 delta0 = c.new_delta0,
                 delta1 = c.new_delta1
             FROM corrected c
             WHERE p.chain_id = c.chain_id
                 AND p.event_id = c.event_id
             RETURNING p.chain_id, p.event_id, c.new_delta0, c.new_delta1)
UPDATE pool_balance_change c
SET delta0 = u.new_delta0,
    delta1 = u.new_delta1
FROM updated u
WHERE c.chain_id = u.chain_id
  AND c.event_id = u.event_id;

TRUNCATE TABLE pool_tvl;

INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
SELECT pool_key_id,
       COALESCE(SUM(delta0), 0),
       COALESCE(SUM(delta1), 0)
FROM pool_balance_change
GROUP BY pool_key_id;

TRUNCATE TABLE hourly_tvl_delta_by_token;

WITH combined AS (SELECT c.pool_key_id,
                         DATE_TRUNC('hour', c.block_time) AS hour,
                         pk.token0                        AS token,
                         c.delta0                         AS delta
                  FROM pool_balance_change c
                           JOIN pool_keys pk ON pk.pool_key_id = c.pool_key_id
                  WHERE c.delta0 <> 0

                  UNION ALL

                  SELECT c.pool_key_id,
                         DATE_TRUNC('hour', c.block_time) AS hour,
                         pk.token1                        AS token,
                         c.delta1                         AS delta
                  FROM pool_balance_change c
                           JOIN pool_keys pk ON pk.pool_key_id = c.pool_key_id
                  WHERE c.delta1 <> 0),
     aggregated AS (SELECT pool_key_id,
                           hour,
                           token,
                           SUM(delta) AS delta
                    FROM combined
                    GROUP BY pool_key_id, hour, token
                    HAVING SUM(delta) <> 0)
INSERT
INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
SELECT pool_key_id,
       hour,
       token,
       delta
FROM aggregated;

ALTER TABLE position_fees_collected
    ENABLE TRIGGER no_updates_position_fees_collected;
ALTER TABLE pool_balance_change
    ENABLE TRIGGER no_updates_pool_balance_change;
