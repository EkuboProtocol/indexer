CREATE TABLE pool_keys (
	pool_key_id serial8 NOT NULL PRIMARY KEY,
	chain_id int8 NOT NULL,
	core_address numeric NOT NULL,
	pool_id numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	fee numeric NOT NULL,
	fee_denominator numeric NOT NULL CHECK (fee_denominator > 0),
	tick_spacing int4 NOT NULL,
	pool_extension numeric NOT NULL
);

CREATE UNIQUE INDEX ON pool_keys (chain_id, core_address, pool_id) INCLUDE (pool_key_id);
CREATE INDEX ON pool_keys (chain_id, token0);
CREATE INDEX ON pool_keys (chain_id, token1);
CREATE INDEX ON pool_keys (chain_id, token0, token1, pool_extension);
CREATE INDEX ON pool_keys (chain_id, pool_extension);

CREATE TABLE pool_initializations (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	tick int4 NOT NULL,
	sqrt_ratio numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_pool_initializations
	BEFORE UPDATE ON pool_initializations
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE position_updates (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	locker numeric NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	liquidity_delta numeric NOT NULL,
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON position_updates (chain_id, locker, salt);
CREATE INDEX ON position_updates (chain_id, salt);
CREATE INDEX ON position_updates (pool_key_id, event_id);

CREATE TRIGGER no_updates_position_updates
	BEFORE UPDATE ON position_updates
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE position_fees_collected (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	locker numeric NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON position_fees_collected (chain_id, locker, salt);
CREATE INDEX ON position_fees_collected (pool_key_id, event_id);

CREATE TRIGGER no_updates_position_fees_collected
	BEFORE UPDATE ON position_fees_collected
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE fees_accumulated (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON fees_accumulated (pool_key_id, event_id);

CREATE TRIGGER no_updates_fees_accumulated
	BEFORE UPDATE ON fees_accumulated
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE swaps (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	locker numeric NOT NULL,
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	sqrt_ratio_after numeric NOT NULL,
	tick_after int4 NOT NULL,
	liquidity_after numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON swaps (pool_key_id, event_id);

CREATE TRIGGER no_updates_swaps
	BEFORE UPDATE ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

-- these are not common across all networks
CREATE TABLE protocol_fees_withdrawn (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	recipient numeric NOT NULL,
	token numeric NOT NULL,
	amount numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_protocol_fees_withdrawn
	BEFORE UPDATE ON protocol_fees_withdrawn
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE extension_registrations (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_extension numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE,
	UNIQUE (chain_id, emitter, pool_extension)
);

CREATE TRIGGER no_updates_extension_registrations
	BEFORE UPDATE ON extension_registrations
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE pool_balance_change (
 	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_pool_balance_change
	BEFORE UPDATE ON pool_balance_change
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE OR REPLACE FUNCTION insert_pool_balance_change()
RETURNS trigger AS $$
BEGIN
    INSERT INTO pool_balance_change (
        chain_id,
        block_number,
        transaction_index,
        event_index,
        transaction_hash,
        emitter,
        event_id,
        pool_key_id,
        delta0,
        delta1
    ) VALUES (
        NEW.chain_id,
        NEW.block_number,
        NEW.transaction_index,
        NEW.event_index,
        NEW.transaction_hash,
        NEW.emitter,
        NEW.event_id,
        NEW.pool_key_id,
        NEW.delta0,
        NEW.delta1
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_pool_balance_on_swap
AFTER INSERT ON swaps
FOR EACH ROW
EXECUTE FUNCTION insert_pool_balance_change();
CREATE TRIGGER sync_pool_balance_on_position_update
AFTER INSERT ON position_updates
FOR EACH ROW
EXECUTE FUNCTION insert_pool_balance_change();
CREATE TRIGGER sync_pool_balance_on_position_fee_collect
AFTER INSERT ON position_fees_collected
FOR EACH ROW
EXECUTE FUNCTION insert_pool_balance_change();
CREATE TRIGGER sync_pool_balance_on_fees_accumulated
AFTER INSERT ON fees_accumulated
FOR EACH ROW
EXECUTE FUNCTION insert_pool_balance_change();

