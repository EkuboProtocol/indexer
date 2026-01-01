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

CREATE OR REPLACE FUNCTION upsert_hourly_revenue_from_protocol_fee()
    RETURNS TRIGGER AS
$$
DECLARE
    rec           RECORD;
    sign          INT     := 1;
    v_hour        timestamptz;
    v_token0      NUMERIC;
    v_token1      NUMERIC;
    v_revenue0    NUMERIC := 0;
    v_revenue1    NUMERIC := 0;
    v_is_withheld BOOLEAN := FALSE;
BEGIN
    IF tg_op = 'DELETE' THEN
        rec := old;
        sign := -1;
    ELSE
        rec := new;
    END IF;

    v_is_withheld := tg_table_name = 'position_fees_withheld';

    SELECT pk.token0,
           pk.token1
    INTO STRICT v_token0,
        v_token1
    FROM pool_keys pk
    WHERE pk.pool_key_id = rec.pool_key_id;

    v_hour := DATE_TRUNC('hour', rec.block_time);

    IF v_is_withheld THEN
        v_revenue0 := rec.delta0;
        v_revenue1 := rec.delta1;
    ELSE
        v_revenue0 := -rec.delta0;
        v_revenue1 := -rec.delta1;
    END IF;

    IF v_revenue0 = 0 AND v_revenue1 = 0 THEN
        RETURN NULL;
    END IF;

    IF v_revenue0 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (rec.pool_key_id, v_hour, v_token0, sign * v_revenue0)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;

        IF sign = -1 THEN
            DELETE
            FROM hourly_revenue_by_token
            WHERE pool_key_id = rec.pool_key_id
              AND hour = v_hour
              AND token = v_token0
              AND revenue = 0;
        END IF;
    END IF;

    IF v_revenue1 <> 0 THEN
        INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
        VALUES (rec.pool_key_id, v_hour, v_token1, sign * v_revenue1)
        ON CONFLICT (pool_key_id, hour, token) DO UPDATE
            SET revenue = hourly_revenue_by_token.revenue + excluded.revenue;

        IF sign = -1 THEN
            DELETE
            FROM hourly_revenue_by_token
            WHERE pool_key_id = rec.pool_key_id
              AND hour = v_hour
              AND token = v_token1
              AND revenue = 0;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hourly_position_fees_withheld_revenue
    AFTER INSERT OR DELETE
    ON position_fees_withheld
    FOR EACH ROW
EXECUTE FUNCTION upsert_hourly_revenue_from_protocol_fee();
