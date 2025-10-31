CREATE TABLE protocol_fees_paid (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX idx_protocol_fees_paid_pool_key_id ON protocol_fees_paid USING btree (pool_key_id);

CREATE INDEX idx_protocol_fees_paid_salt ON protocol_fees_paid USING btree (salt);

CREATE TABLE position_minted_with_referrer (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	token_id numeric NOT NULL,
	referrer numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_position_minted_with_referrer_token_id ON position_minted_with_referrer USING btree (token_id);
