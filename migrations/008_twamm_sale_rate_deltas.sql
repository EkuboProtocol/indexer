
CREATE TABLE twamm_sale_rate_deltas (
  pool_key_id      int8    NOT NULL REFERENCES pool_keys (pool_key_id),
  "time"           timestamptz NOT NULL,
  net_sale_rate_delta0 numeric NOT NULL,
  net_sale_rate_delta1 numeric NOT NULL,
  PRIMARY KEY (pool_key_id, "time")
);

CREATE FUNCTION apply_twamm_sale_rate_delta(
  p_pool_key_id int8,
  p_time timestamptz,
  p_delta0 numeric,
  p_delta1 numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Upsert the change
  INSERT INTO twamm_sale_rate_deltas AS t (pool_key_id, "time", net_sale_rate_delta0, net_sale_rate_delta1)
  VALUES (p_pool_key_id, p_time, p_delta0, p_delta1)
  ON CONFLICT (pool_key_id, "time") DO UPDATE
    SET net_sale_rate_delta0 = t.net_sale_rate_delta0 + EXCLUDED.net_sale_rate_delta0,
        net_sale_rate_delta1 = t.net_sale_rate_delta1 + EXCLUDED.net_sale_rate_delta1;

  -- If both become 0, remove the row (keeps table sparse like the original WHERE clause)
  DELETE FROM twamm_sale_rate_deltas
  WHERE pool_key_id = p_pool_key_id
    AND "time" = p_time
    AND net_sale_rate_delta0 = 0
    AND net_sale_rate_delta1 = 0;
END
$$;

-- 3) Main trigger function on twamm_order_updates
CREATE FUNCTION trg_twamm_order_updates_to_deltas()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- old values (only used for UPDATE/DELETE)
  o_pool int8;  o_start timestamptz;  o_end timestamptz;
  o_d0 numeric; o_d1 numeric;
  -- new values (only used for INSERT/UPDATE)
  n_pool int8;  n_start timestamptz;  n_end timestamptz;
  n_d0 numeric; n_d1 numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    n_pool  := NEW.pool_key_id;  n_start := NEW.start_time; n_end := NEW.end_time;
    n_d0    := NEW.sale_rate_delta0;  n_d1 := NEW.sale_rate_delta1;

    PERFORM apply_twamm_sale_rate_delta(n_pool, n_start,  n_d0,  n_d1);
    PERFORM apply_twamm_sale_rate_delta(n_pool, n_end,   -n_d0, -n_d1);
    RETURN NEW;

  ELSE /* TG_OP = 'DELETE' */
    o_pool  := OLD.pool_key_id;  o_start := OLD.start_time; o_end := OLD.end_time;
    o_d0    := OLD.sale_rate_delta0;  o_d1 := OLD.sale_rate_delta1;

    -- reverse the INSERT effects
    PERFORM apply_twamm_sale_rate_delta(o_pool, o_start, -o_d0, -o_d1);
    PERFORM apply_twamm_sale_rate_delta(o_pool, o_end,    o_d0,  o_d1);
    RETURN OLD;
  END IF;
END
$$;

-- 4) Attach the trigger to twamm_order_updates (AFTER so all values are stable)
CREATE TRIGGER trg_twamm_order_updates_to_deltas
  AFTER INSERT OR DELETE ON twamm_order_updates
  FOR EACH ROW
  EXECUTE FUNCTION trg_twamm_order_updates_to_deltas();
