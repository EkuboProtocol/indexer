CREATE TABLE auction_completed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    token_id          NUMERIC NOT NULL,
    token0            NUMERIC NOT NULL,
    token1            NUMERIC NOT NULL,
    config            NUMERIC NOT NULL,
    creator_amount    NUMERIC NOT NULL,
    boost_amount      NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_auction_completed
    BEFORE UPDATE
    ON auction_completed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE auction_funds_added
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    token_id          NUMERIC NOT NULL,
    token0            NUMERIC NOT NULL,
    token1            NUMERIC NOT NULL,
    config            NUMERIC NOT NULL,
    sale_rate         NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_auction_funds_added
    BEFORE UPDATE
    ON auction_funds_added
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE auction_boost_started
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    token0            NUMERIC     NOT NULL,
    token1            NUMERIC     NOT NULL,
    config            NUMERIC     NOT NULL,
    boost_rate        NUMERIC     NOT NULL,
    boost_end_time    timestamptz NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_auction_boost_started
    BEFORE UPDATE
    ON auction_boost_started
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE auction_creator_proceeds_collected
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    token_id          NUMERIC NOT NULL,
    token0            NUMERIC NOT NULL,
    token1            NUMERIC NOT NULL,
    config            NUMERIC NOT NULL,
    recipient         NUMERIC NOT NULL,
    amount            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_auction_creator_proceeds_collected
    BEFORE UPDATE
    ON auction_creator_proceeds_collected
    FOR EACH ROW
EXECUTE FUNCTION block_updates();
