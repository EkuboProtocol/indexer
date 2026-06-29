CREATE TABLE ve33_stake_changed
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    owner             NUMERIC     NOT NULL,
    stake_id          NUMERIC     NOT NULL,
    stake_salt        NUMERIC     NOT NULL,
    stake_end_time    timestamptz NOT NULL,
    delta             NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_stake_changed (chain_id, emitter, owner, stake_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_stake_changed
    BEFORE UPDATE
    ON ve33_stake_changed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_vote_weight_applied
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC     NOT NULL,
    owner             NUMERIC     NOT NULL,
    stake_id          NUMERIC     NOT NULL,
    stake_salt        NUMERIC     NOT NULL,
    stake_end_time    timestamptz NOT NULL,
    weight            NUMERIC     NOT NULL,
    swap_fee          NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_vote_weight_applied (chain_id, emitter, owner, stake_id, event_id DESC);
CREATE INDEX ON ve33_vote_weight_applied (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_vote_weight_applied
    BEFORE UPDATE
    ON ve33_vote_weight_applied
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_pool_fees_accounted
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_pool_fees_accounted (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_pool_fees_accounted
    BEFORE UPDATE
    ON ve33_pool_fees_accounted
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_pool_fees_claimed
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC     NOT NULL,
    owner             NUMERIC     NOT NULL,
    stake_id          NUMERIC     NOT NULL,
    stake_salt        NUMERIC     NOT NULL,
    stake_end_time    timestamptz NOT NULL,
    amount0           NUMERIC     NOT NULL,
    amount1           NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_pool_fees_claimed (chain_id, emitter, owner, stake_id, event_id DESC);
CREATE INDEX ON ve33_pool_fees_claimed (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_pool_fees_claimed
    BEFORE UPDATE
    ON ve33_pool_fees_claimed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_emissions_scheduled
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    funder            NUMERIC     NOT NULL,
    start_time        timestamptz NOT NULL,
    end_time          timestamptz NOT NULL,
    reward_rate       NUMERIC     NOT NULL,
    amount            NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_emissions_scheduled (chain_id, emitter, start_time, end_time);

CREATE TRIGGER no_updates_ve33_emissions_scheduled
    BEFORE UPDATE
    ON ve33_emissions_scheduled
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_pool_emissions_accrued
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    amount            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_pool_emissions_accrued (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_pool_emissions_accrued
    BEFORE UPDATE
    ON ve33_pool_emissions_accrued
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve33_rewards_claimed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    position_id       NUMERIC NOT NULL,
    salt              NUMERIC NOT NULL,
    lower_bound       int4    NOT NULL,
    upper_bound       int4    NOT NULL,
    amount            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve33_rewards_claimed (chain_id, emitter, owner, salt, lower_bound, upper_bound, event_id DESC);
CREATE INDEX ON ve33_rewards_claimed (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve33_rewards_claimed
    BEFORE UPDATE
    ON ve33_rewards_claimed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();
