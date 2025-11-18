ALTER TABLE order_current_sale_rate
    ADD COLUMN total_proceeds_withdrawn0 NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN total_proceeds_withdrawn1 NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN is_token1 BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION order_current_sale_rate_on_insert()
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
                                         is_token1)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.start_time,
            new.end_time,
            new.sale_rate_delta0,
            new.sale_rate_delta1,
            0,
            0,
            new.is_selling_token1)
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time)
        DO UPDATE SET sale_rate0 = order_current_sale_rate.sale_rate0 + excluded.sale_rate0,
                      sale_rate1 = order_current_sale_rate.sale_rate1 + excluded.sale_rate1,
                      is_token1 = CASE
                                      WHEN excluded.sale_rate0 <> 0 OR excluded.sale_rate1 <> 0
                                          THEN excluded.is_token1
                                      ELSE order_current_sale_rate.is_token1
                                  END;

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
                                         is_token1)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.start_time,
            new.end_time,
            0,
            0,
            new.amount0,
            new.amount1,
            new.is_selling_token1)
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time)
        DO UPDATE SET sale_rate0 = order_current_sale_rate.sale_rate0,
                      sale_rate1 = order_current_sale_rate.sale_rate1,
                      total_proceeds_withdrawn0 =
                          order_current_sale_rate.total_proceeds_withdrawn0 + excluded.total_proceeds_withdrawn0,
                      total_proceeds_withdrawn1 =
                          order_current_sale_rate.total_proceeds_withdrawn1 + excluded.total_proceeds_withdrawn1,
                      is_token1 = CASE
                                      WHEN excluded.total_proceeds_withdrawn0 <> 0
                                          OR excluded.total_proceeds_withdrawn1 <> 0
                                          THEN excluded.is_token1
                                      ELSE order_current_sale_rate.is_token1
                                  END;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_current_sale_rate_on_proceeds_delete()
    RETURNS TRIGGER AS
$$
BEGIN
    UPDATE order_current_sale_rate
    SET total_proceeds_withdrawn0 = total_proceeds_withdrawn0 - old.amount0,
        total_proceeds_withdrawn1 = total_proceeds_withdrawn1 - old.amount1
    WHERE pool_key_id = old.pool_key_id
      AND locker = old.locker
      AND salt = old.salt
      AND start_time = old.start_time
      AND end_time = old.end_time;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_current_sale_rate_proceeds_after_insert
    AFTER INSERT
    ON twamm_proceeds_withdrawals
    FOR EACH ROW
EXECUTE FUNCTION order_current_sale_rate_on_proceeds_insert();

CREATE TRIGGER order_current_sale_rate_proceeds_after_delete
    AFTER DELETE
    ON twamm_proceeds_withdrawals
    FOR EACH ROW
EXECUTE FUNCTION order_current_sale_rate_on_proceeds_delete();

WITH proceeds AS (
    SELECT pool_key_id,
           locker,
           salt,
           start_time,
           end_time,
           SUM(amount0) AS total0,
           SUM(amount1) AS total1
    FROM twamm_proceeds_withdrawals
    GROUP BY pool_key_id,
             locker,
             salt,
             start_time,
             end_time
)
UPDATE order_current_sale_rate o
SET total_proceeds_withdrawn0 = COALESCE(p.total0, 0),
    total_proceeds_withdrawn1 = COALESCE(p.total1, 0)
FROM proceeds p
WHERE o.pool_key_id = p.pool_key_id
  AND o.locker = p.locker
  AND o.salt = p.salt
  AND o.start_time = p.start_time
  AND o.end_time = p.end_time;

WITH order_sides AS (
    SELECT pool_key_id,
           locker,
           salt,
           start_time,
           end_time,
           BOOL_OR(is_selling_token1) FILTER (WHERE sale_rate_delta0 <> 0 OR sale_rate_delta1 <> 0) AS is_token1_value
    FROM twamm_order_updates
    GROUP BY pool_key_id,
             locker,
             salt,
             start_time,
             end_time
)
UPDATE order_current_sale_rate o
SET is_token1 = COALESCE(order_sides.is_token1_value, o.is_token1)
FROM order_sides
WHERE o.pool_key_id = order_sides.pool_key_id
  AND o.locker = order_sides.locker
  AND o.salt = order_sides.salt
  AND o.start_time = order_sides.start_time
  AND o.end_time = order_sides.end_time;

WITH proceeds_sides AS (
    SELECT pool_key_id,
           locker,
           salt,
           start_time,
           end_time,
           BOOL_OR(is_selling_token1) FILTER (WHERE amount0 <> 0 OR amount1 <> 0) AS is_token1_value
    FROM twamm_proceeds_withdrawals
    GROUP BY pool_key_id,
             locker,
             salt,
             start_time,
             end_time
)
UPDATE order_current_sale_rate o
SET is_token1 = COALESCE(proceeds_sides.is_token1_value, o.is_token1)
FROM proceeds_sides
WHERE o.pool_key_id = proceeds_sides.pool_key_id
  AND o.locker = proceeds_sides.locker
  AND o.salt = proceeds_sides.salt
  AND o.start_time = proceeds_sides.start_time
  AND o.end_time = proceeds_sides.end_time;

CREATE OR REPLACE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1,
       oc.total_proceeds_withdrawn0,
       oc.total_proceeds_withdrawn1,
       oc.is_token1
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;
