CREATE TABLE mev_capture_pool_keys (
    pool_key_id int8 NOT NULL,
    PRIMARY KEY (pool_key_id),
    FOREIGN KEY (pool_key_id) REFERENCES pool_keys (id)
);