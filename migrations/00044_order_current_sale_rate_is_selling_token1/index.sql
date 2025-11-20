DROP VIEW IF EXISTS nonfungible_token_orders_view;

ALTER TABLE order_current_sale_rate
    RENAME COLUMN is_token1 TO is_selling_token1;

ALTER TABLE order_current_sale_rate
    ALTER COLUMN total_proceeds_withdrawn0 DROP DEFAULT,
    ALTER COLUMN total_proceeds_withdrawn1 DROP DEFAULT,
    ALTER COLUMN is_selling_token1 DROP DEFAULT;

ALTER TABLE order_current_sale_rate
    DROP CONSTRAINT order_current_sale_rate_pkey;

ALTER TABLE order_current_sale_rate
    ADD PRIMARY KEY (pool_key_id, locker, salt, start_time, end_time, is_selling_token1);

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
                                         is_selling_token1)
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

    IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to update order_current_sale_rate on delete';
    END IF;

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
                                         is_selling_token1)
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
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time, is_selling_token1)
        DO UPDATE SET sale_rate0 = order_current_sale_rate.sale_rate0,
                      sale_rate1 = order_current_sale_rate.sale_rate1,
                      total_proceeds_withdrawn0 =
                          order_current_sale_rate.total_proceeds_withdrawn0 + excluded.total_proceeds_withdrawn0,
                      total_proceeds_withdrawn1 =
                          order_current_sale_rate.total_proceeds_withdrawn1 + excluded.total_proceeds_withdrawn1;

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
      AND end_time = old.end_time
      AND is_selling_token1 = old.is_selling_token1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to update order_current_sale_rate on delete';
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DELETE
FROM order_current_sale_rate;

WITH sale_rates AS (
    SELECT pool_key_id,
           locker,
           salt,
           start_time,
           end_time,
           is_selling_token1,
           SUM(sale_rate_delta0) AS sale_rate0,
           SUM(sale_rate_delta1) AS sale_rate1
    FROM twamm_order_updates
    GROUP BY pool_key_id,
             locker,
             salt,
             start_time,
             end_time,
             is_selling_token1
),
     proceeds AS (
         SELECT pool_key_id,
                locker,
                salt,
                start_time,
                end_time,
                is_selling_token1,
                SUM(amount0) AS total_proceeds_withdrawn0,
                SUM(amount1) AS total_proceeds_withdrawn1
         FROM twamm_proceeds_withdrawals
         GROUP BY pool_key_id,
                  locker,
                  salt,
                  start_time,
                  end_time,
                  is_selling_token1
     ),
     combined AS (
         SELECT COALESCE(s.pool_key_id, p.pool_key_id)               AS pool_key_id,
                COALESCE(s.locker, p.locker)                         AS locker,
                COALESCE(s.salt, p.salt)                             AS salt,
                COALESCE(s.start_time, p.start_time)                 AS start_time,
                COALESCE(s.end_time, p.end_time)                     AS end_time,
                COALESCE(s.is_selling_token1, p.is_selling_token1)   AS is_selling_token1,
                COALESCE(s.sale_rate0, 0)                            AS sale_rate0,
                COALESCE(s.sale_rate1, 0)                            AS sale_rate1,
                COALESCE(p.total_proceeds_withdrawn0, 0)             AS total_proceeds_withdrawn0,
                COALESCE(p.total_proceeds_withdrawn1, 0)             AS total_proceeds_withdrawn1
         FROM sale_rates s
                  FULL OUTER JOIN proceeds p
                                  ON s.pool_key_id = p.pool_key_id
                                      AND s.locker = p.locker
                                      AND s.salt = p.salt
                                      AND s.start_time = p.start_time
                                      AND s.end_time = p.end_time
                                      AND s.is_selling_token1 = p.is_selling_token1
     )
INSERT
INTO order_current_sale_rate (pool_key_id,
                              locker,
                              salt,
                              start_time,
                              end_time,
                              sale_rate0,
                              sale_rate1,
                              total_proceeds_withdrawn0,
                              total_proceeds_withdrawn1,
                              is_selling_token1)
SELECT pool_key_id,
       locker,
       salt,
       start_time,
       end_time,
       sale_rate0,
       sale_rate1,
       total_proceeds_withdrawn0,
       total_proceeds_withdrawn1,
       is_selling_token1
FROM combined;

CREATE OR REPLACE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1,
       oc.total_proceeds_withdrawn0,
       oc.total_proceeds_withdrawn1,
       oc.is_selling_token1
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;
