-- Count TWAMM order execution in hourly_volume_by_token without counting the
-- extension's own core swaps twice (EkuboProtocol/indexer#7).
--
-- Until now hourly volume came only from the swaps trigger. When a TWAMM pool
-- executes virtual orders, the two order sides are matched against each other
-- and only the imbalance reaches core as a swap whose locker is the TWAMM
-- extension. So the hourly table saw that net swap and nothing of the rest of
-- what the orders sold.
--
-- Each virtual order execution (VOE) now records what the orders sold since the
-- pool's previous VOE: sale_rate * seconds / 2^32 per token, over every period
-- of constant sale rate, split at hour boundaries. The rates are rebuilt from
-- the previous VOE's rates plus the order updates seen before this VOE, the
-- same inputs recompute_twamm_pool_state uses. The extension's core swaps for
-- this execution (same transaction, same pool, locker = pool extension, before
-- the VOE) are already in the hourly table through the swaps trigger, so their
-- input amount is taken back out of the TWAMM contribution, spread over the
-- hours in proportion to what was sold in each, which keeps every hour
-- non-negative. Per token, ordinary swaps + this contribution = ordinary swaps
-- + everything the orders sold. Fees are untouched: they are only charged on
-- the core swap, which the swaps trigger already counts.
--
-- Amounts are floored per (constant-rate period x hour) piece. The contract
-- floors per period between initialized times, so the total can differ from
-- the contract's by a few base units per hour piece; that is noise for volume.
--
-- The contribution is stored per VOE in twamm_hourly_volume_by_token, whose
-- triggers add it to and remove it from hourly_volume_by_token. Its rows
-- cascade from the VOE, so a reorg removes exactly what was added, regardless
-- of the order in which the block's other rows are deleted. The primary key
-- makes applying a VOE twice a no-op.
--
-- History is not backfilled here. backfill_twamm_hourly_volume is idempotent
-- and resumable; run it separately, see the README.
--
-- Locks: CREATE INDEX on twamm_order_updates (SHARE) and CREATE TRIGGER on
-- twamm_virtual_order_executions (SHARE ROW EXCLUSIVE) conflict with the
-- workers' writes, so park them on blocks first (the 00120/00123 pattern).
SET LOCAL lock_timeout = '15min';
LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX twamm_order_updates_pool_key_id_start_time_idx
    ON twamm_order_updates (pool_key_id, start_time);
CREATE INDEX twamm_order_updates_pool_key_id_end_time_idx
    ON twamm_order_updates (pool_key_id, end_time);

CREATE TABLE twamm_hourly_volume_by_token
(
    chain_id    int8        NOT NULL,
    event_id    int8        NOT NULL,
    pool_key_id int8        NOT NULL,
    hour        timestamptz NOT NULL,
    token       NUMERIC     NOT NULL,
    volume      NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id, hour, token),
    FOREIGN KEY (chain_id, event_id)
        REFERENCES twamm_virtual_order_executions (chain_id, event_id) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_twamm_hourly_volume_by_token
    BEFORE UPDATE
    ON twamm_hourly_volume_by_token
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE FUNCTION apply_twamm_hourly_volume()
    RETURNS trigger AS
$$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees)
        VALUES (NEW.pool_key_id, NEW.hour, NEW.token, NEW.volume, 0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET volume = hourly_volume_by_token.volume + EXCLUDED.volume;
    ELSE
        UPDATE hourly_volume_by_token
        SET volume = volume - OLD.volume
        WHERE pool_key_id = OLD.pool_key_id
          AND hour = OLD.hour
          AND token = OLD.token;

        DELETE
        FROM hourly_volume_by_token
        WHERE pool_key_id = OLD.pool_key_id
          AND hour = OLD.hour
          AND token = OLD.token
          AND volume = 0
          AND fees = 0
          AND ve33_fees = 0;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER apply_twamm_hourly_volume
    AFTER INSERT OR DELETE
    ON twamm_hourly_volume_by_token
    FOR EACH ROW
EXECUTE FUNCTION apply_twamm_hourly_volume();

CREATE FUNCTION insert_twamm_hourly_volume(p_chain_id int8, p_event_id int8)
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
                         SUM(FLOOR(rate0 * seconds / v_scale)) AS sold0,
                         SUM(FLOOR(rate1 * seconds / v_scale)) AS sold1
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
                                ELSE FLOOR(GREATEST(total0 - v_swap0, 0) * sold0 / total0) END AS share0,
                           CASE WHEN total1 = 0 THEN 0
                                ELSE FLOOR(GREATEST(total1 - v_swap1, 0) * sold1 / total1) END AS share1
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

CREATE FUNCTION twamm_hourly_volume_on_voe_insert()
    RETURNS trigger AS
$$
BEGIN
    PERFORM insert_twamm_hourly_volume(NEW.chain_id, NEW.event_id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER twamm_hourly_volume
    AFTER INSERT
    ON twamm_virtual_order_executions
    FOR EACH ROW
EXECUTE FUNCTION twamm_hourly_volume_on_voe_insert();

-- Applies one chain's VOEs that existed before this migration, oldest first,
-- in batches. Pass the returned last_event_id back in to continue; stop when
-- examined is 0. A VOE that already has rows is skipped, so reruns and overlap
-- with the live trigger are harmless. A VOE's result depends only on rows that
-- precede it, so the order of application does not affect the result.
CREATE FUNCTION backfill_twamm_hourly_volume(p_chain_id int8, p_after_event_id int8, p_limit int4)
    RETURNS TABLE (examined int4, last_event_id int8) AS
$$
DECLARE
    rec RECORD;
BEGIN
    examined := 0;
    last_event_id := p_after_event_id;

    FOR rec IN
        SELECT voe.event_id
        FROM twamm_virtual_order_executions voe
        WHERE voe.chain_id = p_chain_id
          AND voe.event_id > p_after_event_id
          AND NOT EXISTS (SELECT 1
                          FROM twamm_hourly_volume_by_token t
                          WHERE t.chain_id = voe.chain_id
                            AND t.event_id = voe.event_id)
        ORDER BY voe.event_id
        LIMIT p_limit
        LOOP
            PERFORM insert_twamm_hourly_volume(p_chain_id, rec.event_id);
            examined := examined + 1;
            last_event_id := rec.event_id;
        END LOOP;

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
