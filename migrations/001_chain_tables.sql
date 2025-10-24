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
-- all events reference an event id which contains the metadata of the event
CREATE TABLE event_keys (
    chain_id int8 NOT NULL,
    sort_id int8 GENERATED ALWAYS AS (
        -- this allows for 2**12 == 4096 events per transaction and 2**16 == 65,536 transactions per block and 2**(63-28) = 34,359,738,368 blocks
        (block_number * pow(2, 28)) + (transaction_index * pow(2, 12)) + event_index
    ) STORED,
    transaction_hash NUMERIC NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int2 NOT NULL,
    emitter NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, sort_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, number) ON DELETE CASCADE,
    UNIQUE (
        chain_id,
        block_number,
        transaction_index,
        event_index
    )
);
CREATE INDEX idx_event_keys_transaction_hash ON event_keys USING btree (transaction_hash);