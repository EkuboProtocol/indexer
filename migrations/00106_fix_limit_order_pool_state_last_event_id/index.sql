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

  -- PostgreSQL GREATEST ignores NULL arguments. Do not coalesce a missing
  -- close event to 0 because Starknet event ids are large negative int8 values.
  v_last := GREATEST(v_llop, v_lloc, v_psm);

  INSERT INTO limit_order_pool_states AS s (pool_key_id, last_event_id)
  VALUES (p_pool_key_id, v_last)
  ON CONFLICT (pool_key_id) DO UPDATE
    SET last_event_id = EXCLUDED.last_event_id;
END
$$;

SELECT recompute_limit_order_pool_state(pool_key_id)
FROM (
  SELECT pool_key_id FROM limit_order_placed
  UNION
  SELECT pool_key_id FROM limit_order_closed
  UNION
  SELECT pool_key_id FROM limit_order_pool_states
) affected_limit_order_pools;
