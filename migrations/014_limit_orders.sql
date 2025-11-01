CREATE TABLE limit_order_placed (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	tick int4 NOT NULL,
	liquidity numeric NOT NULL,
	amount numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id)
);

CREATE INDEX ON limit_order_placed (chain_id, OWNER, salt);

CREATE INDEX ON limit_order_placed (chain_id, salt, event_id DESC) INCLUDE (token0, token1, tick, liquidity, amount);

CREATE TABLE limit_order_closed (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	tick int4 NOT NULL,
	amount0 numeric NOT NULL,
	amount1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id)
);

CREATE INDEX ON limit_order_closed (chain_id, OWNER, salt);

CREATE INDEX ON limit_order_closed (chain_id, salt, event_id DESC) INCLUDE (amount0, amount1);

-- computed via triggers

CREATE TABLE limit_order_pool_states (
  pool_key_id   int8  NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id),
  last_event_id int8  NOT NULL
);

CREATE OR REPLACE FUNCTION recompute_limit_order_pool_state(p_pool_key_id int8)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_llop int8;   -- last_limit_order_placed.event_id
  v_lloc int8;   -- last_limit_order_closed.event_id (nullable)
  v_psm  int8;   -- pool_states.last_event_id (required in original view)
  v_last int8;
BEGIN
  -- last_limit_order_placed (driving set; if absent, row should not exist)
  SELECT MAX(event_id) INTO v_llop
  FROM limit_order_placed
  WHERE pool_key_id = p_pool_key_id;

  IF v_llop IS NULL THEN
    -- No placements: ensure no row (matches JOIN on llop in original view)
    DELETE FROM limit_order_pool_states WHERE pool_key_id = p_pool_key_id;
    RETURN;
  END IF;

  -- last_limit_order_closed (optional)
  SELECT MAX(event_id) INTO v_lloc
  FROM limit_order_closed
  WHERE pool_key_id = p_pool_key_id;

  -- pool_states join (required by original view)
  SELECT ps.last_event_id INTO v_psm
  FROM pool_states ps
  WHERE ps.pool_key_id = p_pool_key_id;

  IF v_psm IS NULL THEN
    -- Original view would drop the row due to JOIN pool_states
    DELETE FROM limit_order_pool_states WHERE pool_key_id = p_pool_key_id;
    RETURN;
  END IF;

  -- last_event_id = GREATEST(GREATEST(llop, COALESCE(lloc,0)), v_psm)
  v_last := GREATEST(GREATEST(v_llop, COALESCE(v_lloc, 0)), v_psm);

  INSERT INTO limit_order_pool_states AS s (pool_key_id, last_event_id)
  VALUES (p_pool_key_id, v_last)
  ON CONFLICT (pool_key_id) DO UPDATE
    SET last_event_id = EXCLUDED.last_event_id;
END
$$;

CREATE OR REPLACE FUNCTION trg_lop_recompute_lops()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM recompute_limit_order_pool_state(NEW.pool_key_id);
  ELSE
    PERFORM recompute_limit_order_pool_state(OLD.pool_key_id);
  END IF;
  RETURN NULL;
END
$$;

-- b) limit_order_closed changes
CREATE OR REPLACE FUNCTION trg_loc_recompute_lops()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM recompute_limit_order_pool_state(NEW.pool_key_id);
  ELSE
    PERFORM recompute_limit_order_pool_state(OLD.pool_key_id);
  END IF;
  RETURN NULL;
END
$$;

-- c) pool_states.last_event_id changes (affects GREATEST(...))
CREATE OR REPLACE FUNCTION trg_ps_recompute_lops()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM recompute_limit_order_pool_state(NEW.pool_key_id);
  ELSIF TG_OP = 'UPDATE' AND (NEW.last_event_id IS DISTINCT FROM OLD.last_event_id
                              OR NEW.pool_key_id   IS DISTINCT FROM OLD.pool_key_id) THEN
    PERFORM recompute_limit_order_pool_state(NEW.pool_key_id);
  ELSIF TG_OP = 'DELETE' THEN
    -- Original view would lose the row due to the JOIN; recompute will delete it.
    PERFORM recompute_limit_order_pool_state(OLD.pool_key_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_lop_recompute_lops
AFTER INSERT OR UPDATE OR DELETE ON limit_order_placed
FOR EACH ROW EXECUTE FUNCTION trg_lop_recompute_lops();

CREATE TRIGGER trg_loc_recompute_lops
AFTER INSERT OR UPDATE OR DELETE ON limit_order_closed
FOR EACH ROW EXECUTE FUNCTION trg_loc_recompute_lops();

CREATE TRIGGER trg_ps_recompute_lops
AFTER INSERT OR UPDATE OF last_event_id OR DELETE ON pool_states
FOR EACH ROW EXECUTE FUNCTION trg_ps_recompute_lops();
