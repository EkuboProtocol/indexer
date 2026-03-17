CREATE OR REPLACE FUNCTION recompute_boosted_fees_pool_state(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql AS
$$
DECLARE
    v_last_donated_event_id int8;
    v_base_donate_rate0     NUMERIC;
    v_base_donate_rate1     NUMERIC;
    v_last_donated_time     timestamptz;

    v_delta0                NUMERIC;
    v_delta1                NUMERIC;
    v_last_boost_event_id   int8;

    v_pool_last_event_id    int8;
    v_last_event_id         int8;
BEGIN
    SELECT bfd.event_id,
           bfd.donate_rate0,
           bfd.donate_rate1,
           b.block_time
    INTO v_last_donated_event_id,
        v_base_donate_rate0,
        v_base_donate_rate1,
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

    -- Boosts created after the last donated event that are active at the donated timestamp
    -- should be folded into the current donated rate snapshot.
    SELECT COALESCE(SUM(bfe.rate0), 0),
           COALESCE(SUM(bfe.rate1), 0),
           MAX(bfe.event_id)
    INTO v_delta0,
        v_delta1,
        v_last_boost_event_id
    FROM boosted_fees_events bfe
    WHERE bfe.pool_key_id = p_pool_key_id
      AND bfe.event_id > v_last_donated_event_id
      AND bfe.start_time <= v_last_donated_time
      AND bfe.end_time > v_last_donated_time;

    SELECT ps.last_event_id
    INTO v_pool_last_event_id
    FROM pool_states ps
    WHERE ps.pool_key_id = p_pool_key_id;

    v_last_event_id := GREATEST(
            COALESCE(v_last_boost_event_id, v_last_donated_event_id),
            COALESCE(v_pool_last_event_id, v_last_donated_event_id)
                       );

    INSERT INTO boosted_fees_pool_states AS s (pool_key_id,
                                               donate_rate0,
                                               donate_rate1,
                                               last_donated_time,
                                               last_donated_event_id,
                                               last_event_id)
    VALUES (p_pool_key_id,
            v_base_donate_rate0 + v_delta0,
            v_base_donate_rate1 + v_delta1,
            v_last_donated_time,
            v_last_donated_event_id,
            v_last_event_id)
    ON CONFLICT (pool_key_id) DO UPDATE
        SET donate_rate0          = excluded.donate_rate0,
            donate_rate1          = excluded.donate_rate1,
            last_donated_time     = excluded.last_donated_time,
            last_donated_event_id = excluded.last_donated_event_id,
            last_event_id         = excluded.last_event_id;
END
$$;

CREATE OR REPLACE FUNCTION trg_boosted_fees_events_on_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM apply_boosted_fees_donate_rate_delta(new.pool_key_id, new.start_time, new.rate0, new.rate1);
    PERFORM apply_boosted_fees_donate_rate_delta(new.pool_key_id, new.end_time, -new.rate0, -new.rate1);
    PERFORM recompute_boosted_fees_pool_state(new.pool_key_id);
    RETURN new;
END
$$;

CREATE OR REPLACE FUNCTION trg_boosted_fees_events_on_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM apply_boosted_fees_donate_rate_delta(old.pool_key_id, old.start_time, -old.rate0, -old.rate1);
    PERFORM apply_boosted_fees_donate_rate_delta(old.pool_key_id, old.end_time, old.rate0, old.rate1);
    PERFORM recompute_boosted_fees_pool_state(old.pool_key_id);
    RETURN old;
END
$$;

SELECT recompute_boosted_fees_pool_state(bps.pool_key_id)
FROM boosted_fees_pool_states bps;
