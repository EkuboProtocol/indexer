CREATE TABLE indexer_cursor (
	indexer_name text NOT NULL PRIMARY KEY,
	order_key bigint NOT NULL,
	unique_key bytea,
	last_updated timestamptz NOT NULL
);

CREATE TABLE blocks (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	block_hash numeric NOT NULL,
	block_time timestamptz NOT NULL,
	PRIMARY KEY (chain_id, block_number),
	UNIQUE (chain_id, block_hash)
);

CREATE INDEX ON blocks (chain_id, block_time);

CREATE FUNCTION compute_event_id(p_block_number bigint, p_transaction_index int4, p_event_index int4)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  block_limit int8 := pow(2, 32)::int8;
  index_limit int8 := pow(2, 16)::int8;
  block_big int8 := p_block_number;
  tx_big int8 := p_transaction_index;
  event_big int8 := p_event_index;
BEGIN
  IF block_big < 0 OR block_big >= block_limit THEN
    RAISE EXCEPTION 'block_number % out of allowed range [0, %)', block_big, block_limit;
  END IF;
  IF tx_big < 0 OR tx_big >= index_limit THEN
    RAISE EXCEPTION 'transaction_index % out of allowed range [0, %)', tx_big, index_limit;
  END IF;
  IF event_big < 0 OR event_big >= index_limit THEN
    RAISE EXCEPTION 'event_index % out of allowed range [0, %)', event_big, index_limit;
  END IF;

  RETURN -9223372036854775807::int8
         + (block_big * block_limit)
         + (tx_big * index_limit)
         + event_big;
END;
$$;

CREATE FUNCTION block_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Updates are not allowed on %', TG_TABLE_NAME;
END;
$$;

-- blocks are only to be inserted or deleted
CREATE TRIGGER no_updates_blocks
	BEFORE UPDATE ON blocks
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
