CREATE TABLE incentives_funded (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	owner NUMERIC NOT NULL,
	token numeric NOT NULL,
	root numeric NOT NULL,
	amount_next numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE incentives_refunded (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	owner NUMERIC NOT NULL,
	token numeric NOT NULL,
	root numeric NOT NULL,
	refund_amount numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE token_wrapper_deployed (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	token_wrapper numeric NOT NULL,
	underlying_token numeric NOT NULL,
	unlock_time numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE SCHEMA incentives;

CREATE OR REPLACE FUNCTION incentives.percent_within_std (z double precision)
	RETURNS double precision
	LANGUAGE sql
	IMMUTABLE STRICT
	AS $$
	SELECT
		(1.0 - erfc (abs($1) / sqrt(2.0)));

$$;

-- Approximate inverse error function via Winitzki’s approximation + Newton-Raphson
CREATE OR REPLACE FUNCTION incentives.erfinv (y double precision)
	RETURNS double precision
	LANGUAGE plpgsql
	IMMUTABLE STRICT
	AS $$
DECLARE
	a CONSTANT double precision := 0.147;
	s integer := CASE WHEN y < 0 THEN
		-1
	ELSE
		1
	END;
	ln1y2 double precision := ln(1 - y * y);
	term1 double precision := (2 / (pi() * a)) + (ln1y2 / 2);
	x0 double precision := s * sqrt(sqrt(term1 * term1 - (ln1y2 / a)) - term1);
	i integer;
BEGIN
	-- refine with 3 Newton-Raphson steps
	FOR i IN 1..3 LOOP
		x0 := x0 - (erf (x0) - y) / ((2 / sqrt(pi())) * exp(- x0 * x0));
	END LOOP;
	RETURN x0;
END;
$$;

-- Requires erfinv(y) to be defined (e.g. as in the previous example).
-- Returns an array of z‐multiples [z₁, z₂, …] such that
-- P(|X| ≤ zₖ) = k * percent_step (capped at max_coverage).
CREATE OR REPLACE FUNCTION incentives.linear_percent_std_multiples (percent_step double precision,
-- e.g. 0.03 for 3% increments
max_coverage double precision -- e.g. 0.99 for 99% max
)
	RETURNS double precision[]
	LANGUAGE plpgsql
	IMMUTABLE STRICT
	AS $$
DECLARE
	steps integer := ceil(max_coverage / percent_step);
	out_arr double precision[] := ARRAY[]::double precision[];
	k integer;
	cov double precision;
BEGIN
	IF percent_step <= 0 OR max_coverage <= 0 OR max_coverage > 1 THEN
		RAISE EXCEPTION 'percent_step must be >0 and max_coverage in (0,1]';
	END IF;
	FOR k IN 1..steps LOOP
		cov := LEAST (k * percent_step, max_coverage);
		out_arr := out_arr || (sqrt(2) * incentives.erfinv (cov));
		EXIT
		WHEN cov >= max_coverage;
	END LOOP;
	RETURN out_arr;
END;
$$;

DO $$
BEGIN
	CREATE TYPE incentives.locker_salt_pair AS (
		locker numeric,
		salt numeric
);
EXCEPTION
	WHEN duplicate_object THEN
		NULL;
END
$$;

CREATE TABLE incentives.campaigns (
	id SERIAL8 NOT NULL,
	-- the chain on which the campaign lives
	chain_id int8 NOT NULL,
	-- when the campaign rewards are expected to start accumulating
	start_time timestamptz NOT NULL,
	-- when campaign will end, if it is known
	end_time timestamptz,
	-- the name of the campaign
	name text NOT NULL,
	slug varchar(20) NOT NULL,
	-- the token that is being used for rewards
	reward_token numeric NOT NULL,
	-- the extensions that can be incentivized
	allowed_extensions numeric[] DEFAULT '{0}' NOT NULL,
	-- the default percent step for the campaign
	default_percent_step double precision NOT NULL DEFAULT 0.025,
	-- the default max coverage for the campaign
	default_max_coverage double precision NOT NULL DEFAULT 0.9975,
	-- the default max coverage for the campaign
	default_fee_denominator numeric NOT NULL,
	-- locker,salt combos that are excluded from computations
	excluded_locker_salts incentives.locker_salt_pair[] DEFAULT '{}' NOT NULL,
	-- how often drops are created for the campaign
	distribution_cadence interval NOT NULL DEFAULT '1 week',
	-- the minimum amount of tokens that must be earned in the distribution cadence to receive an allocation
	minimum_allocation numeric NOT NULL DEFAULT 0::numeric,
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_incentive_campaigns_slug ON incentives.campaigns (slug);

-- specific dates on which rewards are provided to pairs
CREATE TABLE incentives.campaign_reward_periods (
	campaign_id int REFERENCES incentives.campaigns (id) ON DELETE CASCADE,
	id SERIAL8,
	-- token pair being incentivized
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	-- the start of the rewards period
	start_time timestamptz NOT NULL,
	-- the end of the rewards period
	end_time timestamptz NOT NULL,
	-- the realized volatility to use for computing rewards
	realized_volatility float8 NOT NULL,
	-- the amount that is being distributed for the period
	token0_reward_amount numeric NOT NULL,
	token1_reward_amount numeric NOT NULL,
	-- when the rewards were last computed for this period, or null if they haven't been computed yet
	rewards_last_computed_at timestamptz,
	-- parameters for the generation of the stddev table
	percent_step double precision,
	max_coverage double precision,
	fee_denominator numeric,
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_campaign_reward_periods_pair_period ON incentives.campaign_reward_periods (campaign_id, token0, token1, start_time, end_time);

CREATE TABLE incentives.computed_rewards (
	campaign_reward_period_id int8 NOT NULL REFERENCES incentives.campaign_reward_periods (id),
	locker numeric NOT NULL,
	salt numeric NOT NULL,
	reward_amount numeric NOT NULL,
	PRIMARY KEY (campaign_reward_period_id, locker, salt)
);

CREATE INDEX idx_computed_rewards_salt ON incentives.computed_rewards (salt);

CREATE INDEX idx_computed_rewards_locker_salt ON incentives.computed_rewards (locker, salt);

CREATE TABLE incentives.generated_drop (
	id SERIAL8 PRIMARY KEY,
	root numeric NOT NULL,
	generated_at timestamptz DEFAULT CURRENT_TIMESTAMP
);

-- the periods that were included in the generated merkle root
CREATE TABLE incentives.generated_drop_reward_periods (
	drop_id int8 NOT NULL REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,
	-- this should not cascade, because it means the source of the data is being deleted
	campaign_reward_period_id int8 NOT NULL REFERENCES incentives.campaign_reward_periods (id),
	PRIMARY KEY (drop_id, campaign_reward_period_id)
);

CREATE UNIQUE INDEX idx_generated_drop_reward_periods_crp_id ON incentives.generated_drop_reward_periods (campaign_reward_period_id);

CREATE TABLE incentives.generated_drop_proof (
	drop_id int REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,
	id int NOT NULL,
	address numeric NOT NULL,
	amount numeric NOT NULL,
	proof numeric[] NOT NULL,
	PRIMARY KEY (drop_id, id)
);

-- meant to be manually populated
CREATE TABLE incentives.deployed_airdrop_contracts (
	address numeric NOT NULL PRIMARY KEY,
	token numeric NOT NULL,
	drop_id int REFERENCES incentives.generated_drop (id) ON DELETE CASCADE
);

-- this prevents us from deploying the same drop multiple times
CREATE UNIQUE INDEX idx_deployed_airdrop_contracts_drop_id ON incentives.deployed_airdrop_contracts (drop_id);

-- 1. Redefine token_pair to include per-pair budget & realized_volatility
DROP TYPE IF EXISTS incentives.token_pair_budget CASCADE;

CREATE TYPE incentives.token_pair_budget AS (
	token0 numeric,
	token1 numeric,
	budget numeric,
	realized_volatility double precision
);

-- 2. Function creates campaign + allowed extensions + reward periods
CREATE OR REPLACE FUNCTION incentives.create_campaign (p_chain_id int8, p_name text, p_slug varchar(20), p_start_time timestamptz, p_end_time timestamptz, p_interval interval, p_reward_token numeric, p_pairs incentives.token_pair_budget[], p_default_fee_denominator numeric, p_allowed_extensions numeric[] DEFAULT '{0}', p_excluded_locker_salts incentives.locker_salt_pair[] DEFAULT '{}', p_percent_step double precision DEFAULT NULL, p_max_coverage double precision DEFAULT NULL)
	RETURNS bigint
	LANGUAGE plpgsql
	AS $$
DECLARE
	v_campaign_id bigint;
	v_total_budget numeric := 0;
	v_periods integer;
	v_pair incentives.token_pair_budget;
	v_per_period numeric;
	v_start timestamptz;
	v_end timestamptz;
BEGIN
	-- sum all pair-budgets
	FOREACH v_pair IN ARRAY p_pairs LOOP
		v_total_budget := v_total_budget + v_pair.budget;
	END LOOP;
	-- insert campaign
	INSERT INTO incentives.campaigns (chain_id, name, slug, start_time, end_time, reward_token, allowed_extensions, excluded_locker_salts, default_fee_denominator)
		VALUES (p_chain_id, p_name, p_slug, p_start_time, p_end_time, p_reward_token, p_allowed_extensions, p_excluded_locker_salts, p_default_fee_denominator)
	RETURNING
		id INTO v_campaign_id;
	-- compute number of full intervals
	v_periods := ceil(extract(EPOCH FROM (p_end_time - p_start_time)) / extract(EPOCH FROM p_interval))::int;
	-- for each pair, split its budget evenly over intervals & tokens
	FOREACH v_pair IN ARRAY p_pairs LOOP
		v_per_period := v_pair.budget / v_periods;
		v_start := p_start_time;
		FOR _ IN 1..v_periods LOOP
			v_end := LEAST (v_start + p_interval, p_end_time);
			INSERT INTO incentives.campaign_reward_periods (campaign_id, token0, token1, start_time, end_time, realized_volatility, token0_reward_amount, token1_reward_amount, percent_step, max_coverage)
				VALUES (v_campaign_id, v_pair.token0, v_pair.token1, v_start, v_end, v_pair.realized_volatility, floor(v_per_period / 2), floor(v_per_period / 2), p_percent_step, p_max_coverage);
			v_start := v_start + p_interval;
		END LOOP;
	END LOOP;
	RETURN v_campaign_id;
END;
$$;
