CREATE TABLE spline_liquidity_updated (
    chain_id int8 NOT NULL,
    event_id int8 NOT NULL,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    sender numeric NOT NULL,
    liquidity_factor numeric NOT NULL,
    shares numeric NOT NULL,
    amount0 numeric NOT NULL,
    amount1 numeric NOT NULL,
    protocol_fees0 numeric NOT NULL,
    protocol_fees1 numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE spline_pools (
  pool_key_id int8 NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE OR REPLACE FUNCTION recompute_spline_pool(p_pool_key_id int8)
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

CREATE OR REPLACE FUNCTION trg_slu_maintain_spline_pools()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM recompute_spline_pool(NEW.pool_key_id);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Recompute for both old and new in case pool_key_id changed
    IF NEW.pool_key_id IS DISTINCT FROM OLD.pool_key_id THEN
      PERFORM recompute_spline_pool(OLD.pool_key_id);
      PERFORM recompute_spline_pool(NEW.pool_key_id);
    ELSE
      PERFORM recompute_spline_pool(NEW.pool_key_id);
    END IF;
  ELSE -- DELETE
    PERFORM recompute_spline_pool(OLD.pool_key_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_slu_maintain_spline_pools
AFTER INSERT OR UPDATE OR DELETE ON spline_liquidity_updated
FOR EACH ROW EXECUTE FUNCTION trg_slu_maintain_spline_pools();
