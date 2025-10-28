CREATE TABLE cursor (
    indexer_name TEXT NOT NULL PRIMARY KEY,
    order_key BIGINT NOT NULL,
    unique_key bytea,
    last_updated timestamptz NOT NULL
);
CREATE TABLE blocks (
    chain_id int8 NOT NULL,
    number int8 NOT NULL,
    hash NUMERIC NOT NULL,
    time timestamptz NOT NULL,
    inserted timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chain_id, number)
);
CREATE INDEX idx_blocks_chain_id_time ON blocks USING btree (chain_id, time);
CREATE UNIQUE INDEX idx_blocks_chain_id_hash ON blocks USING btree (chain_id, hash);
-- all events reference an chain_id, event_id which contains the metadata of the event
CREATE TABLE event_keys (
    chain_id int8 NOT NULL,
    event_id int8 GENERATED ALWAYS AS (
        -- this allows for 2**16 events per transaction, 2**16 transactions per block, and 2**32 = 4294967296 ~= 4.3B blocks
        -- 4.3B blocks is 136 years of 1 second blocks
        -9223372036854775807::int8 + (block_number * pow(2, 32)::int8) + (transaction_index::int8 * pow(2, 16)::int8) + event_index::int8
    ) STORED,
    transaction_hash NUMERIC NOT NULL,
    block_number int8 NOT NULL CHECK (
        block_number >= 0
        AND block_number < pow(2, 32)
    ),
    transaction_index int4 NOT NULL CHECK (
        transaction_index >= 0
        AND transaction_index < pow(2, 16)
    ),
    event_index int4 NOT NULL CHECK (
        event_index >= 0
        AND event_index < pow(2, 16)
    ),
    emitter NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, number) ON DELETE CASCADE,
    UNIQUE (
        chain_id,
        block_number,
        transaction_index,
        event_index
    )
);
CREATE INDEX idx_event_keys_transaction_hash ON event_keys USING btree (transaction_hash);