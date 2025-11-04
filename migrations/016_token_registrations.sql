CREATE TABLE token_registrations (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	address numeric NOT NULL,
	name numeric NOT NULL,
	symbol numeric NOT NULL,
	decimals int NOT NULL,
	total_supply numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_token_registrations
	BEFORE UPDATE ON token_registrations
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE token_registrations_v3 (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	address numeric NOT NULL,
	name varchar NOT NULL,
	symbol varchar NOT NULL,
	decimals int NOT NULL,
	total_supply numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_token_registrations_v3
	BEFORE UPDATE ON token_registrations_v3
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
