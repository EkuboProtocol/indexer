CREATE TABLE indexer_cursor (
	indexer_name text NOT NULL PRIMARY KEY,
	order_key bigint NOT NULL,
	unique_key bytea,
	last_updated timestamptz NOT NULL
);

CREATE TABLE blocks (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL CHECK (block_number >= 0 AND block_number < pow(2, 32)::int8),
	hash numeric NOT NULL,
	time timestamptz NOT NULL,
	inserted timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX ON blocks USING btree (chain_id, time);

CREATE UNIQUE INDEX ON blocks USING btree (chain_id, hash);

-- all events reference an chain_id, event_id which contains the metadata of the event
CREATE TABLE event_keys (
	chain_id int8 NOT NULL,
	event_id int8 GENERATED ALWAYS AS (
	-- this allows for 2**16 events per transaction, 2**16 transactions per block, and 2**32 = 4294967296 ~= 4.3B blocks
	-- 4.3B blocks is 136 years of 1 second blocks
	- 9223372036854775807::int8 + (block_number * pow(2, 32)::int8) + (transaction_index::int8 * pow(2, 16)::int8) + event_index::int8) STORED,
	block_number int8 NOT NULL CHECK (block_number >= 0 AND block_number < pow(2, 32)::int8),
	transaction_index int4 NOT NULL CHECK (transaction_index >= 0 AND transaction_index < pow(2, 16)),
	event_index int4 NOT NULL CHECK (event_index >= 0 AND event_index < pow(2, 16)),
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE,
	UNIQUE (chain_id, block_number, transaction_index, event_index)
);

CREATE INDEX ON event_keys USING btree (transaction_hash);
