CREATE TABLE pool_keys (
	pool_key_id serial8 NOT NULL PRIMARY KEY,
	chain_id int8 NOT NULL,
	core_address numeric NOT NULL,
	pool_id numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	fee numeric NOT NULL,
	fee_denominator numeric NOT NULL CHECK (fee_denominator > 0),
	tick_spacing int NOT NULL,
	pool_extension numeric NOT NULL
);

CREATE UNIQUE INDEX ON pool_keys USING btree (chain_id, core_address, pool_id) INCLUDE (pool_key_id);

CREATE INDEX ON pool_keys USING btree (chain_id, token0);

CREATE INDEX ON pool_keys USING btree (chain_id, token1);

CREATE INDEX ON pool_keys USING btree (chain_id, token0, token1, pool_extension);

CREATE INDEX ON pool_keys USING btree (chain_id, pool_extension);

CREATE TABLE pool_initializations (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	tick int4 NOT NULL,
	sqrt_ratio numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE pool_balance_change (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	delta0 numeric NOT NULL,
	delta1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX ON pool_balance_change USING btree (pool_key_id, event_id);

CREATE INDEX ON pool_balance_change USING btree (pool_key_id, event_id DESC);

CREATE TABLE position_updates (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	locker numeric NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	liquidity_delta numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX ON position_updates USING btree (chain_id, locker, salt);

CREATE INDEX ON position_updates USING btree (chain_id, salt);

CREATE TABLE position_fees_collected (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	locker numeric NOT NULL,
	salt numeric NOT NULL,
	lower_bound int4 NOT NULL,
	upper_bound int4 NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX ON position_fees_collected USING btree (chain_id, locker, salt);

CREATE TABLE fees_accumulated (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE swaps (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	locker numeric NOT NULL,
	sqrt_ratio_after numeric NOT NULL,
	tick_after int4 NOT NULL,
	liquidity_after numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES pool_balance_change (chain_id, event_id) ON DELETE CASCADE
);

-- these are not common across all networks
CREATE TABLE protocol_fees_withdrawn (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	recipient numeric NOT NULL,
	token numeric NOT NULL,
	amount numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE extension_registrations (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_extension numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
