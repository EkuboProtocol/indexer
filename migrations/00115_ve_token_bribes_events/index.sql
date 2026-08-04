CREATE TABLE ve_token_bribes_created
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    reward_token      NUMERIC NOT NULL,
    voting_fee        NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_created (chain_id, emitter, bribe_id);
CREATE INDEX ON ve_token_bribes_created (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_created
    BEFORE UPDATE
    ON ve_token_bribes_created
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_staked
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    ve_id             NUMERIC NOT NULL,
    weight            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_staked (chain_id, emitter, bribe_id, event_id DESC);
CREATE INDEX ON ve_token_bribes_staked (chain_id, emitter, owner, ve_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_staked
    BEFORE UPDATE
    ON ve_token_bribes_staked
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_unstaked
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    ve_id             NUMERIC NOT NULL,
    weight            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_unstaked (chain_id, emitter, bribe_id, event_id DESC);
CREATE INDEX ON ve_token_bribes_unstaked (chain_id, emitter, owner, ve_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_unstaked
    BEFORE UPDATE
    ON ve_token_bribes_unstaked
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_vote_refreshed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    ve_id             NUMERIC NOT NULL,
    previous_weight   NUMERIC NOT NULL,
    weight            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_vote_refreshed (chain_id, emitter, bribe_id, event_id DESC);
CREATE INDEX ON ve_token_bribes_vote_refreshed (chain_id, emitter, owner, ve_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_vote_refreshed
    BEFORE UPDATE
    ON ve_token_bribes_vote_refreshed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_reward_paid
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    ve_id             NUMERIC NOT NULL,
    amount            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_reward_paid (chain_id, emitter, bribe_id, event_id DESC);
CREATE INDEX ON ve_token_bribes_reward_paid (chain_id, emitter, owner, ve_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_reward_paid
    BEFORE UPDATE
    ON ve_token_bribes_reward_paid
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_rewards_scheduled
(
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC     NOT NULL,
    funder            NUMERIC     NOT NULL,
    start_time        timestamptz NOT NULL,
    end_time          timestamptz NOT NULL,
    reward_rate       NUMERIC     NOT NULL,
    amount            NUMERIC     NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_rewards_scheduled (chain_id, emitter, bribe_id, start_time, end_time);
CREATE INDEX ON ve_token_bribes_rewards_scheduled (chain_id, emitter, end_time);

CREATE TRIGGER no_updates_ve_token_bribes_rewards_scheduled
    BEFORE UPDATE
    ON ve_token_bribes_rewards_scheduled
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE ve_token_bribes_voting_fees_claimed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    bribe_id          NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    ve_id             NUMERIC NOT NULL,
    recipient         NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON ve_token_bribes_voting_fees_claimed (chain_id, emitter, bribe_id, event_id DESC);
CREATE INDEX ON ve_token_bribes_voting_fees_claimed (chain_id, emitter, owner, ve_id, event_id DESC);

CREATE TRIGGER no_updates_ve_token_bribes_voting_fees_claimed
    BEFORE UPDATE
    ON ve_token_bribes_voting_fees_claimed
    FOR EACH ROW
EXECUTE FUNCTION block_updates();
