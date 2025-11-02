CREATE TABLE spline_liquidity_updated (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    sender numeric NOT NULL,
    liquidity_factor numeric NOT NULL,
    shares numeric NOT NULL,
    amount0 numeric NOT NULL,
    amount1 numeric NOT NULL,
    protocol_fees0 numeric NOT NULL,
    protocol_fees1 numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_spline_liquidity_updated
	BEFORE UPDATE ON spline_liquidity_updated
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE spline_pools (
  pool_key_id int8 NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE FUNCTION recompute_spline_pool(p_pool_key_id int8)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM spline_liquidity_updated
    WHERE pool_key_id = p_pool_key_id
    LIMIT 1
  ) INTO v_exists;

  IF v_exists THEN
    INSERT INTO spline_pools (pool_key_id)
    VALUES (p_pool_key_id)
    ON CONFLICT (pool_key_id) DO NOTHING;
  ELSE
    DELETE FROM spline_pools WHERE pool_key_id = p_pool_key_id;
  END IF;
END
$$;

CREATE FUNCTION trg_slu_maintain_spline_pools()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM recompute_spline_pool(NEW.pool_key_id);
  ELSE -- DELETE
    PERFORM recompute_spline_pool(OLD.pool_key_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_slu_maintain_spline_pools
AFTER INSERT OR DELETE ON spline_liquidity_updated
FOR EACH ROW EXECUTE FUNCTION trg_slu_maintain_spline_pools();
