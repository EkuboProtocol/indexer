-- Use exact integer division in insert_twamm_hourly_volume (00137).
--
-- 00137 floored numeric quotients. Numeric division rounds its result to a
-- limited number of decimal places, so a quotient just below an integer can
-- round up to it and FLOOR then returns one too many. With 18-decimal token
-- amounts this happens. Spreading the net TWAMM volume over hours, the shares
-- could then add up to a few base units more than the total, and the remainder
-- placed on the last hour went negative: after the 00137 backfill, 3 of
-- 1,671,457 rows on Starknet were negative, by 13, 1 and 1 base units. div()
-- truncates exactly, which is the floor for these non-negative operands.
--
-- Only the function body changes; no table is locked or rewritten. Rows already
-- written are corrected separately by recomputing them, see the README.

CREATE OR REPLACE FUNCTION insert_twamm_hourly_volume(p_chain_id int8, p_event_id int8)
    RETURNS void AS
$$
DECLARE
    v_scale CONSTANT NUMERIC := 4294967296;
    cur              RECORD;
    prev             RECORD;
    v_token0         NUMERIC;
    v_token1         NUMERIC;
    v_extension      NUMERIC;
    v_rate0          NUMERIC;
    v_rate1          NUMERIC;
    v_swap0          NUMERIC;
    v_swap1          NUMERIC;
BEGIN
    SELECT voe.pool_key_id,
           voe.block_number,
           voe.transaction_index,
           voe.event_index,
           b.block_time
    INTO cur
    FROM twamm_virtual_order_executions voe
             JOIN blocks b ON b.chain_id = voe.chain_id AND b.block_number = voe.block_number
    WHERE voe.chain_id = p_chain_id
      AND voe.event_id = p_event_id;

    IF NOT found THEN
        RETURN;
    END IF;

    SELECT voe.event_id,
           voe.token0_sale_rate,
           voe.token1_sale_rate,
           b.block_time
    INTO prev
    FROM twamm_virtual_order_executions voe
             JOIN blocks b ON b.chain_id = voe.chain_id AND b.block_number = voe.block_number
    WHERE voe.pool_key_id = cur.pool_key_id
      AND voe.event_id < p_event_id
    ORDER BY voe.event_id DESC
    LIMIT 1;

    -- The first VOE of a pool is its initialization; nothing was sold before it.
    IF NOT found OR prev.block_time >= cur.block_time THEN
        RETURN;
    END IF;

    SELECT token0, token1, pool_extension
    INTO STRICT v_token0, v_token1, v_extension
    FROM pool_keys
    WHERE pool_key_id = cur.pool_key_id;

    -- Updates made after the previous VOE to orders already running at its
    -- time changed the rate immediately (twamm_pool_states does the same).
    SELECT prev.token0_sale_rate + COALESCE(SUM(sale_rate_delta0), 0),
           prev.token1_sale_rate + COALESCE(SUM(sale_rate_delta1), 0)
    INTO v_rate0, v_rate1
    FROM twamm_order_updates
    WHERE pool_key_id = cur.pool_key_id
      AND end_time > prev.block_time
      AND start_time <= prev.block_time
      AND event_id > prev.event_id
      AND event_id < p_event_id;

    SELECT COALESCE(SUM(GREATEST(delta0, 0)), 0),
           COALESCE(SUM(GREATEST(delta1, 0)), 0)
    INTO v_swap0, v_swap1
    FROM swaps
    WHERE chain_id = p_chain_id
      AND block_number = cur.block_number
      AND transaction_index = cur.transaction_index
      AND event_index < cur.event_index
      AND pool_key_id = cur.pool_key_id
      AND locker = v_extension;

    INSERT INTO twamm_hourly_volume_by_token (chain_id, event_id, pool_key_id, hour, token, volume)
    WITH boundaries AS (SELECT prev.block_time AS time, 0::NUMERIC AS d0, 0::NUMERIC AS d1
                        UNION ALL
                        SELECT time, SUM(d0), SUM(d1)
                        FROM (SELECT start_time AS time, sale_rate_delta0 AS d0, sale_rate_delta1 AS d1
                              FROM twamm_order_updates
                              WHERE pool_key_id = cur.pool_key_id
                                AND start_time > prev.block_time
                                AND start_time < cur.block_time
                                AND event_id < p_event_id
                              UNION ALL
                              SELECT end_time, -sale_rate_delta0, -sale_rate_delta1
                              FROM twamm_order_updates
                              WHERE pool_key_id = cur.pool_key_id
                                AND end_time > prev.block_time
                                AND end_time < cur.block_time
                                AND event_id < p_event_id) changes
                        GROUP BY time),
         segments AS (SELECT time                                                AS seg_start,
                             LEAD(time, 1, cur.block_time) OVER (ORDER BY time) AS seg_end,
                             v_rate0 + SUM(d0) OVER (ORDER BY time)             AS rate0,
                             v_rate1 + SUM(d1) OVER (ORDER BY time)             AS rate1
                      FROM boundaries),
         pieces AS (SELECT h.hour,
                           EXTRACT(EPOCH FROM LEAST(s.seg_end, h.hour + INTERVAL '1 hour')
                               - GREATEST(s.seg_start, h.hour))::NUMERIC AS seconds,
                           s.rate0,
                           s.rate1
                    FROM segments s
                             CROSS JOIN LATERAL generate_series(date_trunc('hour', s.seg_start), s.seg_end,
                                                                INTERVAL '1 hour') AS h(hour)
                    WHERE h.hour < s.seg_end),
         sold AS (SELECT hour,
                         SUM(div(rate0 * seconds, v_scale)) AS sold0,
                         SUM(div(rate1 * seconds, v_scale)) AS sold1
                  FROM pieces
                  WHERE seconds > 0
                  GROUP BY hour),
         totals AS (SELECT hour,
                           sold0,
                           sold1,
                           SUM(sold0) OVER ()                              AS total0,
                           SUM(sold1) OVER ()                              AS total1,
                           hour = MAX(hour) OVER ()                        AS is_last
                    FROM sold),
         shares AS (SELECT hour,
                           is_last,
                           GREATEST(total0 - v_swap0, 0) AS net0,
                           GREATEST(total1 - v_swap1, 0) AS net1,
                           CASE WHEN total0 = 0 THEN 0
                                ELSE div(GREATEST(total0 - v_swap0, 0) * sold0, total0) END AS share0,
                           CASE WHEN total1 = 0 THEN 0
                                ELSE div(GREATEST(total1 - v_swap1, 0) * sold1, total1) END AS share1
                    FROM totals),
         allocated AS (SELECT hour,
                              share0 + CASE WHEN is_last THEN net0 - SUM(share0) OVER () ELSE 0 END AS volume0,
                              share1 + CASE WHEN is_last THEN net1 - SUM(share1) OVER () ELSE 0 END AS volume1
                       FROM shares)
    SELECT p_chain_id, p_event_id, cur.pool_key_id, a.hour, t.token, t.volume
    FROM allocated a
             CROSS JOIN LATERAL (VALUES (v_token0, a.volume0), (v_token1, a.volume1)) AS t(token, volume)
    WHERE t.volume <> 0
    ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;
-- Recomputes one chain's already-applied VOEs with the corrected function,
-- oldest first, in batches. Each VOE's rows are deleted (which takes them back
-- out of hourly_volume_by_token) and written again in the same transaction, so
-- readers never see the volume missing. Pass the returned last_event_id back in
-- to continue; stop when examined is 0. Safe to rerun.
CREATE FUNCTION recompute_twamm_hourly_volume(p_chain_id int8, p_after_event_id int8, p_limit int4)
    RETURNS TABLE (examined int4, last_event_id int8) AS
$$
DECLARE
    rec RECORD;
BEGIN
    examined := 0;
    last_event_id := p_after_event_id;

    FOR rec IN
        SELECT DISTINCT t.event_id
        FROM twamm_hourly_volume_by_token t
        WHERE t.chain_id = p_chain_id
          AND t.event_id > p_after_event_id
        ORDER BY t.event_id
        LIMIT p_limit
        LOOP
            DELETE FROM twamm_hourly_volume_by_token WHERE chain_id = p_chain_id AND event_id = rec.event_id;
            PERFORM insert_twamm_hourly_volume(p_chain_id, rec.event_id);
            examined := examined + 1;
            last_event_id := rec.event_id;
        END LOOP;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
