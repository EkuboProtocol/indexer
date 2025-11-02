CREATE TABLE protocol_fees_paid (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON protocol_fees_paid (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_protocol_fees_paid
	BEFORE UPDATE ON protocol_fees_paid
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE position_minted_with_referrer (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	token_id numeric NOT NULL,
	referrer numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_position_minted_with_referrer_token_id ON position_minted_with_referrer (token_id);

CREATE TRIGGER no_updates_position_minted_with_referrer
	BEFORE UPDATE ON position_minted_with_referrer
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TRIGGER sync_pool_balance_on_protocol_fees_paid
	AFTER INSERT ON protocol_fees_paid
	FOR EACH ROW
	EXECUTE FUNCTION insert_pool_balance_change();

CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_protocol_fees_paid
	AFTER INSERT OR DELETE ON protocol_fees_paid DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ();

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_protocol_fees_paid
	AFTER INSERT OR DELETE ON protocol_fees_paid
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_pool_tvl ();
