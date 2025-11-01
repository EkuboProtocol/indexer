CREATE TABLE hourly_volume_by_token (
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	hour timestamptz NOT NULL,
	token numeric NOT NULL,
	volume numeric NOT NULL,
	fees numeric NOT NULL,
	swap_count numeric NOT NULL,
	PRIMARY KEY (pool_key_id, hour, token)
);

CREATE TABLE hourly_price_data (
	chain_id int8 NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	hour timestamptz NOT NULL,
	k_volume numeric NOT NULL,
	total numeric NOT NULL,
	swap_count numeric NOT NULL,
	PRIMARY KEY (chain_id, token0, token1, hour)
);

CREATE TABLE hourly_price_block_totals (
	chain_id int8 NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	block_number int8 NOT NULL,
	hour timestamptz NOT NULL,
	total_delta0 numeric NOT NULL,
	total_delta1 numeric NOT NULL,
	swap_count numeric NOT NULL,
	PRIMARY KEY (chain_id, token0, token1, block_number)
);

CREATE TABLE hourly_tvl_delta_by_token (
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	hour timestamptz NOT NULL,
	token numeric NOT NULL,
	delta numeric NOT NULL,
	PRIMARY KEY (pool_key_id, hour, token)
);

CREATE TABLE hourly_revenue_by_token (
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	hour timestamptz NOT NULL,
	token numeric NOT NULL,
	revenue numeric NOT NULL,
	PRIMARY KEY (pool_key_id, hour, token)
);

CREATE OR REPLACE FUNCTION apply_hourly_volume_delta (p_pool_key_id bigint, p_hour timestamptz, p_token numeric, p_volume numeric, p_fees numeric, p_swap_count numeric, p_allow_insert boolean)
	RETURNS void
	AS $$
BEGIN
	IF p_volume = 0 AND p_fees = 0 AND p_swap_count = 0 THEN
		RETURN;
	END IF;
	UPDATE
		hourly_volume_by_token
	SET
		volume = volume + p_volume,
		fees = fees + p_fees,
		swap_count = swap_count + p_swap_count
	WHERE
		pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token;
	IF NOT FOUND THEN
		IF NOT p_allow_insert THEN
			RETURN;
		END IF;
		INSERT INTO hourly_volume_by_token (pool_key_id, hour, token, volume, fees, swap_count)
			VALUES (p_pool_key_id, p_hour, p_token, p_volume, p_fees, p_swap_count)
		ON CONFLICT (pool_key_id, hour, token)
			DO UPDATE SET
				volume = hourly_volume_by_token.volume + EXCLUDED.volume, fees = hourly_volume_by_token.fees + EXCLUDED.fees, swap_count = hourly_volume_by_token.swap_count + EXCLUDED.swap_count;
	END IF;
	DELETE FROM hourly_volume_by_token
	WHERE pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token
		AND volume = 0
		AND fees = 0
		AND swap_count = 0;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_volume_from_swap (p_chain_id bigint, p_event_id bigint, p_multiplier numeric)
	RETURNS void
	AS $$
DECLARE
	v_pool_key_id bigint;
	v_hour timestamptz;
	v_token numeric;
	v_volume numeric;
	v_fees numeric;
BEGIN
	SELECT
		s.pool_key_id,
		date_trunc('hour', b.time) AS hour,
		CASE WHEN s.delta0 >= 0 THEN
			pk.token0
		ELSE
			pk.token1
		END AS token,
		CASE WHEN s.delta0 >= 0 THEN
			s.delta0
		ELSE
			s.delta1
		END AS volume,
		floor((
			CASE WHEN s.delta0 >= 0 THEN
				s.delta0
			ELSE
				s.delta1
			END * pk.fee) / pk.fee_denominator) AS fees INTO v_pool_key_id,
		v_hour,
		v_token,
		v_volume,
		v_fees
	FROM
		swaps s
		JOIN blocks b ON b.chain_id = s.chain_id
			AND b.block_number = s.block_number
		JOIN pool_keys pk USING (pool_key_id)
	WHERE
		s.chain_id = p_chain_id
		AND s.event_id = p_event_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_volume := v_volume * p_multiplier;
	v_fees := v_fees * p_multiplier;
	PERFORM
		apply_hourly_volume_delta (v_pool_key_id, v_hour, v_token, v_volume, v_fees, p_multiplier, p_multiplier > 0);
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_volume_from_fees_accumulated (p_chain_id bigint, p_event_id bigint, p_multiplier numeric)
	RETURNS void
	AS $$
DECLARE
	v_pool_key_id bigint;
	v_hour timestamptz;
	v_token0 numeric;
	v_token1 numeric;
	v_fee0 numeric;
	v_fee1 numeric;
BEGIN
	SELECT
		fa.pool_key_id,
		date_trunc('hour', b.time) AS hour,
		pk.token0,
		pk.token1,
		GREATEST (fa.delta0, 0) AS fee0,
		GREATEST (fa.delta1, 0) AS fee1 INTO v_pool_key_id,
		v_hour,
		v_token0,
		v_token1,
		v_fee0,
		v_fee1
	FROM
		fees_accumulated fa
		JOIN blocks b ON b.chain_id = fa.chain_id
			AND b.block_number = fa.block_number
		JOIN pool_keys pk USING (pool_key_id)
	WHERE
		fa.chain_id = p_chain_id
		AND fa.event_id = p_event_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF v_fee0 <> 0 THEN
		PERFORM
			apply_hourly_volume_delta (v_pool_key_id, v_hour, v_token0, 0, v_fee0 * p_multiplier, 0, p_multiplier > 0);
	END IF;
	IF v_fee1 <> 0 THEN
		PERFORM
			apply_hourly_volume_delta (v_pool_key_id, v_hour, v_token1, 0, v_fee1 * p_multiplier, 0, p_multiplier > 0);
	END IF;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_price_delta (p_chain_id bigint, p_token0 numeric, p_token1 numeric, p_hour timestamptz, p_k_volume numeric, p_total numeric, p_swap_count numeric, p_allow_insert boolean)
	RETURNS void
	AS $$
BEGIN
	IF p_k_volume = 0 AND p_total = 0 AND p_swap_count = 0 THEN
		RETURN;
	END IF;
	UPDATE
		hourly_price_data
	SET
		k_volume = k_volume + p_k_volume,
		total = total + p_total,
		swap_count = swap_count + p_swap_count
	WHERE
		chain_id = p_chain_id
		AND token0 = p_token0
		AND token1 = p_token1
		AND hour = p_hour;
	IF NOT FOUND THEN
		IF NOT p_allow_insert THEN
			RETURN;
		END IF;
		INSERT INTO hourly_price_data (chain_id, token0, token1, hour, k_volume, total, swap_count)
			VALUES (p_chain_id, p_token0, p_token1, p_hour, p_k_volume, p_total, p_swap_count)
		ON CONFLICT (chain_id, token0, token1, hour)
			DO UPDATE SET
				k_volume = hourly_price_data.k_volume + EXCLUDED.k_volume, total = hourly_price_data.total + EXCLUDED.total, swap_count = hourly_price_data.swap_count + EXCLUDED.swap_count;
	END IF;
	DELETE FROM hourly_price_data
	WHERE chain_id = p_chain_id
		AND token0 = p_token0
		AND token1 = p_token1
		AND hour = p_hour
		AND k_volume = 0
		AND total = 0
		AND swap_count = 0;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_price_from_swap (p_chain_id bigint, p_event_id bigint, p_multiplier numeric)
	RETURNS void
	AS $$
DECLARE
	v_token0 numeric;
	v_token1 numeric;
	v_block_number int8;
	v_hour timestamptz;
	v_delta0 numeric;
	v_delta1 numeric;
	v_prev_total_delta0 numeric;
	v_prev_total_delta1 numeric;
	v_prev_swap_count numeric;
	v_new_total_delta0 numeric;
	v_new_total_delta1 numeric;
	v_new_swap_count numeric;
	v_prev_k_volume numeric;
	v_new_k_volume numeric;
	v_prev_total numeric;
	v_new_total numeric;
	v_prev_swap_contrib numeric;
	v_new_swap_contrib numeric;
	v_delta_k_volume numeric;
	v_delta_total numeric;
	v_delta_swap_count numeric;
BEGIN
	SELECT
		pk.token0,
		pk.token1,
		s.block_number,
		date_trunc('hour', b.time) AS hour,
		s.delta0,
		s.delta1 INTO v_token0,
		v_token1,
		v_block_number,
		v_hour,
		v_delta0,
		v_delta1
	FROM
		swaps s
		JOIN blocks b ON b.chain_id = s.chain_id
			AND b.block_number = s.block_number
		JOIN pool_keys pk USING (pool_key_id)
	WHERE
		s.chain_id = p_chain_id
		AND s.event_id = p_event_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	v_delta0 := v_delta0 * p_multiplier;
	v_delta1 := v_delta1 * p_multiplier;
	SELECT
		total_delta0,
		total_delta1,
		swap_count INTO v_prev_total_delta0,
		v_prev_total_delta1,
		v_prev_swap_count
	FROM
		hourly_price_block_totals
	WHERE
		chain_id = p_chain_id
		AND token0 = v_token0
		AND token1 = v_token1
		AND block_number = v_block_number;
	IF NOT FOUND THEN
		v_prev_total_delta0 := 0;
		v_prev_total_delta1 := 0;
		v_prev_swap_count := 0;
	END IF;
	v_new_total_delta0 := v_prev_total_delta0 + v_delta0;
	v_new_total_delta1 := v_prev_total_delta1 + v_delta1;
	v_new_swap_count := v_prev_swap_count + p_multiplier;
	IF v_new_total_delta0 = 0 AND v_new_total_delta1 = 0 AND v_new_swap_count = 0 THEN
		DELETE FROM hourly_price_block_totals
		WHERE chain_id = p_chain_id
			AND token0 = v_token0
			AND token1 = v_token1
			AND block_number = v_block_number;
	ELSE
		INSERT INTO hourly_price_block_totals (chain_id, token0, token1, block_number, hour, total_delta0, total_delta1, swap_count)
			VALUES (p_chain_id, v_token0, v_token1, v_block_number, v_hour, v_new_total_delta0, v_new_total_delta1, v_new_swap_count)
		ON CONFLICT (chain_id, token0, token1, block_number)
			DO UPDATE SET
				total_delta0 = EXCLUDED.total_delta0, total_delta1 = EXCLUDED.total_delta1, swap_count = EXCLUDED.swap_count, hour = EXCLUDED.hour;
	END IF;
	IF v_prev_total_delta0 <> 0 AND v_prev_total_delta1 <> 0 THEN
		v_prev_k_volume := abs(v_prev_total_delta0 * v_prev_total_delta1);
		v_prev_total := v_prev_total_delta1 * v_prev_total_delta1;
		v_prev_swap_contrib := v_prev_swap_count;
	ELSE
		v_prev_k_volume := 0;
		v_prev_total := 0;
		v_prev_swap_contrib := 0;
	END IF;
	IF v_new_total_delta0 <> 0 AND v_new_total_delta1 <> 0 THEN
		v_new_k_volume := abs(v_new_total_delta0 * v_new_total_delta1);
		v_new_total := v_new_total_delta1 * v_new_total_delta1;
		v_new_swap_contrib := v_new_swap_count;
	ELSE
		v_new_k_volume := 0;
		v_new_total := 0;
		v_new_swap_contrib := 0;
	END IF;
	v_delta_k_volume := v_new_k_volume - v_prev_k_volume;
	v_delta_total := v_new_total - v_prev_total;
	v_delta_swap_count := v_new_swap_contrib - v_prev_swap_contrib;
	PERFORM
		apply_hourly_price_delta (p_chain_id, v_token0, v_token1, v_hour, v_delta_k_volume, v_delta_total, v_delta_swap_count, (v_new_k_volume <> 0
				OR v_new_total <> 0
				OR v_new_swap_contrib <> 0));
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_tvl_delta (p_pool_key_id bigint, p_hour timestamptz, p_token numeric, p_delta numeric, p_allow_insert boolean)
	RETURNS void
	AS $$
BEGIN
	IF p_delta = 0 THEN
		RETURN;
	END IF;
	UPDATE
		hourly_tvl_delta_by_token
	SET
		delta = delta + p_delta
	WHERE
		pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token;
	IF NOT FOUND THEN
		IF NOT p_allow_insert THEN
			RETURN;
		END IF;
		INSERT INTO hourly_tvl_delta_by_token (pool_key_id, hour, token, delta)
			VALUES (p_pool_key_id, p_hour, p_token, p_delta)
		ON CONFLICT (pool_key_id, hour, token)
			DO UPDATE SET
				delta = hourly_tvl_delta_by_token.delta + EXCLUDED.delta;
	END IF;
	DELETE FROM hourly_tvl_delta_by_token
	WHERE pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token
		AND delta = 0;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_tvl_from_pool_balance_change (p_chain_id bigint, p_event_id bigint, p_multiplier numeric)
	RETURNS void
	AS $$
DECLARE
	v_pool_key_id bigint;
	v_hour timestamptz;
	v_token0 numeric;
	v_token1 numeric;
	v_delta0 numeric;
	v_delta1 numeric;
	v_liquidity_delta numeric;
	v_fee numeric;
	v_fee_denominator numeric;
BEGIN
	SELECT
		pbc.pool_key_id,
		date_trunc('hour', b.time) AS hour,
		pk.token0,
		pk.token1,
		pbc.delta0,
		pbc.delta1,
		pu.liquidity_delta,
		pk.fee,
		pk.fee_denominator INTO v_pool_key_id,
		v_hour,
		v_token0,
		v_token1,
		v_delta0,
		v_delta1,
		v_liquidity_delta,
		v_fee,
		v_fee_denominator
	FROM
		pool_balance_change pbc
		JOIN blocks b ON b.chain_id = pbc.chain_id
			AND b.block_number = pbc.block_number
		LEFT JOIN position_updates pu USING (chain_id, event_id)
		JOIN pool_keys pk USING (pool_key_id)
	WHERE
		pbc.chain_id = p_chain_id
		AND pbc.event_id = p_event_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF v_liquidity_delta IS NOT NULL AND v_liquidity_delta < 0 THEN
		v_delta0 := ceil((v_delta0 * v_fee_denominator) / (v_fee_denominator - v_fee));
		v_delta1 := ceil((v_delta1 * v_fee_denominator) / (v_fee_denominator - v_fee));
	END IF;
	v_delta0 := v_delta0 * p_multiplier;
	v_delta1 := v_delta1 * p_multiplier;
	PERFORM
		apply_hourly_tvl_delta (v_pool_key_id, v_hour, v_token0, v_delta0, p_multiplier > 0);
	PERFORM
		apply_hourly_tvl_delta (v_pool_key_id, v_hour, v_token1, v_delta1, p_multiplier > 0);
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_revenue_delta (p_pool_key_id bigint, p_hour timestamptz, p_token numeric, p_revenue numeric, p_allow_insert boolean)
	RETURNS void
	AS $$
BEGIN
	IF p_revenue = 0 THEN
		RETURN;
	END IF;
	UPDATE
		hourly_revenue_by_token
	SET
		revenue = revenue + p_revenue
	WHERE
		pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token;
	IF NOT FOUND THEN
		IF NOT p_allow_insert THEN
			RETURN;
		END IF;
		INSERT INTO hourly_revenue_by_token (pool_key_id, hour, token, revenue)
			VALUES (p_pool_key_id, p_hour, p_token, p_revenue)
		ON CONFLICT (pool_key_id, hour, token)
			DO UPDATE SET
				revenue = hourly_revenue_by_token.revenue + EXCLUDED.revenue;
	END IF;
	DELETE FROM hourly_revenue_by_token
	WHERE pool_key_id = p_pool_key_id
		AND hour = p_hour
		AND token = p_token
		AND revenue = 0;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION apply_hourly_revenue_from_position_update (p_chain_id bigint, p_event_id bigint, p_multiplier numeric)
	RETURNS void
	AS $$
DECLARE
	v_pool_key_id bigint;
	v_hour timestamptz;
	v_token0 numeric;
	v_token1 numeric;
	v_revenue0 numeric;
	v_revenue1 numeric;
BEGIN
	SELECT
		pu.pool_key_id,
		date_trunc('hour', b.time) AS hour,
		pk.token0,
		pk.token1,
		CASE WHEN pu.delta0 < 0
			AND pk.fee <> 0 THEN
			ceil((- pu.delta0 * pk.fee_denominator) / (pk.fee_denominator - pk.fee)) + pu.delta0
		ELSE
			0
		END AS revenue0,
		CASE WHEN pu.delta1 < 0
			AND pk.fee <> 0 THEN
			ceil((- pu.delta1 * pk.fee_denominator) / (pk.fee_denominator - pk.fee)) + pu.delta1
		ELSE
			0
		END AS revenue1 INTO v_pool_key_id,
		v_hour,
		v_token0,
		v_token1,
		v_revenue0,
		v_revenue1
	FROM
		position_updates pu
		JOIN blocks b ON b.chain_id = pu.chain_id
			AND b.block_number = pu.block_number
		JOIN pool_keys pk USING (pool_key_id)
	WHERE
		pu.chain_id = p_chain_id
		AND pu.event_id = p_event_id;
	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF v_revenue0 <> 0 THEN
		PERFORM
			apply_hourly_revenue_delta (v_pool_key_id, v_hour, v_token0, v_revenue0 * p_multiplier, p_multiplier > 0);
	END IF;
	IF v_revenue1 <> 0 THEN
		PERFORM
			apply_hourly_revenue_delta (v_pool_key_id, v_hour, v_token1, v_revenue1 * p_multiplier, p_multiplier > 0);
	END IF;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_hourly_metrics_from_swaps ()
	RETURNS TRIGGER
	AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM
			apply_hourly_volume_from_swap (NEW.chain_id, NEW.event_id, 1);
		PERFORM
			apply_hourly_price_from_swap (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM
			apply_hourly_volume_from_swap (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_price_from_swap (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_volume_from_swap (NEW.chain_id, NEW.event_id, 1);
		PERFORM
			apply_hourly_price_from_swap (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM
			apply_hourly_volume_from_swap (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_price_from_swap (OLD.chain_id, OLD.event_id, -1);
	END IF;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_hourly_volume_from_fees_accumulated ()
	RETURNS TRIGGER
	AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM
			apply_hourly_volume_from_fees_accumulated (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM
			apply_hourly_volume_from_fees_accumulated (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_volume_from_fees_accumulated (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM
			apply_hourly_volume_from_fees_accumulated (OLD.chain_id, OLD.event_id, -1);
	END IF;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ()
	RETURNS TRIGGER
	AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM
			apply_hourly_tvl_from_pool_balance_change (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM
			apply_hourly_tvl_from_pool_balance_change (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_tvl_from_pool_balance_change (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM
			apply_hourly_tvl_from_pool_balance_change (OLD.chain_id, OLD.event_id, -1);
	END IF;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_hourly_revenue_from_position_updates ()
	RETURNS TRIGGER
	AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM
			apply_hourly_revenue_from_position_update (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'UPDATE' THEN
		PERFORM
			apply_hourly_revenue_from_position_update (OLD.chain_id, OLD.event_id, -1);
		PERFORM
			apply_hourly_revenue_from_position_update (NEW.chain_id, NEW.event_id, 1);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM
			apply_hourly_revenue_from_position_update (OLD.chain_id, OLD.event_id, -1);
	END IF;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE TRIGGER maintain_hourly_metrics_from_swaps
	AFTER INSERT OR UPDATE OR DELETE ON swaps
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_metrics_from_swaps ();

CREATE TRIGGER maintain_hourly_volume_from_fees_accumulated
	AFTER INSERT OR UPDATE OR DELETE ON fees_accumulated
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_volume_from_fees_accumulated ();

CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_position_updates
	AFTER INSERT OR UPDATE OR DELETE ON position_updates DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ();

CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_position_fees_collected
	AFTER INSERT OR UPDATE OR DELETE ON position_fees_collected DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ();

CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_fees_accumulated
	AFTER INSERT OR UPDATE OR DELETE ON fees_accumulated DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ();

CREATE CONSTRAINT TRIGGER maintain_hourly_tvl_delta_from_swaps
	AFTER INSERT OR UPDATE OR DELETE ON swaps DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_tvl_delta_from_pool_balance_change ();

CREATE TRIGGER maintain_hourly_revenue_from_position_updates
	AFTER INSERT OR UPDATE OR DELETE ON position_updates
	FOR EACH ROW
	EXECUTE FUNCTION maintain_hourly_revenue_from_position_updates ();
