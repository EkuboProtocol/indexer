CREATE INDEX ON oracle_snapshots (chain_id, emitter, token0, token1, event_id DESC)
    INCLUDE (snapshot_block_timestamp, snapshot_tick_cumulative);

CREATE OR REPLACE FUNCTION get_pool_tick_at_timestamp(
    p_pool_key_id int8,
    p_target_timestamp int8
) RETURNS int4
AS
$$
SELECT COALESCE(
               (SELECT tick_after
                FROM swaps s
                WHERE s.pool_key_id = p_pool_key_id
                  AND EXTRACT(EPOCH FROM block_time)::int8 <= p_target_timestamp
                ORDER BY event_id DESC
                LIMIT 1),
               (SELECT tick
                FROM pool_initializations pi
                         JOIN blocks b USING (chain_id, block_number)
                WHERE pi.pool_key_id = p_pool_key_id
                  AND EXTRACT(EPOCH FROM block_time)::int8 <= p_target_timestamp
                LIMIT 1)
       );
$$
    LANGUAGE sql
    STABLE;

CREATE OR REPLACE FUNCTION get_oracle_twap_tick(
    p_chain_id int8,
    p_oracle_extension NUMERIC,
    p_oracle_token NUMERIC,
    p_token NUMERIC,
    p_twap_duration_seconds int8
) RETURNS int4
AS
$$
DECLARE
    v_result int4;
BEGIN
    IF p_token = p_oracle_token THEN
        RETURN 0;
    END IF;

    WITH chain_bounds AS (SELECT EXTRACT(EPOCH FROM b.block_time)::int8 AS end_timestamp
                          FROM blocks b
                          WHERE b.chain_id = p_chain_id
                          ORDER BY b.block_number DESC
                          LIMIT 1),
         bounds AS (SELECT end_timestamp,
                           end_timestamp - p_twap_duration_seconds AS start_timestamp
                    FROM chain_bounds),
         pair_snapshots AS (
             -- canonicalize tick so it always represents token/oracle
             SELECT snapshot_block_timestamp,
                    snapshot_tick_cumulative,
                    event_id,
                    pk.pool_key_id,
                    1 AS tick_sign
             FROM oracle_snapshots os
                      JOIN pool_keys pk ON pk.chain_id = os.chain_id
                 AND pk.token0 = os.token0
                 AND pk.token1 = os.token1
                 AND pk.pool_extension = os.emitter
             WHERE os.chain_id = p_chain_id
               AND os.token0 = p_oracle_token
               AND os.token1 = p_token
               AND os.emitter = p_oracle_extension
             UNION ALL
             SELECT snapshot_block_timestamp,
                    -snapshot_tick_cumulative AS snapshot_tick_cumulative,
                    event_id,
                    pk.pool_key_id,
                    -1                        AS tick_sign
             FROM oracle_snapshots os
                      JOIN pool_keys pk ON pk.chain_id = os.chain_id
                 AND pk.token0 = os.token0
                 AND pk.token1 = os.token1
                 AND pk.pool_extension = os.emitter
             WHERE os.chain_id = p_chain_id
               AND os.token0 = p_token
               AND os.token1 = p_oracle_token
               AND os.emitter = p_oracle_extension),
         last_snapshot AS (SELECT *
                           FROM pair_snapshots
                           ORDER BY event_id DESC
                           LIMIT 1),
         start_snapshot AS (SELECT ps.*
                            FROM pair_snapshots ps
                                     JOIN last_snapshot ls ON ps.pool_key_id = ls.pool_key_id
                                     JOIN bounds b ON TRUE
                            WHERE ps.snapshot_block_timestamp <= b.start_timestamp
                            ORDER BY ps.snapshot_block_timestamp DESC
                            LIMIT 1),
         end_tick AS (SELECT get_pool_tick_at_timestamp(ls.pool_key_id, b.end_timestamp) AS tick
                      FROM last_snapshot ls
                               JOIN bounds b ON TRUE),
         start_tick AS (SELECT get_pool_tick_at_timestamp(ss.pool_key_id, b.start_timestamp) AS tick
                        FROM start_snapshot ss
                                 JOIN bounds b ON TRUE)
    SELECT ((
                (
                    ls.snapshot_tick_cumulative
                        + ((et.tick * ls.tick_sign)::int4 * GREATEST(b.end_timestamp - ls.snapshot_block_timestamp, 0))
                    )
                    - (
                    ss.snapshot_tick_cumulative
                        +
                    ((st.tick * ss.tick_sign)::int4 * GREATEST(b.start_timestamp - ss.snapshot_block_timestamp, 0))
                    )
                )
        / NULLIF(b.end_timestamp - b.start_timestamp, 0))
    INTO v_result
    FROM bounds b
             JOIN last_snapshot ls ON TRUE
             JOIN start_snapshot ss ON TRUE
             JOIN end_tick et ON TRUE
             JOIN start_tick st ON TRUE
    WHERE et.tick IS NOT NULL
      AND st.tick IS NOT NULL;

    RETURN v_result;
END;
$$
    LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_pair_twap_tick(
    p_chain_id int8,
    p_oracle_extension NUMERIC,
    p_oracle_token NUMERIC,
    p_base_token NUMERIC,
    p_quote_token NUMERIC,
    p_twap_duration_seconds int4
) RETURNS int4
AS
$$
DECLARE
    v_base_tick  NUMERIC;
    v_quote_tick NUMERIC;
BEGIN
    IF p_twap_duration_seconds <= 0 THEN
        RAISE EXCEPTION 'twap duration must be positive, received %', p_twap_duration_seconds;
    END IF;

    IF p_base_token = p_quote_token THEN
        RETURN 0;
    END IF;

    v_base_tick :=
            get_oracle_twap_tick(p_chain_id,
                                 p_oracle_extension,
                                 p_oracle_token,
                                 p_base_token,
                                 p_twap_duration_seconds);
    IF v_base_tick IS NULL THEN
        RETURN NULL;
    END IF;

    v_quote_tick := get_oracle_twap_tick(p_chain_id,
                                         p_oracle_extension,
                                         p_oracle_token,
                                         p_quote_token,
                                         p_twap_duration_seconds);

    RETURN v_quote_tick - v_base_tick;
END;
$$
    LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_oracle_usd_prices(
    p_chain_id int8,
    p_usdc_proxy_token NUMERIC,
    p_oracle_extension NUMERIC,
    p_oracle_token NUMERIC,
    p_twap_duration int4
)
    RETURNS TABLE
            (
                token_address NUMERIC,
                average_tick  int4,
                usd_price     NUMERIC
            )
    LANGUAGE sql
AS
$$
WITH tokens_with_oracle_pools AS (SELECT DISTINCT chain_id, token0 AS token_address
                                  FROM oracle_pool_states
                                           JOIN pool_keys USING (pool_key_id)

                                  UNION
                                  DISTINCT

                                  SELECT DISTINCT chain_id, token1 AS token_address
                                  FROM oracle_pool_states
                                           JOIN pool_keys USING (pool_key_id)),

     oracle_pool_tokens AS (SELECT *
                            FROM tokens_with_oracle_pools
                                     JOIN erc20_tokens USING (chain_id, token_address)
                            WHERE chain_id = p_chain_id
                            ORDER BY chain_id, token_address),

     usd_proxy_token AS (SELECT *
                         FROM oracle_pool_tokens
                         WHERE chain_id = p_chain_id
                           AND token_address = p_usdc_proxy_token),

     twap_ticks AS (SELECT opt.token_address,
                           get_pair_twap_tick(
                                   upt.chain_id,
                                   p_oracle_extension,
                                   p_oracle_token,
                                   opt.token_address,
                                   upt.token_address,
                                   p_twap_duration
                           )                                       AS average_tick,
                           opt.token_decimals - upt.token_decimals AS decimals_difference
                    FROM oracle_pool_tokens opt,
                         usd_proxy_token upt)

SELECT token_address,
       average_tick,
       POWER(1.000001::NUMERIC, average_tick)
           * POWER(10::NUMERIC, decimals_difference) AS usd_price
FROM twap_ticks;
$$;
