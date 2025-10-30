CREATE TABLE incentives_funded (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  owner NUMERIC NOT NULL,
  token NUMERIC NOT NULL,
  root NUMERIC NOT NULL,
  amount_next NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE TABLE incentives_refunded (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  owner NUMERIC NOT NULL,
  token NUMERIC NOT NULL,
  root NUMERIC NOT NULL,
  refund_amount NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE TABLE token_wrapper_deployed (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  token_wrapper NUMERIC NOT NULL,
  underlying_token NUMERIC NOT NULL,
  unlock_time NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);
CREATE SCHEMA IF NOT EXISTS incentives;
CREATE OR REPLACE FUNCTION incentives.percent_within_std(z DOUBLE PRECISION) RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE STRICT AS $$
SELECT (1.0 - erfc(ABS($1) / SQRT(2.0)));
$$;
-- Approximate inverse error function via Winitzki’s approximation + Newton-Raphson
CREATE OR REPLACE FUNCTION incentives.erfinv(y DOUBLE PRECISION) RETURNS DOUBLE PRECISION LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE a CONSTANT DOUBLE PRECISION := 0.147;
s INTEGER := CASE
  WHEN y < 0 THEN -1
  ELSE 1
END;
ln1y2 DOUBLE PRECISION := LN(1 - y * y);
term1 DOUBLE PRECISION := (2 / (PI() * a)) + (ln1y2 / 2);
x0 DOUBLE PRECISION := s * SQRT(SQRT(term1 * term1 - (ln1y2 / a)) - term1);
i INTEGER;
BEGIN -- refine with 3 Newton-Raphson steps
FOR i IN 1..3 LOOP x0 := x0 - (erf(x0) - y) / ((2 / SQRT(PI())) * EXP(- x0 * x0));
END LOOP;
RETURN x0;
END;
$$;
-- Requires erfinv(y) to be defined (e.g. as in the previous example).
-- Returns an array of z‐multiples [z₁, z₂, …] such that
-- P(|X| ≤ zₖ) = k * percent_step (capped at max_coverage).
CREATE OR REPLACE FUNCTION incentives.linear_percent_std_multiples(
    percent_step DOUBLE PRECISION,
    -- e.g. 0.03 for 3% increments
    max_coverage DOUBLE PRECISION -- e.g. 0.99 for 99% max
  ) RETURNS DOUBLE PRECISION [] LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE steps INTEGER := CEIL(max_coverage / percent_step);
out_arr DOUBLE PRECISION [] := ARRAY []::DOUBLE PRECISION [];
k INTEGER;
cov DOUBLE PRECISION;
BEGIN IF percent_step <= 0
OR max_coverage <= 0
OR max_coverage > 1 THEN RAISE EXCEPTION 'percent_step must be >0 and max_coverage in (0,1]';
END IF;
FOR k IN 1..steps LOOP cov := LEAST(k * percent_step, max_coverage);
out_arr := out_arr || (SQRT(2) * incentives.erfinv(cov));
EXIT
WHEN cov >= max_coverage;
END LOOP;
RETURN out_arr;
END;
$$;
DO $$ BEGIN CREATE TYPE incentives.locker_salt_pair AS (locker NUMERIC, salt NUMERIC);
EXCEPTION
WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS incentives.campaigns (
  id SERIAL8 NOT NULL,
  -- when the campaign rewards are expected to start accumulating
  start_time timestamptz NOT NULL,
  -- when campaign will end, if it is known
  end_time timestamptz,
  -- the name of the campaign
  name TEXT NOT NULL,
  slug VARCHAR(20) NOT NULL,
  -- the token that is being used for rewards
  reward_token NUMERIC NOT NULL,
  -- the extensions that can be incentivized
  allowed_extensions NUMERIC [] DEFAULT '{0}' NOT NULL,
  -- the default percent step for the campaign
  default_percent_step DOUBLE PRECISION NOT NULL DEFAULT 0.025,
  -- the default max coverage for the campaign
  default_max_coverage DOUBLE PRECISION NOT NULL DEFAULT 0.9975,
  -- the default max coverage for the campaign
  default_fee_denominator NUMERIC NOT NULL,
  -- locker,salt combos that are excluded from computations
  excluded_locker_salts incentives.locker_salt_pair [] DEFAULT '{}' NOT NULL,
  -- how often drops are created for the campaign
  distribution_cadence INTERVAL NOT NULL DEFAULT '1 week',
  -- the minimum amount of tokens that must be earned in the distribution cadence to receive an allocation
  minimum_allocation NUMERIC NOT NULL DEFAULT 0::numeric,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incentive_campaigns_slug ON incentives.campaigns (slug);
-- specific dates on which rewards are provided to pairs
CREATE TABLE IF NOT EXISTS incentives.campaign_reward_periods (
  campaign_id INT REFERENCES incentives.campaigns (id) ON DELETE CASCADE,
  id SERIAL8,
  -- token pair being incentivized
  token0 NUMERIC NOT NULL,
  token1 NUMERIC NOT NULL,
  -- the start of the rewards period
  start_time timestamptz NOT NULL,
  -- the end of the rewards period
  end_time timestamptz NOT NULL,
  -- the realized volatility to use for computing rewards
  realized_volatility float8 NOT NULL,
  -- the amount that is being distributed for the period
  token0_reward_amount NUMERIC NOT NULL,
  token1_reward_amount NUMERIC NOT NULL,
  -- when the rewards were last computed for this period, or null if they haven't been computed yet
  rewards_last_computed_at timestamptz,
  -- parameters for the generation of the stddev table
  percent_step DOUBLE PRECISION,
  max_coverage DOUBLE PRECISION,
  fee_denominator NUMERIC,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_reward_periods_pair_period ON incentives.campaign_reward_periods (
  campaign_id,
  token0,
  token1,
  start_time,
  end_time
);
CREATE TABLE IF NOT EXISTS incentives.computed_rewards (
  campaign_reward_period_id int8 NOT NULL REFERENCES incentives.campaign_reward_periods (id),
  locker NUMERIC NOT NULL,
  salt NUMERIC NOT NULL,
  reward_amount NUMERIC NOT NULL,
  PRIMARY KEY (campaign_reward_period_id, locker, salt)
);
CREATE INDEX IF NOT EXISTS idx_computed_rewards_salt ON incentives.computed_rewards (salt);
CREATE INDEX IF NOT EXISTS idx_computed_rewards_locker_salt ON incentives.computed_rewards (locker, salt);
CREATE TABLE IF NOT EXISTS incentives.generated_drop (
  id SERIAL8 PRIMARY KEY,
  root NUMERIC NOT NULL,
  generated_at timestamptz DEFAULT CURRENT_TIMESTAMP
);
-- the periods that were included in the generated merkle root
CREATE TABLE IF NOT EXISTS incentives.generated_drop_reward_periods (
  drop_id int8 NOT NULL REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,
  -- this should not cascade, because it means the source of the data is being deleted
  campaign_reward_period_id int8 NOT NULL REFERENCES incentives.campaign_reward_periods (id),
  PRIMARY KEY (drop_id, campaign_reward_period_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_drop_reward_periods_crp_id ON incentives.generated_drop_reward_periods (campaign_reward_period_id);
CREATE TABLE IF NOT EXISTS incentives.generated_drop_proof (
  drop_id INT REFERENCES incentives.generated_drop (id) ON DELETE CASCADE,
  id INT NOT NULL,
  address NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  proof NUMERIC [] NOT NULL,
  PRIMARY KEY (drop_id, id)
);
-- meant to be manually populated
CREATE TABLE IF NOT EXISTS incentives.deployed_airdrop_contracts (
  address NUMERIC NOT NULL PRIMARY KEY,
  token NUMERIC NOT NULL,
  drop_id INT REFERENCES incentives.generated_drop (id) ON DELETE CASCADE
);
-- this prevents us from deploying the same drop multiple times
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployed_airdrop_contracts_drop_id ON incentives.deployed_airdrop_contracts (drop_id);
-- 1. Redefine token_pair to include per-pair budget & realized_volatility
DROP TYPE IF EXISTS incentives.token_pair_budget CASCADE;
CREATE TYPE incentives.token_pair_budget AS (
  token0 NUMERIC,
  token1 NUMERIC,
  budget NUMERIC,
  realized_volatility DOUBLE PRECISION
);
-- 2. Function creates campaign + allowed extensions + reward periods
CREATE OR REPLACE FUNCTION incentives.create_campaign(
    p_name TEXT,
    p_slug VARCHAR(20),
    p_start_time timestamptz,
    p_end_time timestamptz,
    p_interval INTERVAL,
    p_reward_token NUMERIC,
    p_pairs incentives.token_pair_budget [],
    p_default_fee_denominator NUMERIC,
    p_allowed_extensions NUMERIC [] DEFAULT '{0}',
    p_excluded_locker_salts incentives.locker_salt_pair [] DEFAULT '{}',
    p_percent_step DOUBLE PRECISION DEFAULT NULL,
    p_max_coverage DOUBLE PRECISION DEFAULT NULL
  ) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_campaign_id BIGINT;
v_total_budget NUMERIC := 0;
v_periods INTEGER;
v_pair incentives.token_pair_budget;
v_per_period NUMERIC;
v_start timestamptz;
v_end timestamptz;
BEGIN -- sum all pair-budgets
FOREACH v_pair IN ARRAY p_pairs LOOP v_total_budget := v_total_budget + v_pair.budget;
END LOOP;
-- insert campaign
INSERT INTO incentives.campaigns (
    name,
    slug,
    start_time,
    end_time,
    reward_token,
    allowed_extensions,
    excluded_locker_salts,
    default_fee_denominator
  )
VALUES (
    p_name,
    p_slug,
    p_start_time,
    p_end_time,
    p_reward_token,
    p_allowed_extensions,
    p_excluded_locker_salts,
    p_default_fee_denominator
  )
RETURNING id INTO v_campaign_id;
-- compute number of full intervals
v_periods := CEIL(
  EXTRACT(
    EPOCH
    FROM (p_end_time - p_start_time)
  ) / EXTRACT(
    EPOCH
    FROM p_interval
  )
)::INT;
-- for each pair, split its budget evenly over intervals & tokens
FOREACH v_pair IN ARRAY p_pairs LOOP v_per_period := v_pair.budget / v_periods;
v_start := p_start_time;
FOR _ IN 1..v_periods LOOP v_end := LEAST(v_start + p_interval, p_end_time);
INSERT INTO incentives.campaign_reward_periods (
    campaign_id,
    token0,
    token1,
    start_time,
    end_time,
    realized_volatility,
    token0_reward_amount,
    token1_reward_amount,
    percent_step,
    max_coverage
  )
VALUES (
    v_campaign_id,
    v_pair.token0,
    v_pair.token1,
    v_start,
    v_end,
    v_pair.realized_volatility,
    FLOOR(v_per_period / 2),
    FLOOR(v_per_period / 2),
    p_percent_step,
    p_max_coverage
  );
v_start := v_start + p_interval;
END LOOP;
END LOOP;
RETURN v_campaign_id;
END;
$$;