CREATE TABLE pool_states (
	pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
	sqrt_ratio numeric NOT NULL,
	tick int4 NOT NULL,
	liquidity numeric NOT NULL,
	last_event_id int8 NOT NULL,
	-- this is potentially useful because it tells us the next time we need to fetch ticks again
	last_position_update_event_id int8
);

CREATE FUNCTION refresh_pool_state (p_pool_key_id int8)
	RETURNS VOID
	AS $$
DECLARE
	v_state RECORD;
BEGIN
	WITH lss AS (
		SELECT
			pk.pool_key_id,
			coalesce(last_swap.event_id, pi.event_id) AS last_swap_event_id,
			coalesce(last_swap.sqrt_ratio_after, pi.sqrt_ratio) AS sqrt_ratio,
			coalesce(last_swap.tick_after, pi.tick) AS tick,
			coalesce(last_swap.liquidity_after, 0::numeric) AS liquidity_last
		FROM
			pool_keys pk
		LEFT JOIN LATERAL (
			SELECT
				s.pool_key_id,
				s.event_id,
				s.sqrt_ratio_after,
				s.tick_after,
				s.liquidity_after
			FROM
				swaps s
			WHERE
				pk.pool_key_id = s.pool_key_id
			ORDER BY
				event_id DESC
			LIMIT 1) AS last_swap ON TRUE
		LEFT JOIN LATERAL (
			SELECT
				event_id,
				sqrt_ratio,
				tick
			FROM
				pool_initializations
			WHERE
				pool_initializations.pool_key_id = pk.pool_key_id
			ORDER BY
				event_id DESC
			LIMIT 1) AS pi ON TRUE
	WHERE
		pk.pool_key_id = p_pool_key_id
),
pl AS (
	SELECT
		lss.pool_key_id,
		(
			SELECT
				event_id
			FROM
				position_updates pu
			WHERE
				lss.pool_key_id = pu.pool_key_id
			ORDER BY
				event_id DESC
			LIMIT 1) AS last_update_event_id,
	(coalesce(liquidity_last, 0::numeric) + coalesce((
			SELECT
				sum(liquidity_delta)
			FROM position_updates pu
			WHERE
				lss.last_swap_event_id < pu.event_id
				AND pu.pool_key_id = lss.pool_key_id
				AND lss.tick BETWEEN pu.lower_bound AND (pu.upper_bound - 1)), 0::numeric)) AS liquidity
FROM
	lss
)
SELECT
	lss.pool_key_id,
	lss.sqrt_ratio,
	lss.tick,
	pl.liquidity,
	GREATEST (lss.last_swap_event_id, pl.last_update_event_id) AS last_event_id,
	pl.last_update_event_id AS last_position_update_event_id INTO v_state
FROM
	lss
	JOIN pl ON lss.pool_key_id = pl.pool_key_id;
			IF NOT FOUND THEN
				DELETE FROM pool_states
				WHERE pool_key_id = p_pool_key_id;
			ELSE
				INSERT INTO pool_states (pool_key_id, sqrt_ratio, tick, liquidity, last_event_id, last_position_update_event_id)
					VALUES (v_state.pool_key_id, v_state.sqrt_ratio, v_state.tick, v_state.liquidity, v_state.last_event_id, v_state.last_position_update_event_id)
				ON CONFLICT (pool_key_id)
					DO UPDATE SET
						sqrt_ratio = EXCLUDED.sqrt_ratio, tick = EXCLUDED.tick, liquidity = EXCLUDED.liquidity, last_event_id = EXCLUDED.last_event_id, last_position_update_event_id = EXCLUDED.last_position_update_event_id;
			END IF;
END;
$$
LANGUAGE plpgsql;

CREATE FUNCTION refresh_pool_state ()
	RETURNS TRIGGER
	AS $$
BEGIN
	PERFORM refresh_pool_state (OLD.pool_key_id);
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER maintain_pool_state_from_position_updates
	AFTER DELETE ON position_updates
	FOR EACH ROW
	EXECUTE FUNCTION refresh_pool_state ();

CREATE TRIGGER maintain_pool_state_from_swaps
	AFTER DELETE ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION refresh_pool_state ();

CREATE TRIGGER maintain_pool_state_from_pool_initializations
	AFTER DELETE ON pool_initializations
	FOR EACH ROW
	EXECUTE FUNCTION refresh_pool_state ();

CREATE FUNCTION on_insert_pool_initialization()
RETURNS TRIGGER AS $$
BEGIN
    -- Insert state — pool must not already exist
    INSERT INTO pool_states (pool_key_id, sqrt_ratio, tick, liquidity, last_event_id, last_position_update_event_id)
    VALUES (NEW.pool_key_id, NEW.sqrt_ratio, NEW.tick, 0, NEW.event_id, NULL);

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_pool_init_state
	AFTER INSERT ON pool_initializations
	FOR EACH ROW
	EXECUTE FUNCTION on_insert_pool_initialization();

CREATE FUNCTION on_insert_swap()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE pool_states ps
    SET
        sqrt_ratio = NEW.sqrt_ratio_after,
        tick = NEW.tick_after,
        liquidity = NEW.liquidity_after,
        last_event_id = NEW.event_id
    WHERE
        ps.pool_key_id = NEW.pool_key_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_swap_state
	AFTER INSERT ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION on_insert_swap();

CREATE FUNCTION on_insert_position_update()
RETURNS TRIGGER AS $$
BEGIN
    -- update only if this is a newer event AND tick in position’s range
    UPDATE pool_states ps
    SET
        liquidity = (CASE WHEN ps.tick BETWEEN NEW.lower_bound AND NEW.upper_bound - 1
			THEN ps.liquidity + NEW.liquidity_delta
			ELSE ps.liquidity
			END),
        last_event_id = NEW.event_id,
        last_position_update_event_id = NEW.event_id
    WHERE
        ps.pool_key_id = NEW.pool_key_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER insert_position_update_state
	AFTER INSERT ON position_updates
	FOR EACH ROW
	EXECUTE FUNCTION on_insert_position_update();
