CREATE TABLE position_transfers (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    token_id NUMERIC NOT NULL,
    from_address NUMERIC NOT NULL,
    to_address NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_position_transfers_token_id_from_to ON position_transfers (token_id, from_address, to_address);
CREATE INDEX idx_position_transfers_to_address ON position_transfers (to_address);
CREATE TABLE order_transfers (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    token_id NUMERIC NOT NULL,
    from_address NUMERIC NOT NULL,
    to_address NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE INDEX idx_order_transfers_token_id_from_to ON order_transfers (token_id, from_address, to_address);
CREATE INDEX idx_order_transfers_to_address ON order_transfers (to_address);