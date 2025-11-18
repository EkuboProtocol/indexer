CREATE TABLE twamm_virtual_order_executions
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8    NOT NULL REFERENCES pool_keys (pool_key_id),
    token0_sale_rate  NUMERIC NOT NULL,
    token1_sale_rate  NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX on twamm_virtual_order_executions (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_twamm_virtual_order_executions
    BEFORE UPDATE
    ON twamm_virtual_order_executions
    FOR EACH ROW
    EXECUTE function block_updates();

CREATE TABLE twamm_order_updates
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    locker            NUMERIC     NOT NULL,
    salt              NUMERIC     NOT NULL,
    sale_rate_delta0  NUMERIC     NOT NULL,
    sale_rate_delta1  NUMERIC     NOT NULL,
    start_time        timestamptz NOT NULL,
    end_time          timestamptz NOT NULL,
    is_selling_token1 boolean     NOT NULL,
    CONSTRAINT twamm_order_updates_sale_rate_side_check
        CHECK ((is_selling_token1 AND sale_rate_delta0 = 0) OR
               (NOT is_selling_token1 AND sale_rate_delta1 = 0)),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX on twamm_order_updates (chain_id, locker, salt);

CREATE TRIGGER no_updates_twamm_order_updates
    BEFORE UPDATE
    ON twamm_order_updates
    FOR EACH ROW
    EXECUTE function block_updates();

CREATE TABLE twamm_proceeds_withdrawals
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    locker            NUMERIC     NOT NULL,
    salt              NUMERIC     NOT NULL,
    start_time        timestamptz NOT NULL,
    end_time          timestamptz NOT NULL,
    amount0           NUMERIC     NOT NULL,
    amount1           NUMERIC     NOT NULL,
    is_selling_token1 boolean     NOT NULL,
    CONSTRAINT twamm_proceeds_withdrawals_amount_side_check
        CHECK ((is_selling_token1 AND amount1 = 0) OR
               (NOT is_selling_token1 AND amount0 = 0)),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX on twamm_proceeds_withdrawals (chain_id, locker, salt);

CREATE TRIGGER no_updates_twamm_proceeds_withdrawals
    BEFORE UPDATE
    ON twamm_proceeds_withdrawals
    FOR EACH ROW
    EXECUTE function block_updates();
