ALTER TABLE twamm_order_updates
    ADD COLUMN block_time timestamptz;

ALTER TABLE twamm_order_updates
    DISABLE TRIGGER no_updates_twamm_order_updates;

UPDATE twamm_order_updates t
SET block_time = b.block_time
FROM blocks b
WHERE t.block_time IS NULL
  AND t.chain_id = b.chain_id
  AND t.block_number = b.block_number;

ALTER TABLE twamm_order_updates
    ALTER COLUMN block_time SET NOT NULL;

ALTER TABLE twamm_order_updates
    ENABLE TRIGGER no_updates_twamm_order_updates;

DROP TRIGGER IF EXISTS set_block_time_twamm_order_updates ON twamm_order_updates;

CREATE OR REPLACE FUNCTION set_block_time_from_blocks()
    RETURNS TRIGGER AS
$$
BEGIN
    IF new.block_time IS NOT NULL THEN
        RETURN new;
    END IF;

    SELECT b.block_time
    INTO STRICT new.block_time
    FROM blocks b
    WHERE b.chain_id = new.chain_id
      AND b.block_number = new.block_number;

    RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_block_time_twamm_order_updates
    BEFORE INSERT
    ON twamm_order_updates
    FOR EACH ROW
EXECUTE FUNCTION set_block_time_from_blocks();

ALTER TABLE order_current_sale_rate
    ADD COLUMN amount0_sold_last           NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN amount1_sold_last           NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN amount_sold_last_block_time timestamptz;

UPDATE order_current_sale_rate
SET amount_sold_last_block_time = start_time
WHERE amount_sold_last_block_time IS NULL;

ALTER TABLE order_current_sale_rate
    ALTER COLUMN amount_sold_last_block_time SET NOT NULL;

CREATE OR REPLACE FUNCTION order_current_sale_rate_accumulate_amounts(
    p_pool_key_id int8,
    p_locker NUMERIC,
    p_salt NUMERIC,
    p_start_time timestamptz,
    p_end_time timestamptz,
    p_is_selling_token1 BOOLEAN,
    p_block_time timestamptz
)
    RETURNS VOID AS
$$
DECLARE
    v_scale CONSTANT NUMERIC := 4294967296::NUMERIC;
BEGIN
    WITH target AS (SELECT pool_key_id,
                           locker,
                           salt,
                           start_time,
                           end_time,
                           is_selling_token1,
                           amount_sold_last_block_time,
                           GREATEST(
                                   0::NUMERIC,
                                   (EXTRACT(
                                           EPOCH FROM LEAST(p_block_time, end_time)
                                               - GREATEST(COALESCE(amount_sold_last_block_time, start_time), start_time)
                                    ))::NUMERIC
                           )                                                   AS seconds_elapsed,
                           LEAST(GREATEST(p_block_time, start_time), end_time) AS clamped_block_time
                    FROM order_current_sale_rate
                    WHERE pool_key_id = p_pool_key_id
                      AND locker = p_locker
                      AND salt = p_salt
                      AND start_time = p_start_time
                      AND end_time = p_end_time
                      AND is_selling_token1 = p_is_selling_token1
                        FOR UPDATE)
    UPDATE order_current_sale_rate o
    SET amount0_sold_last           = amount0_sold_last + FLOOR((target.seconds_elapsed * o.sale_rate0) / v_scale),
        amount1_sold_last           = amount1_sold_last + FLOOR((target.seconds_elapsed * o.sale_rate1) / v_scale),
        amount_sold_last_block_time = GREATEST(
                COALESCE(o.amount_sold_last_block_time, o.start_time),
                target.clamped_block_time
                                      )
    FROM target
    WHERE o.pool_key_id = target.pool_key_id
      AND o.locker = target.locker
      AND o.salt = target.salt
      AND o.start_time = target.start_time
      AND o.end_time = target.end_time
      AND o.is_selling_token1 = target.is_selling_token1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_current_sale_rate_recompute_amounts(
    p_pool_key_id int8,
    p_locker NUMERIC,
    p_salt NUMERIC,
    p_start_time timestamptz,
    p_end_time timestamptz,
    p_is_selling_token1 BOOLEAN
)
    RETURNS VOID AS
$$
DECLARE
    v_scale CONSTANT NUMERIC := 4294967296::NUMERIC;
    v_amount0        NUMERIC := 0;
    v_amount1        NUMERIC := 0;
    v_last_time      timestamptz;
    v_start_time     timestamptz;
    v_end_time       timestamptz;
    v_rate0          NUMERIC := 0;
    v_rate1          NUMERIC := 0;
    v_seconds        NUMERIC;
    rec              RECORD;
BEGIN
    SELECT start_time, end_time
    INTO v_start_time, v_end_time
    FROM order_current_sale_rate
    WHERE pool_key_id = p_pool_key_id
      AND locker = p_locker
      AND salt = p_salt
      AND start_time = p_start_time
      AND end_time = p_end_time
      AND is_selling_token1 = p_is_selling_token1
        FOR UPDATE;

    IF NOT found THEN
        RETURN;
    END IF;

    v_last_time := v_start_time;

    FOR rec IN
        SELECT block_time,
               sale_rate_delta0,
               sale_rate_delta1,
               event_id
        FROM twamm_order_updates
        WHERE pool_key_id = p_pool_key_id
          AND locker = p_locker
          AND salt = p_salt
          AND start_time = p_start_time
          AND end_time = p_end_time
          AND is_selling_token1 = p_is_selling_token1
        ORDER BY block_time, event_id
        LOOP
            v_seconds := GREATEST(
                    0::NUMERIC,
                    (EXTRACT(
                            EPOCH FROM LEAST(rec.block_time, v_end_time)
                                - GREATEST(v_last_time, v_start_time)
                     ))::NUMERIC
                         );

            IF v_seconds > 0 THEN
                v_amount0 := v_amount0 + FLOOR((v_seconds * v_rate0) / v_scale);
                v_amount1 := v_amount1 + FLOOR((v_seconds * v_rate1) / v_scale);
            END IF;

            v_last_time := LEAST(GREATEST(rec.block_time, v_start_time), v_end_time);
            v_rate0 := v_rate0 + rec.sale_rate_delta0;
            v_rate1 := v_rate1 + rec.sale_rate_delta1;
        END LOOP;

    UPDATE order_current_sale_rate
    SET amount0_sold_last           = v_amount0,
        amount1_sold_last           = v_amount1,
        amount_sold_last_block_time = v_last_time
    WHERE pool_key_id = p_pool_key_id
      AND locker = p_locker
      AND salt = p_salt
      AND start_time = p_start_time
      AND end_time = p_end_time
      AND is_selling_token1 = p_is_selling_token1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_current_sale_rate_on_insert()
    RETURNS TRIGGER AS
$$
DECLARE
    v_clamped_time timestamptz;
BEGIN
    PERFORM order_current_sale_rate_accumulate_amounts(new.pool_key_id,
                                                       new.locker,
                                                       new.salt,
                                                       new.start_time,
                                                       new.end_time,
                                                       new.is_selling_token1,
                                                       new.block_time);

    v_clamped_time := LEAST(GREATEST(new.block_time, new.start_time), new.end_time);

    INSERT INTO order_current_sale_rate (pool_key_id,
                                         locker,
                                         salt,
                                         start_time,
                                         end_time,
                                         sale_rate0,
                                         sale_rate1,
                                         total_proceeds_withdrawn0,
                                         total_proceeds_withdrawn1,
                                         is_selling_token1,
                                         amount0_sold_last,
                                         amount1_sold_last,
                                         amount_sold_last_block_time)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.start_time,
            new.end_time,
            new.sale_rate_delta0,
            new.sale_rate_delta1,
            0,
            0,
            new.is_selling_token1,
            0,
            0,
            v_clamped_time)
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time, is_selling_token1)
        DO UPDATE SET sale_rate0 = order_current_sale_rate.sale_rate0 + excluded.sale_rate0,
                      sale_rate1 = order_current_sale_rate.sale_rate1 + excluded.sale_rate1;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_current_sale_rate_on_delete()
    RETURNS TRIGGER AS
$$
BEGIN
    UPDATE order_current_sale_rate
    SET sale_rate0 = sale_rate0 - old.sale_rate_delta0,
        sale_rate1 = sale_rate1 - old.sale_rate_delta1
    WHERE pool_key_id = old.pool_key_id
      AND locker = old.locker
      AND salt = old.salt
      AND start_time = old.start_time
      AND end_time = old.end_time
      AND is_selling_token1 = old.is_selling_token1;

    IF NOT found THEN
        RAISE EXCEPTION 'failed to update order_current_sale_rate on delete';
    END IF;

    PERFORM order_current_sale_rate_recompute_amounts(old.pool_key_id,
                                                      old.locker,
                                                      old.salt,
                                                      old.start_time,
                                                      old.end_time,
                                                      old.is_selling_token1);

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_current_sale_rate_on_proceeds_insert()
    RETURNS TRIGGER AS
$$
BEGIN
    INSERT INTO order_current_sale_rate (pool_key_id,
                                         locker,
                                         salt,
                                         start_time,
                                         end_time,
                                         sale_rate0,
                                         sale_rate1,
                                         total_proceeds_withdrawn0,
                                         total_proceeds_withdrawn1,
                                         is_selling_token1,
                                         amount0_sold_last,
                                         amount1_sold_last,
                                         amount_sold_last_block_time)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.start_time,
            new.end_time,
            0,
            0,
            new.amount0,
            new.amount1,
            new.is_selling_token1,
            0,
            0,
            new.start_time)
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time, is_selling_token1)
        DO UPDATE SET sale_rate0                = order_current_sale_rate.sale_rate0,
                      sale_rate1                = order_current_sale_rate.sale_rate1,
                      total_proceeds_withdrawn0 =
                          order_current_sale_rate.total_proceeds_withdrawn0 + excluded.total_proceeds_withdrawn0,
                      total_proceeds_withdrawn1 =
                          order_current_sale_rate.total_proceeds_withdrawn1 + excluded.total_proceeds_withdrawn1;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO
$$
    DECLARE
        rec RECORD;
    BEGIN
        FOR rec IN
            SELECT pool_key_id,
                   locker,
                   salt,
                   start_time,
                   end_time,
                   is_selling_token1
            FROM order_current_sale_rate
            LOOP
                PERFORM order_current_sale_rate_recompute_amounts(rec.pool_key_id,
                                                                  rec.locker,
                                                                  rec.salt,
                                                                  rec.start_time,
                                                                  rec.end_time,
                                                                  rec.is_selling_token1);
            END LOOP;
    END;
$$;

DROP VIEW IF EXISTS nonfungible_token_orders_view;

CREATE OR REPLACE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.locker,
       oc.salt,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1,
       oc.total_proceeds_withdrawn0,
       oc.total_proceeds_withdrawn1,
       oc.is_selling_token1,
       oc.amount0_sold_last,
       oc.amount1_sold_last,
       oc.amount_sold_last_block_time,
       CASE
           WHEN oc.is_selling_token1 THEN pk.token1
           ELSE pk.token0
           END AS sell_token,
       CASE
           WHEN oc.is_selling_token1 THEN pk.token0
           ELSE pk.token1
           END AS buy_token,
       CASE
           WHEN oc.is_selling_token1 THEN oc.sale_rate1
           ELSE oc.sale_rate0
           END AS sale_rate,
       CASE
           WHEN oc.is_selling_token1 THEN oc.total_proceeds_withdrawn0
           ELSE oc.total_proceeds_withdrawn1
           END AS total_proceeds_withdrawn,
       CASE
           WHEN oc.is_selling_token1 THEN
               FLOOR((EXTRACT(EPOCH FROM LEAST(latest_block.block_time, end_time) -
                                         GREATEST(amount_sold_last_block_time, start_time)) *
                      sale_rate1) / pow(2::NUMERIC, 32)) +
               oc.amount1_sold_last
           ELSE FLOOR((EXTRACT(EPOCH FROM LEAST(latest_block.block_time, end_time) -
                                          GREATEST(amount_sold_last_block_time, start_time)) *
                       sale_rate0) / pow(2::NUMERIC, 32)) + oc.amount0_sold_last
           END AS amount_sold
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN LATERAL (SELECT block_time
                       FROM blocks b
                       WHERE b.chain_id = n.chain_id
                       ORDER BY block_number DESC
                       LIMIT 1) AS latest_block ON TRUE
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;
