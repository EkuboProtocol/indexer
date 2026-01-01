CREATE TABLE position_fees_withheld
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    block_time        timestamptz NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    locker            NUMERIC     NOT NULL,
    salt              NUMERIC     NOT NULL,
    lower_bound       int4        NOT NULL,
    upper_bound       int4        NOT NULL,
    delta0            NUMERIC     NOT NULL,
    delta1            NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON position_fees_withheld (chain_id, locker, salt);

CREATE TRIGGER no_updates_position_fees_withheld
    BEFORE UPDATE
    ON position_fees_withheld
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TRIGGER set_block_time_position_fees_withheld
    BEFORE INSERT
    ON position_fees_withheld
    FOR EACH ROW
EXECUTE FUNCTION set_block_time_from_blocks();

CREATE FUNCTION upsert_hourly_revenue_from_withheld_protocol_fee_insert()
    RETURNS TRIGGER AS
$$
DECLARE
    v_hour     timestamptz;
    v_token0   NUMERIC;
    v_token1   NUMERIC;
BEGIN
    SELECT pk.token0,
           pk.token1
    INTO STRICT v_token0,
        v_token1
    FROM pool_keys pk
    WHERE pk.pool_key_id = new.pool_key_id;

    v_hour := DATE_TRUNC('hour', new.block_time);


    IF new.delta0 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (new.pool_key_id, v_hour, v_token0, new.delta0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;
    END IF;

    IF new.delta1 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (new.pool_key_id, v_hour, v_token1, new.delta1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION upsert_hourly_revenue_from_withheld_protocol_fee_delete()
    RETURNS TRIGGER AS
$$
DECLARE
    v_hour     timestamptz;
    v_token0   NUMERIC;
    v_token1   NUMERIC;
BEGIN
    SELECT pk.token0,
           pk.token1
    INTO STRICT v_token0,
        v_token1
    FROM pool_keys pk
    WHERE pk.pool_key_id = old.pool_key_id;

    v_hour := DATE_TRUNC('hour', old.block_time);

    IF old.delta0 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (old.pool_key_id, v_hour, v_token0, -old.delta0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;

        DELETE
        FROM hourly_revenue_by_token
        WHERE pool_key_id = old.pool_key_id
          AND hour = v_hour
          AND token = v_token0
          AND revenue = 0;
    END IF;

    IF old.delta1 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (old.pool_key_id, v_hour, v_token1, -old.delta1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;

        DELETE
        FROM hourly_revenue_by_token
        WHERE pool_key_id = old.pool_key_id
          AND hour = v_hour
          AND token = v_token1
          AND revenue = 0;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hourly_position_fees_withheld_revenue_insert
    AFTER INSERT
    ON position_fees_withheld
    FOR EACH ROW
EXECUTE FUNCTION upsert_hourly_revenue_from_withheld_protocol_fee_insert();

CREATE TRIGGER hourly_position_fees_withheld_revenue_delete
    AFTER DELETE
    ON position_fees_withheld
    FOR EACH ROW
EXECUTE FUNCTION upsert_hourly_revenue_from_withheld_protocol_fee_delete();
