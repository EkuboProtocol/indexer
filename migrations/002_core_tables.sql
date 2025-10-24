CREATE TABLE extension_registrations (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    extension NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
-- Table for all pool balance changes (must be created before tables that reference it)
CREATE TABLE pool_balance_change_event (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    delta0 NUMERIC NOT NULL,
    delta1 NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_pool_balance_change_event_pool_key_id_event_id ON pool_balance_change_event USING btree (pool_key_id, event_id);
CREATE TABLE position_updates (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    locker NUMERIC NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    salt NUMERIC NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    liquidity_delta NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change_event (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_position_updates_pool_key_id_event_id ON position_updates USING btree (pool_key_id, pool_balance_change_id);
CREATE INDEX idx_position_updates_locker_salt ON position_updates USING btree (locker, salt);
CREATE INDEX idx_position_updates_salt ON position_updates USING btree (salt);
CREATE TABLE position_fees_collected (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    owner NUMERIC NOT NULL,
    salt NUMERIC NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change_event (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_position_fees_collected_pool_key_id ON position_fees_collected (pool_key_id);
CREATE INDEX idx_position_fees_collected_salt ON position_fees_collected USING btree (salt);
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
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change_event (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_fees_accumulated_pool_key_id ON fees_accumulated (pool_key_id);
CREATE TABLE pool_initializations (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (id),
    tick int4 NOT NULL,
    sqrt_ratio NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE INDEX idx_pool_initializations_pool_key_id ON pool_initializations (pool_key_id);
CREATE TABLE swaps (
    chain_id int8 NOT NULL,
    pool_balance_change_id int8 NOT NULL,
    locker NUMERIC NOT NULL,
    pool_key_id int8 NOT NULL,
    sqrt_ratio_after NUMERIC NOT NULL,
    tick_after int4 NOT NULL,
    liquidity_after NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, pool_balance_change_id),
    FOREIGN KEY (chain_id, pool_balance_change_id) REFERENCES pool_balance_change_event (chain_id, event_id) ON DELETE CASCADE,
    FOREIGN KEY (pool_key_id) REFERENCES pool_keys (id)
);
CREATE INDEX idx_swaps_pool_key_id_event_id ON swaps USING btree (pool_key_id, pool_balance_change_id);
CREATE INDEX idx_swaps_pool_key_id_event_id_desc ON swaps USING btree (pool_key_id, pool_balance_change_id DESC) INCLUDE (sqrt_ratio_after, tick_after, liquidity_after);