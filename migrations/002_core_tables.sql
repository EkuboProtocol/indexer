CREATE TABLE pool_keys (
    id serial8 NOT NULL PRIMARY KEY,
    chain_id int8 NOT NULL,
    core_address NUMERIC NOT NULL,
    pool_id NUMERIC NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    fee NUMERIC NOT NULL,
    tick_spacing INT NOT NULL,
    extension NUMERIC NOT NULL
);
CREATE UNIQUE INDEX idx_pool_keys_chain_id_core_address_pool_id ON pool_keys USING btree (chain_id, core_address, pool_id);
CREATE INDEX idx_pool_keys_chain_id_token0 ON pool_keys USING btree (chain_id, token0);
CREATE INDEX idx_pool_keys_chain_id_token1 ON pool_keys USING btree (chain_id, token1);
CREATE INDEX idx_pool_keys_chain_id_token0_token1 ON pool_keys USING btree (chain_id, token0, token1);
CREATE INDEX idx_pool_keys_chain_id_extension ON pool_keys USING btree (chain_id, extension);
CREATE TABLE extension_registrations (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    extension NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE TABLE pool_balance_change (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    delta0 NUMERIC NOT NULL,
    delta1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_pool_balance_change_pool_key_id_event_id ON pool_balance_change USING btree (pool_key_id, event_id);
CREATE INDEX idx_pool_balance_change_pool_key_id_event_id_desc ON pool_balance_change USING btree (pool_key_id, event_id DESC);
CREATE TABLE position_updates (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    locker NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    liquidity_delta NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_position_updates_locker_salt ON position_updates USING btree (locker, salt);
CREATE INDEX idx_position_updates_salt ON position_updates USING btree (salt);
CREATE TABLE position_fees_collected (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    locker NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_position_fees_collected_locker_salt ON position_fees_collected USING btree (locker, salt);
CREATE TABLE protocol_fees_withdrawn (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    recipient NUMERIC NOT NULL,
    token NUMERIC NOT NULL,
    amount NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE TABLE fees_accumulated (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);
CREATE TABLE pool_initializations (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    tick int4 NOT NULL,
    sqrt_ratio NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE TABLE swaps (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    locker NUMERIC NOT NULL,
    sqrt_ratio_after NUMERIC NOT NULL,
    tick_after int4 NOT NULL,
    liquidity_after NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);