CREATE TABLE protocol_fees_paid (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    owner NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    delta0 NUMERIC NOT NULL,
    delta1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_protocol_fees_paid_pool_key_id ON protocol_fees_paid USING btree (pool_key_id);
CREATE INDEX idx_protocol_fees_paid_salt ON protocol_fees_paid USING btree (salt);
CREATE TABLE position_minted_with_referrer (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    token_id NUMERIC NOT NULL,
    referrer NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_position_minted_with_referrer_token_id ON position_minted_with_referrer USING btree (token_id);
CREATE TABLE token_registrations (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    address NUMERIC NOT NULL,
    name NUMERIC NOT NULL,
    symbol NUMERIC NOT NULL,
    decimals INT NOT NULL,
    total_supply NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE TABLE token_registrations_v3 (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    address NUMERIC NOT NULL,
    name VARCHAR NOT NULL,
    symbol VARCHAR NOT NULL,
    decimals INT NOT NULL,
    total_supply NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE TABLE staker_staked (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    from_address NUMERIC NOT NULL,
    amount NUMERIC NOT NULL,
    delegate NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_staker_staked_delegate_from_address ON staker_staked USING btree (delegate, from_address);
CREATE INDEX idx_staker_staked_from_address_delegate ON staker_staked USING btree (from_address, delegate);
CREATE TABLE staker_withdrawn (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    from_address NUMERIC NOT NULL,
    amount NUMERIC NOT NULL,
    recipient NUMERIC NOT NULL,
    delegate NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_staker_withdrawn_delegate_from_address ON staker_withdrawn USING btree (delegate, from_address);
CREATE INDEX idx_staker_withdrawn_from_address_delegate ON staker_withdrawn USING btree (from_address, delegate);
CREATE TABLE governor_reconfigured (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    version BIGINT NOT NULL,
    voting_start_delay BIGINT NOT NULL,
    voting_period BIGINT NOT NULL,
    voting_weight_smoothing_duration BIGINT NOT NULL,
    quorum NUMERIC NOT NULL,
    proposal_creation_threshold NUMERIC NOT NULL,
    execution_delay BIGINT NOT NULL,
    execution_window BIGINT NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    UNIQUE (chain_id, version)
);
CREATE UNIQUE INDEX idx_governor_reconfigured_chain_id_version ON governor_reconfigured USING btree (chain_id, version);
CREATE TABLE governor_proposed (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    id NUMERIC NOT NULL,
    proposer NUMERIC NOT NULL,
    config_version BIGINT NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, config_version) REFERENCES governor_reconfigured (chain_id, version) ON DELETE CASCADE,
    UNIQUE (chain_id, id)
);
CREATE UNIQUE INDEX idx_governor_proposed_chain_id_id ON governor_proposed USING btree (chain_id, id);
CREATE TABLE governor_proposed_calls (
    chain_id int8 NOT NULL,
    proposal_id NUMERIC NOT NULL,
    index int2 NOT NULL,
    to_address NUMERIC NOT NULL,
    selector NUMERIC NOT NULL,
    calldata NUMERIC [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, index),
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, id) ON DELETE CASCADE
);
CREATE TABLE governor_canceled (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    id NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, id) REFERENCES governor_proposed (chain_id, id) ON DELETE CASCADE,
    UNIQUE (chain_id, id)
);
CREATE UNIQUE INDEX idx_governor_canceled_chain_id_id ON governor_canceled USING btree (chain_id, id);
CREATE TABLE governor_voted (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    id NUMERIC NOT NULL,
    voter NUMERIC NOT NULL,
    weight NUMERIC NOT NULL,
    yea BOOLEAN NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, id) REFERENCES governor_proposed (chain_id, id) ON DELETE CASCADE
);
CREATE TABLE governor_executed (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    id NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, id) REFERENCES governor_proposed (chain_id, id) ON DELETE CASCADE,
    UNIQUE (chain_id, id)
);
CREATE UNIQUE INDEX idx_governor_executed_chain_id_id ON governor_executed USING btree (chain_id, id);
CREATE TABLE governor_executed_results (
    chain_id int8 NOT NULL,
    proposal_id NUMERIC NOT NULL,
    index int2 NOT NULL,
    results NUMERIC [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, index),
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_executed (chain_id, id) ON DELETE CASCADE
);
CREATE TABLE governor_proposal_described (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    id NUMERIC NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, id) REFERENCES governor_proposed (chain_id, id) ON DELETE CASCADE
);
CREATE TABLE limit_order_placed (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    owner NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    tick int4 NOT NULL,
    liquidity NUMERIC NOT NULL,
    amount NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_limit_order_placed_owner_salt ON limit_order_placed USING btree (owner, salt);
CREATE INDEX idx_limit_order_placed_salt_event_id_desc ON limit_order_placed (salt, event_id DESC) INCLUDE (token0, token1, tick, liquidity, amount);
CREATE TABLE limit_order_closed (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    owner NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    tick int4 NOT NULL,
    amount0 NUMERIC NOT NULL,
    amount1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_limit_order_closed_owner_salt ON limit_order_closed USING btree (owner, salt);
CREATE INDEX idx_limit_order_closed_salt_event_id_desc ON limit_order_closed (salt, event_id DESC) INCLUDE (amount0, amount1);
CREATE TABLE spline_liquidity_updated (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    sender NUMERIC NOT NULL,
    liquidity_factor NUMERIC NOT NULL,
    shares NUMERIC NOT NULL,
    amount0 NUMERIC NOT NULL,
    amount1 NUMERIC NOT NULL,
    protocol_fees0 NUMERIC NOT NULL,
    protocol_fees1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_spline_liquidity_updated_updated_pool_key_id ON spline_liquidity_updated USING btree (pool_key_id);