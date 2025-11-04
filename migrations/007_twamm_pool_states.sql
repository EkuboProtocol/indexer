-- CREATE TABLE twamm_pool_states (
--   pool_key_id                     int8        NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id),
--   token0_sale_rate                numeric     NOT NULL,
--   token1_sale_rate                numeric     NOT NULL,
--   last_virtual_execution_time     timestamptz NOT NULL,
--   last_virtual_order_execution_event_id int8  NOT NULL,
--   -- this is useful because it tells us if we need to re-fetch the twamm order sale rates
--   last_order_update_event_id      int8,
--   last_event_id                   int8        NOT NULL
-- );

-- CREATE UNIQUE INDEX idx_twamm_pool_states_pool_key_id ON twamm_pool_states (pool_key_id);

-- -- 2) Core recomputation function (idempotent, called by triggers)
-- CREATE FUNCTION recompute_twamm_pool_state(p_pool_key_id int8)
-- RETURNS void
-- LANGUAGE plpgsql AS $$
-- DECLARE
--   v_last_voe_event_id int8;
--   v_base_token0 numeric;
--   v_base_token1 numeric;
--   v_last_voe_time timestamptz;

--   v_delta0 numeric;
--   v_delta1 numeric;
--   v_last_ou_event_id int8;

--   v_psv_last_event_id int8;
--   v_final_token0 numeric;
--   v_final_token1 numeric;
--   v_final_last_event_id int8;
-- BEGIN
--   -- Find last VOE for the pool; if none, remove any existing state row.
--   SELECT voe.event_id, voe.token0_sale_rate, voe.token1_sale_rate, b.block_time
--   INTO   v_last_voe_event_id, v_base_token0, v_base_token1, v_last_voe_time
--   FROM   twamm_virtual_order_executions voe
--   JOIN   blocks b
--          ON b.chain_id = voe.chain_id AND b.block_number = voe.block_number
--   WHERE  voe.pool_key_id = p_pool_key_id
--   ORDER  BY voe.event_id DESC
--   LIMIT  1;

--   IF v_last_voe_event_id IS NULL THEN
--     DELETE FROM twamm_pool_states WHERE pool_key_id = p_pool_key_id;
--     RETURN;
--   END IF;

--   -- Deltas from order updates strictly "active at" the last VOE time
--   SELECT
--     COALESCE(SUM(tou.sale_rate_delta0), 0),
--     COALESCE(SUM(tou.sale_rate_delta1), 0),
--     MAX(tou.event_id)
--   INTO v_delta0, v_delta1, v_last_ou_event_id
--   FROM twamm_order_updates tou
--   WHERE tou.pool_key_id = p_pool_key_id
--     AND tou.event_id > v_last_voe_event_id
--     AND tou.start_time <= v_last_voe_time
--     AND tou.end_time   >  v_last_voe_time;

--   v_final_token0 := v_base_token0 + v_delta0;
--   v_final_token1 := v_base_token1 + v_delta1;

--   -- Pull psv.last_event_id (from the existing pool_states table)
--   SELECT ps.last_event_id
--   INTO   v_psv_last_event_id
--   FROM   pool_states ps
--   WHERE  ps.pool_key_id = p_pool_key_id;

--   v_final_last_event_id :=
--     GREATEST(COALESCE(v_last_ou_event_id, v_last_voe_event_id),
--              COALESCE(v_psv_last_event_id, v_last_voe_event_id));

--   -- Upsert the state row
--   INSERT INTO twamm_pool_states AS s (
--     pool_key_id,
--     token0_sale_rate,
--     token1_sale_rate,
--     last_virtual_execution_time,
--     last_virtual_order_execution_event_id,
--     last_order_update_event_id,
--     last_event_id
--   )
--   VALUES (
--     p_pool_key_id,
--     v_final_token0,
--     v_final_token1,
--     v_last_voe_time,
--     v_last_voe_event_id,
--     v_last_ou_event_id,
--     v_final_last_event_id
--   )
--   ON CONFLICT (pool_key_id) DO UPDATE
--     SET token0_sale_rate                        = EXCLUDED.token0_sale_rate,
--         token1_sale_rate                        = EXCLUDED.token1_sale_rate,
--         last_virtual_execution_time             = EXCLUDED.last_virtual_execution_time,
--         last_virtual_order_execution_event_id   = EXCLUDED.last_virtual_order_execution_event_id,
--         last_order_update_event_id              = EXCLUDED.last_order_update_event_id,
--         last_event_id                           = EXCLUDED.last_event_id;
-- END
-- $$;

-- -- 3) Trigger functions

-- -- a) When VOEs change, the "last VOE" may shift; recompute for that pool.
-- CREATE FUNCTION trg_voe_recompute_pool_state()
-- RETURNS trigger
-- LANGUAGE plpgsql AS $$
-- BEGIN
--   IF (TG_OP = 'INSERT') THEN
--     PERFORM recompute_twamm_pool_state(NEW.pool_key_id);
--   ELSE
--     PERFORM recompute_twamm_pool_state(OLD.pool_key_id);
--   END IF;
--   RETURN NULL;
-- END
-- $$;

-- -- b) When order updates change, deltas after last VOE may change; recompute.
-- CREATE FUNCTION trg_order_updates_recompute_pool_state()
-- RETURNS trigger
-- LANGUAGE plpgsql AS $$
-- BEGIN
--   IF (TG_OP = 'INSERT') THEN
--     PERFORM recompute_twamm_pool_state(NEW.pool_key_id);
--   ELSE
--     PERFORM recompute_twamm_pool_state(OLD.pool_key_id);
--   END IF;
--   RETURN NULL;
-- END
-- $$;

-- -- c) When pool_states.last_event_id changes, it affects the GREATEST(...); recompute.
-- CREATE FUNCTION trg_pool_states_recompute_pool_state()
-- RETURNS trigger
-- LANGUAGE plpgsql AS $$
-- BEGIN
--   -- Only recompute when last_event_id or pool_key_id changed
--   IF (TG_OP = 'INSERT') THEN
--     PERFORM recompute_twamm_pool_state(NEW.pool_key_id);
--   ELSIF TG_OP = 'DELETE' THEN
--     -- If a row is removed from pool_states, fall back to GREATEST(last_ou,last_voe).
--     PERFORM recompute_twamm_pool_state(OLD.pool_key_id);
--   END IF;
--   RETURN NULL;
-- END
-- $$;

-- CREATE TRIGGER trg_voe_recompute_pool_state
--   AFTER INSERT OR DELETE ON twamm_virtual_order_executions
--   FOR EACH ROW EXECUTE FUNCTION trg_voe_recompute_pool_state();

-- CREATE TRIGGER trg_order_updates_recompute_pool_state
--   AFTER INSERT OR DELETE ON twamm_order_updates
--   FOR EACH ROW EXECUTE FUNCTION trg_order_updates_recompute_pool_state();

-- CREATE TRIGGER trg_pool_states_recompute_pool_state
--   AFTER INSERT OR DELETE ON pool_states
--   FOR EACH ROW EXECUTE FUNCTION trg_pool_states_recompute_pool_state();
