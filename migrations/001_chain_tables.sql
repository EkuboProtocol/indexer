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
CREATE TABLE pool_keys (
    id serial8 NOT NULL PRIMARY KEY,
    chain_id int8 NOT NULL,
    core_address NUMERIC NOT NULL,
    pool_id NUMERIC NOT NULL,
    token0 NUMERIC NOT NULL,
    token1 NUMERIC NOT NULL,
    fee NUMERIC NOT NULL,
    tick_spacing INT NOT NULL,
    extension NUMERIC NOT NULL
);
CREATE UNIQUE INDEX idx_pool_keys_chain_id_core_address_pool_id ON pool_keys USING btree (chain_id, core_address, pool_id);
CREATE INDEX idx_pool_keys_chain_id_token0 ON pool_keys USING btree (chain_id, token0);
CREATE INDEX idx_pool_keys_chain_id_token1 ON pool_keys USING btree (chain_id, token1);
CREATE INDEX idx_pool_keys_chain_id_token0_token1 ON pool_keys USING btree (chain_id, token0, token1);
CREATE INDEX idx_pool_keys_chain_id_extension ON pool_keys USING btree (chain_id, extension);
-- all events reference an event id which contains the metadata of the event
CREATE TABLE event_keys (
    chain_id int8 NOT NULL,
    sort_id int8 GENERATED ALWAYS AS (
        -- this allows for 2**16 = ~65k events per transaction and 2**20 = ~1M transactions per block while maintaining sort order
        block_number * pow(2, 20) + transaction_index * pow(2, 16) + event_index
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