CREATE TABLE boosted_fees_events (
    chain_id          int8        NOT NULL,
    block_number      int8        NOT NULL,
    transaction_index int4        NOT NULL,
    event_index       int4        NOT NULL,
    transaction_hash  NUMERIC     NOT NULL,
    emitter           NUMERIC     NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    start_time        timestamptz NOT NULL,
    end_time          timestamptz NOT NULL,
    rate0             NUMERIC     NOT NULL,
    rate1             NUMERIC     NOT NULL,
    block_time        timestamptz NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON boosted_fees_events (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_boosted_fees_events
    BEFORE UPDATE
    ON boosted_fees_events
    FOR EACH ROW
    EXECUTE function block_updates();

DROP TRIGGER IF EXISTS set_block_time_boosted_fees_events ON boosted_fees_events;

CREATE TRIGGER set_block_time_boosted_fees_events
    BEFORE INSERT
    ON boosted_fees_events
    FOR EACH ROW
EXECUTE FUNCTION set_block_time_from_blocks();

CREATE TABLE boosted_fees_donated
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8    NOT NULL REFERENCES pool_keys (pool_key_id),
    donate_rate0      NUMERIC NOT NULL,
    donate_rate1      NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON boosted_fees_donated (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_boosted_fees_donated
    BEFORE UPDATE
    ON boosted_fees_donated
    FOR EACH ROW
    EXECUTE function block_updates();

CREATE TABLE boosted_fees_pool_states (
    pool_key_id            int8        NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    donate_rate0           numeric     NOT NULL,
    donate_rate1           numeric     NOT NULL,
    last_donated_time      timestamptz NOT NULL,
    last_donated_event_id  int8        NOT NULL,
    last_event_id          int8        NOT NULL
);

CREATE FUNCTION recompute_boosted_fees_pool_state(p_pool_key_id int8)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_last_donated_event_id int8;
    v_donate_rate0 numeric;
    v_donate_rate1 numeric;
    v_last_donated_time timestamptz;
    v_pool_last_event_id int8;
    v_last_event_id int8;
BEGIN
    SELECT bfd.event_id,
           bfd.donate_rate0,
           bfd.donate_rate1,
           b.block_time
    INTO v_last_donated_event_id,
         v_donate_rate0,
         v_donate_rate1,
         v_last_donated_time
    FROM boosted_fees_donated bfd
             JOIN blocks b
                  ON b.chain_id = bfd.chain_id AND b.block_number = bfd.block_number
    WHERE bfd.pool_key_id = p_pool_key_id
    ORDER BY bfd.event_id DESC
    LIMIT 1;

    IF v_last_donated_event_id IS NULL THEN
        DELETE FROM boosted_fees_pool_states WHERE pool_key_id = p_pool_key_id;
        RETURN;
    END IF;

    SELECT ps.last_event_id
    INTO v_pool_last_event_id
    FROM pool_states ps
    WHERE ps.pool_key_id = p_pool_key_id;

    v_last_event_id := GREATEST(COALESCE(v_pool_last_event_id, v_last_donated_event_id), v_last_donated_event_id);

    INSERT INTO boosted_fees_pool_states AS s (
        pool_key_id,
        donate_rate0,
        donate_rate1,
        last_donated_time,
        last_donated_event_id,
        last_event_id
    )
    VALUES (
        p_pool_key_id,
        v_donate_rate0,
        v_donate_rate1,
        v_last_donated_time,
        v_last_donated_event_id,
        v_last_event_id
    )
    ON CONFLICT (pool_key_id) DO UPDATE
        SET donate_rate0          = EXCLUDED.donate_rate0,
            donate_rate1          = EXCLUDED.donate_rate1,
            last_donated_time     = EXCLUDED.last_donated_time,
            last_donated_event_id = EXCLUDED.last_donated_event_id,
            last_event_id         = EXCLUDED.last_event_id;
END
$$;

CREATE FUNCTION trg_boosted_fees_donated_recompute_state()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM recompute_boosted_fees_pool_state(NEW.pool_key_id);
    ELSE
        PERFORM recompute_boosted_fees_pool_state(OLD.pool_key_id);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_boosted_fees_donated_recompute_state
    AFTER INSERT OR DELETE ON boosted_fees_donated
    FOR EACH ROW
EXECUTE FUNCTION trg_boosted_fees_donated_recompute_state();

CREATE TABLE boosted_fees_donate_rate_deltas (
    pool_key_id                   int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    "time"                        timestamptz NOT NULL,
    net_stored_donate_rate_delta0 numeric     NOT NULL,
    net_stored_donate_rate_delta1 numeric     NOT NULL,
    net_actual_donate_rate_delta0 numeric     NOT NULL,
    net_actual_donate_rate_delta1 numeric     NOT NULL,
    PRIMARY KEY (pool_key_id, "time")
);

CREATE FUNCTION apply_boosted_fees_donate_rate_delta(
    p_pool_key_id int8,
    p_time timestamptz,
    p_stored_delta0 numeric,
    p_stored_delta1 numeric,
    p_actual_delta0 numeric,
    p_actual_delta1 numeric
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO boosted_fees_donate_rate_deltas AS t (
        pool_key_id,
        "time",
        net_stored_donate_rate_delta0,
        net_stored_donate_rate_delta1,
        net_actual_donate_rate_delta0,
        net_actual_donate_rate_delta1
    )
    VALUES (
        p_pool_key_id,
        p_time,
        p_stored_delta0,
        p_stored_delta1,
        p_actual_delta0,
        p_actual_delta1
    )
    ON CONFLICT (pool_key_id, "time") DO UPDATE
    SET net_stored_donate_rate_delta0 = t.net_stored_donate_rate_delta0 + EXCLUDED.net_stored_donate_rate_delta0,
        net_stored_donate_rate_delta1 = t.net_stored_donate_rate_delta1 + EXCLUDED.net_stored_donate_rate_delta1,
        net_actual_donate_rate_delta0 = t.net_actual_donate_rate_delta0 + EXCLUDED.net_actual_donate_rate_delta0,
        net_actual_donate_rate_delta1 = t.net_actual_donate_rate_delta1 + EXCLUDED.net_actual_donate_rate_delta1;

    DELETE FROM boosted_fees_donate_rate_deltas
    WHERE pool_key_id = p_pool_key_id
      AND "time" = p_time
      AND net_stored_donate_rate_delta0 = 0
      AND net_stored_donate_rate_delta1 = 0
      AND net_actual_donate_rate_delta0 = 0
      AND net_actual_donate_rate_delta1 = 0;
END
$$;

CREATE FUNCTION trg_boosted_fees_events_to_deltas()
    RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    o_pool int8;
    o_start timestamptz;
    o_end timestamptz;
    o_rate0 numeric;
    o_rate1 numeric;
    o_block_time timestamptz;
    o_actual_start timestamptz;
    n_pool int8;
    n_start timestamptz;
    n_end timestamptz;
    n_rate0 numeric;
    n_rate1 numeric;
    n_block_time timestamptz;
    n_actual_start timestamptz;
BEGIN
    IF TG_OP = 'INSERT' THEN
        n_pool := NEW.pool_key_id;
        n_start := NEW.start_time;
        n_end := NEW.end_time;
        n_rate0 := NEW.rate0;
        n_rate1 := NEW.rate1;
        n_block_time := NEW.block_time;

        PERFORM apply_boosted_fees_donate_rate_delta(n_pool, n_start, n_rate0, n_rate1, 0, 0);
        PERFORM apply_boosted_fees_donate_rate_delta(n_pool, n_end, -n_rate0, -n_rate1, 0, 0);

        n_actual_start := GREATEST(n_start, n_block_time);
        IF n_actual_start < n_end THEN
            PERFORM apply_boosted_fees_donate_rate_delta(n_pool, n_actual_start, 0, 0, n_rate0, n_rate1);
            PERFORM apply_boosted_fees_donate_rate_delta(n_pool, n_end, 0, 0, -n_rate0, -n_rate1);
        END IF;

        RETURN NEW;
    ELSE
        o_pool := OLD.pool_key_id;
        o_start := OLD.start_time;
        o_end := OLD.end_time;
        o_rate0 := OLD.rate0;
        o_rate1 := OLD.rate1;
        o_block_time := OLD.block_time;

        PERFORM apply_boosted_fees_donate_rate_delta(o_pool, o_start, -o_rate0, -o_rate1, 0, 0);
        PERFORM apply_boosted_fees_donate_rate_delta(o_pool, o_end, o_rate0, o_rate1, 0, 0);

        o_actual_start := GREATEST(o_start, o_block_time);
        IF o_actual_start < o_end THEN
            PERFORM apply_boosted_fees_donate_rate_delta(o_pool, o_actual_start, 0, 0, -o_rate0, -o_rate1);
            PERFORM apply_boosted_fees_donate_rate_delta(o_pool, o_end, 0, 0, o_rate0, o_rate1);
        END IF;

        RETURN OLD;
    END IF;
END
$$;

CREATE TRIGGER trg_boosted_fees_events_to_deltas
    AFTER INSERT OR DELETE ON boosted_fees_events
    FOR EACH ROW
EXECUTE FUNCTION trg_boosted_fees_events_to_deltas();

DROP VIEW IF EXISTS all_pool_states_view;

CREATE VIEW all_pool_states_view AS
SELECT pk.pool_key_id,
       pk.chain_id,
       pk.core_address,
       pk.token0,
       pk.token1,
       pk.fee,
       pk.tick_spacing,
       pk.pool_extension,
       pk.pool_config,
       pk.pool_config_type,
       pk.stableswap_center_tick,
       pk.stableswap_amplification,
       ps.sqrt_ratio,
       ps.liquidity,
       ps.tick,
       GREATEST(ps.last_event_id, tps.last_event_id)             AS last_event_id,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', ppptl.tick, 'd',
                                            ppptl.net_liquidity_delta_diff::TEXT) ORDER BY ppptl.tick)
        FROM per_pool_per_tick_liquidity ppptl
        WHERE ppptl.pool_key_id = pk.pool_key_id)                AS ticks,

       -- twamm state
       EXTRACT(EPOCH FROM tps.last_virtual_execution_time)::int8 AS twamm_last_virtual_execution_time,
       tps.token0_sale_rate                                      AS twamm_token0_sale_rate,
       tps.token1_sale_rate                                      AS twamm_token1_sale_rate,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', EXTRACT(EPOCH FROM tsrdm.time)::int8, 's0',
                                            tsrdm.net_sale_rate_delta0::TEXT,
                                            's1',
                                            tsrdm.net_sale_rate_delta1::TEXT) ORDER BY tsrdm.time)
        FROM twamm_sale_rate_deltas tsrdm
        WHERE tsrdm.pool_key_id = pk.pool_key_id
          AND time > last_virtual_execution_time)                AS twamm_orders,

       -- boosted fees state
       EXTRACT(EPOCH FROM bps.last_donated_time)::int8           AS boosted_fees_last_donated_time,
       bps.donate_rate0                                          AS boosted_fees_donate_rate0,
       bps.donate_rate1                                          AS boosted_fees_donate_rate1,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', EXTRACT(EPOCH FROM bfrd.time)::int8, 's0',
                                            bfrd.net_actual_donate_rate_delta0::TEXT,
                                            's1',
                                            bfrd.net_actual_donate_rate_delta1::TEXT) ORDER BY bfrd.time)
        FROM boosted_fees_donate_rate_deltas bfrd
        WHERE bfrd.pool_key_id = pk.pool_key_id
          AND bfrd.time > bps.last_donated_time)                 AS boosted_fees_donations,
       ops.last_snapshot_block_timestamp                         AS oracle_last_snapshot_block_timestamp,
       (mcpk.pool_key_id IS NOT NULL)                            AS is_mev_capture_pool,
       (sp.pool_key_id IS NOT NULL)                              AS is_spline_pool,
       (lops.pool_key_id IS NOT NULL)                            AS is_limit_order_pool
FROM pool_keys pk
         JOIN pool_states ps USING (pool_key_id)
         LEFT JOIN twamm_pool_states tps ON pk.pool_key_id = tps.pool_key_id
         LEFT JOIN oracle_pool_states ops ON ops.pool_key_id = pk.pool_key_id
         LEFT JOIN mev_capture_pool_keys mcpk ON mcpk.pool_key_id = pk.pool_key_id
         LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
         LEFT JOIN spline_pools sp ON sp.pool_key_id = pk.pool_key_id
         LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
WHERE (pool_extension = 0 OR ops.last_snapshot_block_timestamp IS NOT NULL OR tps.last_event_id IS NOT NULL OR
       mcpk.pool_key_id IS NOT NULL OR bps.last_donated_time IS NOT NULL OR sp.pool_key_id IS NOT NULL OR
       lops.pool_key_id IS NOT NULL);
