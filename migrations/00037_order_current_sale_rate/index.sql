CREATE TABLE order_current_sale_rate
(
    pool_key_id int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    locker      NUMERIC     NOT NULL,
    salt        NUMERIC     NOT NULL,
    start_time  timestamptz NOT NULL,
    end_time    timestamptz NOT NULL,
    sale_rate0  NUMERIC     NOT NULL,
    sale_rate1  NUMERIC     NOT NULL,
    PRIMARY KEY (pool_key_id, locker, salt, start_time, end_time)
);

CREATE FUNCTION order_current_sale_rate_on_insert()
    RETURNS TRIGGER AS
$$
BEGIN
    INSERT INTO order_current_sale_rate (pool_key_id,
                                         locker,
                                         salt,
                                         start_time,
                                         end_time,
                                         sale_rate0,
                                         sale_rate1)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.start_time,
            new.end_time,
            new.sale_rate_delta0,
            new.sale_rate_delta1)
    ON CONFLICT (pool_key_id, locker, salt, start_time, end_time)
        DO UPDATE SET sale_rate0 = order_current_sale_rate.sale_rate0 + excluded.sale_rate0,
                      sale_rate1 = order_current_sale_rate.sale_rate1 + excluded.sale_rate1;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION order_current_sale_rate_on_delete()
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
      AND end_time = old.end_time;

    IF NOT found THEN
        RAISE EXCEPTION 'failed to update order_current_sale_rate on delete';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

INSERT INTO order_current_sale_rate (pool_key_id,
                                     locker,
                                     salt,
                                     start_time,
                                     end_time,
                                     sale_rate0,
                                     sale_rate1)
SELECT pool_key_id,
       locker,
       salt,
       start_time,
       end_time,
       SUM(sale_rate_delta0) AS sale_rate0,
       SUM(sale_rate_delta1) AS sale_rate1
FROM twamm_order_updates
GROUP BY pool_key_id,
         locker,
         salt,
         start_time,
         end_time;

CREATE TRIGGER order_current_sale_rate_after_insert
    AFTER INSERT
    ON twamm_order_updates
    FOR EACH ROW
EXECUTE FUNCTION order_current_sale_rate_on_insert();

CREATE TRIGGER order_current_sale_rate_after_delete
    AFTER DELETE
    ON twamm_order_updates
    FOR EACH ROW
EXECUTE FUNCTION order_current_sale_rate_on_delete();

CREATE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;
