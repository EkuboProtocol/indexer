CREATE TABLE mev_capture_pool_keys (
	pool_key_id int8 PRIMARY KEY NOT NULL REFERENCES pool_keys (pool_key_id)
);
