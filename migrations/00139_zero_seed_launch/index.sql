-- DRAFT for the EKU-1513 contract freeze packet. Not a PR, not deployed.
-- Schema version: zero-seed-launch-index/v1
-- Source ABI: EkuboProtocol/evm-contracts 39ca1918e4d16b1c9fd4db5ed70761ef7b12c6ae
--             (tree b95e7484), ZeroSeedLaunch.abi.json sha256 28d05c07...f23d.
--
-- Replaces the unshipped draft 00134_scheduled_launch_pool_states of
-- indexer PR #246 (ScheduledLaunch, LockedLaunchLiquidity, LaunchRouter).
-- That migration never ran in production (origin/main stops at 00133), so this
-- is a replacement of a development format, not a data migration. Nothing of
-- the staged/advance/migrate/terminal/seed design survives here.
--
--   zero_seed_launch_pool_keys      pools whose extension is the configured
--                                   ZeroSeedLaunch, filled at PoolInitialized
--   zero_seed_launch_created        ZeroSeedLaunch.LaunchCreated
--   zero_seed_launch_swapped        ZeroSeedLaunch.LaunchSwapped
--   zero_seed_launch_fees_claimed   ZeroSeedLaunch.CreatorFeesClaimed
--   zero_seed_launch_states         one row per launch: immutable config,
--                                   immutable principal (liquidity, supply)
--                                   and the creator fee ledger
--
-- Principal and fees are separate ledgers by construction:
--   * Principal is the single position (salt 0, tick_lower, tick_upper) with
--     constant liquidity. Its current token/quote composition follows the Core
--     pool price (pool_states, swaps, pool_balance_change), which never include
--     the creator fee.
--   * The creator fee ledger is saved by the extension under salt = pool id.
--     accrued{0,1} sums LaunchSwapped.fee_amount by side, claimed{0,1} sums
--     CreatorFeesClaimed. Balance = accrued - claimed. It never includes
--     principal.
--
-- The fee phase is derived from a block timestamp and the immutable schedule;
-- nothing is stored for it, and there is no completed/migrated state.
--
-- Reorgs: every event table cascades from blocks. Ledger columns are maintained
-- by AFTER INSERT/DELETE row triggers that add or subtract exactly the row's
-- amounts, so deleting blocks >= n and replaying them restores the same state.
-- Writers insert with ON CONFLICT (chain_id, event_id) DO NOTHING so a
-- redelivered log fires no trigger. recompute_zero_seed_launch_state is the
-- exact repair function.
--
-- No column stores a transaction sender. LaunchSwapped.locker is the contract
-- that forwarded the swap (normally a router); it is not a user.
--
-- Rollback before issuance: in one transaction that locks blocks first,
-- DROP VIEW all_pool_states_view and recreate it from 00123; restore
-- recompute_pool_last_event_id from 00123; DROP the zero_seed_launch_* tables
-- and functions. This returns to the 00133 schema, never to the #246 draft.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE zero_seed_launch_pool_keys
(
    pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE TABLE zero_seed_launch_created
(
    chain_id             int8    NOT NULL,
    block_number         int8    NOT NULL,
    transaction_index    int4    NOT NULL,
    event_index          int4    NOT NULL,
    transaction_hash     NUMERIC NOT NULL,
    emitter              NUMERIC NOT NULL,
    event_id             int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id          int8 REFERENCES pool_keys (pool_key_id),
    pool_id              NUMERIC NOT NULL,
    token                NUMERIC NOT NULL,
    -- msg.sender of create; the only account that may claim fees; not transferable
    creator              NUMERIC NOT NULL,
    quote_token          NUMERIC NOT NULL,
    position_id          NUMERIC NOT NULL,
    -- installed principal, immutable
    liquidity            NUMERIC NOT NULL,
    supply               NUMERIC NOT NULL,
    -- NUL characters are stripped; Postgres text cannot hold them
    name                 TEXT    NOT NULL,
    symbol               TEXT    NOT NULL,
    decimals             int2    NOT NULL,
    -- economic ticks: log1.000001 of raw quote per raw launch token
    ask_tick             int4    NOT NULL,
    upper_tick           int4    NOT NULL,
    tick_spacing         int8    NOT NULL,
    -- unix seconds
    trading_start        int8    NOT NULL,
    fee_duration         int8    NOT NULL,
    -- Q0.64 fractions (2^64 = 100%)
    initial_fee          NUMERIC NOT NULL,
    final_fee            NUMERIC NOT NULL,
    salt                 NUMERIC NOT NULL,
    token_is_token1      bool GENERATED ALWAYS AS (token > quote_token) STORED,
    -- pool-tick bounds of the position
    tick_lower           int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -upper_tick ELSE ask_tick END) STORED,
    tick_upper           int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -ask_tick ELSE upper_tick END) STORED,
    fee_end              int8 GENERATED ALWAYS AS (trading_start + fee_duration) STORED,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_created (chain_id, block_number);
CREATE UNIQUE INDEX ON zero_seed_launch_created (pool_key_id);
CREATE INDEX ON zero_seed_launch_created (chain_id, token);
CREATE INDEX ON zero_seed_launch_created (chain_id, creator, event_id DESC);

CREATE TABLE zero_seed_launch_swapped
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    -- the contract that forwarded the swap, normally a router; never a user
    locker            NUMERIC NOT NULL,
    -- fee-inclusive pool-perspective deltas settled by the locker
    delta0            NUMERIC NOT NULL,
    delta1            NUMERIC NOT NULL,
    -- Q0.64 creator fee rate applied at the block timestamp
    fee_rate          NUMERIC NOT NULL,
    fee_amount        NUMERIC NOT NULL,
    fee_is_token1     bool    NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_swapped (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_swapped (pool_key_id, event_id DESC);

CREATE TABLE zero_seed_launch_fees_claimed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    creator           NUMERIC NOT NULL,
    recipient         NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_fees_claimed (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_fees_claimed (pool_key_id, event_id DESC);

DO
$$
    DECLARE
        event_table TEXT;
    BEGIN
        FOREACH event_table IN ARRAY ARRAY [
            'zero_seed_launch_created',
            'zero_seed_launch_swapped',
            'zero_seed_launch_fees_claimed'
            ]
            LOOP
                EXECUTE FORMAT(
                        'CREATE TRIGGER %I BEFORE UPDATE ON %I '
                            || 'FOR EACH ROW EXECUTE FUNCTION block_updates()',
                        'no_updates_' || event_table,
                        event_table
                        );
            END LOOP;
    END;
$$;

CREATE TABLE zero_seed_launch_states
(
    pool_key_id      int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    created_event_id int8    NOT NULL,
    -- creator fee ledger, raw units of token0/token1
    accrued0         NUMERIC NOT NULL DEFAULT 0,
    accrued1         NUMERIC NOT NULL DEFAULT 0,
    claimed0         NUMERIC NOT NULL DEFAULT 0,
    claimed1         NUMERIC NOT NULL DEFAULT 0,
    swap_count       int8    NOT NULL DEFAULT 0,
    claim_count      int8    NOT NULL DEFAULT 0,
    -- claimed <= accrued holds between transactions but not mid-cascade (a
    -- reorg may delete a swap before the claim that followed it), so it is
    -- asserted by tests and the repair check, not a CHECK constraint
    last_event_id    int8    NOT NULL
) WITH (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

-- Exact recompute from the event tables; also the repair tool.
CREATE FUNCTION recompute_zero_seed_launch_state(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql AS
$$
DECLARE
    c_event_id int8;
BEGIN
    SELECT event_id INTO c_event_id FROM zero_seed_launch_created WHERE pool_key_id = p_pool_key_id;
    IF c_event_id IS NULL THEN
        DELETE FROM zero_seed_launch_states WHERE pool_key_id = p_pool_key_id;
        RETURN;
    END IF;

    INSERT INTO zero_seed_launch_states AS s
    (pool_key_id, created_event_id, accrued0, accrued1, claimed0, claimed1, swap_count, claim_count, last_event_id)
    SELECT p_pool_key_id,
           c_event_id,
           COALESCE(sw.a0, 0), COALESCE(sw.a1, 0),
           COALESCE(cl.c0, 0), COALESCE(cl.c1, 0),
           COALESCE(sw.n, 0), COALESCE(cl.n, 0),
           GREATEST(c_event_id, sw.last, cl.last)
    FROM (SELECT SUM(fee_amount) FILTER (WHERE NOT fee_is_token1) AS a0,
                 SUM(fee_amount) FILTER (WHERE fee_is_token1)     AS a1,
                 COUNT(*) AS n, MAX(event_id) AS last
          FROM zero_seed_launch_swapped WHERE pool_key_id = p_pool_key_id) sw,
         (SELECT SUM(amount0) AS c0, SUM(amount1) AS c1, COUNT(*) AS n, MAX(event_id) AS last
          FROM zero_seed_launch_fees_claimed WHERE pool_key_id = p_pool_key_id) cl
    ON CONFLICT (pool_key_id) DO UPDATE
        SET created_event_id = EXCLUDED.created_event_id,
            accrued0 = EXCLUDED.accrued0, accrued1 = EXCLUDED.accrued1,
            claimed0 = EXCLUDED.claimed0, claimed1 = EXCLUDED.claimed1,
            swap_count = EXCLUDED.swap_count, claim_count = EXCLUDED.claim_count,
            last_event_id = EXCLUDED.last_event_id;
END
$$;

CREATE FUNCTION trg_zero_seed_launch_created_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
BEGIN
    PERFORM recompute_zero_seed_launch_state(
            CASE WHEN TG_OP = 'DELETE' THEN OLD.pool_key_id ELSE NEW.pool_key_id END);
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_zero_seed_launch_created_state
    AFTER INSERT OR DELETE
    ON zero_seed_launch_created
    FOR EACH ROW
EXECUTE FUNCTION trg_zero_seed_launch_created_state();

-- Incremental, O(1) per row. A swap or claim must follow its LaunchCreated
-- (same pool); one without a state row is a decoder bug and is refused.
CREATE FUNCTION trg_zero_seed_launch_ledger()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
DECLARE
    r    RECORD;
    sgn  int := CASE WHEN TG_OP = 'DELETE' THEN -1 ELSE 1 END;
    d0   NUMERIC := 0;
    d1   NUMERIC := 0;
    c0   NUMERIC := 0;
    c1   NUMERIC := 0;
    dsw  int8 := 0;
    dcl  int8 := 0;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF TG_TABLE_NAME = 'zero_seed_launch_swapped' THEN
        IF r.fee_is_token1 THEN d1 := r.fee_amount; ELSE d0 := r.fee_amount; END IF;
        dsw := 1;
    ELSE
        c0 := r.amount0;
        c1 := r.amount1;
        dcl := 1;
    END IF;

    UPDATE zero_seed_launch_states
    SET accrued0    = accrued0 + sgn * d0,
        accrued1    = accrued1 + sgn * d1,
        claimed0    = claimed0 + sgn * c0,
        claimed1    = claimed1 + sgn * c1,
        swap_count  = swap_count + sgn * dsw,
        claim_count = claim_count + sgn * dcl,
        last_event_id = CASE
                            WHEN TG_OP = 'INSERT' THEN GREATEST(last_event_id, r.event_id)
                            ELSE last_event_id END
    WHERE pool_key_id = r.pool_key_id;

    IF NOT FOUND THEN
        -- DELETE of a child after its LaunchCreated was already cascaded away is fine
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'zero-seed launch event for pool_key_id % without LaunchCreated', r.pool_key_id;
        END IF;
        RETURN NULL;
    END IF;

    -- a delete can lower the last event id; recompute that one field exactly
    IF TG_OP = 'DELETE' AND r.event_id >= (SELECT last_event_id FROM zero_seed_launch_states WHERE pool_key_id = r.pool_key_id) THEN
        UPDATE zero_seed_launch_states s
        SET last_event_id = GREATEST(s.created_event_id,
                                     (SELECT MAX(event_id) FROM zero_seed_launch_swapped WHERE pool_key_id = r.pool_key_id),
                                     (SELECT MAX(event_id) FROM zero_seed_launch_fees_claimed WHERE pool_key_id = r.pool_key_id))
        WHERE s.pool_key_id = r.pool_key_id;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_zero_seed_launch_swapped_ledger
    AFTER INSERT OR DELETE
    ON zero_seed_launch_swapped
    FOR EACH ROW
EXECUTE FUNCTION trg_zero_seed_launch_ledger();

CREATE TRIGGER trg_zero_seed_launch_fees_claimed_ledger
    AFTER INSERT OR DELETE
    ON zero_seed_launch_fees_claimed
    FOR EACH ROW
EXECUTE FUNCTION trg_zero_seed_launch_ledger();

-- The fee in effect at p_time (unix seconds), as feeAt in the contract.
CREATE FUNCTION zero_seed_launch_fee_at(p_trading_start int8, p_fee_duration int8, p_initial NUMERIC,
                                        p_final NUMERIC, p_time int8)
    RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE PARALLEL SAFE AS
$$
SELECT CASE
           WHEN p_time <= p_trading_start THEN p_initial
           WHEN p_time >= p_trading_start + p_fee_duration THEN p_final
           -- DIV is exact integer division; '/' on NUMERIC rounds to a finite scale first
           ELSE p_initial - DIV((p_initial - p_final) * (p_time - p_trading_start), p_fee_duration)
           END
$$;

-- Fee phase at p_time. A schedule label only; trading and the pool are unchanged.
CREATE FUNCTION zero_seed_launch_fee_phase(p_trading_start int8, p_fee_duration int8, p_time int8)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE PARALLEL SAFE AS
$$
SELECT CASE
           WHEN p_time < p_trading_start THEN 'before_trading_start'
           WHEN p_time < p_trading_start + p_fee_duration THEN 'fee_decay'
           ELSE 'final_fee'
           END
$$;

-- pool_last_event_id: the 00123 recompute plus the launch state table.
CREATE OR REPLACE FUNCTION recompute_pool_last_event_id(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql
AS
$$
BEGIN
    INSERT INTO pool_last_event_id (pool_key_id, chain_id, core_address, last_event_id)
    SELECT pk.pool_key_id,
           pk.chain_id,
           pk.core_address,
           GREATEST(ps.last_event_id, tps.last_event_id, bps.last_event_id, lops.last_event_id,
                    vps.last_event_id, zsls.created_event_id)
    FROM pool_keys pk
             JOIN pool_states ps USING (pool_key_id)
             LEFT JOIN twamm_pool_states tps ON tps.pool_key_id = pk.pool_key_id
             LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
             LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
             LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
             LEFT JOIN zero_seed_launch_states zsls ON zsls.pool_key_id = pk.pool_key_id
    WHERE pk.pool_key_id = p_pool_key_id
    ON CONFLICT (pool_key_id) DO UPDATE
        SET last_event_id = EXCLUDED.last_event_id,
            chain_id      = EXCLUDED.chain_id,
            core_address  = EXCLUDED.core_address
        WHERE (pool_last_event_id.last_event_id, pool_last_event_id.chain_id, pool_last_event_id.core_address)
                  IS DISTINCT FROM (EXCLUDED.last_event_id, EXCLUDED.chain_id, EXCLUDED.core_address);

    DELETE
    FROM pool_last_event_id
    WHERE pool_key_id = p_pool_key_id
      AND NOT EXISTS (SELECT 1 FROM pool_states ps WHERE ps.pool_key_id = p_pool_key_id);
END;
$$;

-- Only creation changes what the quoter needs from this table (the config is
-- immutable; the fee ledger does not affect quotes). Swaps already move
-- pool_last_event_id through pool_states.
CREATE TRIGGER zero_seed_launch_states_maintain_pool_last_event_id
    AFTER INSERT OR DELETE
    ON zero_seed_launch_states
    FOR EACH ROW
EXECUTE FUNCTION trg_pool_last_event_id();

CREATE OR REPLACE VIEW all_pool_states_view AS
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
       plei.last_event_id                                        AS last_event_id,
       (SELECT JSONB_AGG(JSONB_BUILD_OBJECT('t', ppptl.tick, 'd',
                                            ppptl.net_liquidity_delta_diff::TEXT) ORDER BY ppptl.tick)
        FROM per_pool_per_tick_liquidity ppptl
        WHERE ppptl.pool_key_id = pk.pool_key_id)                AS ticks,
       CASE
           WHEN p0.value IS NULL OR p1.value IS NULL THEN NULL
           ELSE (COALESCE(pt.balance0, 0)
               / POWER(10::NUMERIC, COALESCE(t0.token_decimals, 0)))
               * p0.value +
                (COALESCE(pt.balance1, 0)
               / POWER(10::NUMERIC, COALESCE(t1.token_decimals, 0)))
               * p1.value
           END                                                   AS pool_tvl_usd,

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
                                            bfrd.net_donate_rate_delta0::TEXT,
                                            's1',
                                            bfrd.net_donate_rate_delta1::TEXT) ORDER BY bfrd.time)
        FROM boosted_fees_donate_rate_deltas bfrd
        WHERE bfrd.pool_key_id = pk.pool_key_id
          AND bfrd.time > bps.last_donated_time)                 AS boosted_fees_donations,

       -- ve33 state
       vps.swap_fee                                              AS ve33_swap_fee,
       vps.pool_total_vote_weight                                AS ve33_pool_total_vote_weight,
       EXTRACT(EPOCH FROM vps.last_pool_fees_accounted_block_timestamp)::int8
                                                                  AS ve33_last_pool_fees_accounted_time,
       vps.last_pool_fees_accounted_amount0                      AS ve33_last_pool_fees_accounted_amount0,
       vps.last_pool_fees_accounted_amount1                      AS ve33_last_pool_fees_accounted_amount1,
       vps.total_pool_fees_accounted0                            AS ve33_total_pool_fees_accounted0,
       vps.total_pool_fees_accounted1                            AS ve33_total_pool_fees_accounted1,
       EXTRACT(EPOCH FROM vps.last_pool_emissions_accrued_block_timestamp)::int8
                                                                  AS ve33_last_pool_emissions_accrued_time,
       vps.last_pool_emissions_accrued_amount                    AS ve33_last_pool_emissions_accrued_amount,
       vps.total_pool_emissions_accrued                          AS ve33_total_pool_emissions_accrued,

       ops.last_snapshot_block_timestamp                         AS oracle_last_snapshot_block_timestamp,
       (mcpk.pool_key_id IS NOT NULL)                            AS is_mev_capture_pool,
       (sp.pool_key_id IS NOT NULL)                              AS is_spline_pool,
       (lops.pool_key_id IS NOT NULL)                            AS is_limit_order_pool,
       (vps.pool_key_id IS NOT NULL)                             AS is_ve33_pool,

       -- zero-seed launch config; see zero_seed_launch_created. Pool ticks
       -- (already oriented to token order), unix seconds, Q0.64 fees.
       zslc.token_is_token1                                      AS zero_seed_launch_token_is_token1,
       zslc.tick_lower                                           AS zero_seed_launch_tick_lower,
       zslc.tick_upper                                           AS zero_seed_launch_tick_upper,
       zslc.liquidity                                            AS zero_seed_launch_liquidity,
       zslc.trading_start                                        AS zero_seed_launch_trading_start,
       zslc.fee_duration                                         AS zero_seed_launch_fee_duration,
       zslc.initial_fee                                          AS zero_seed_launch_initial_fee,
       zslc.final_fee                                            AS zero_seed_launch_final_fee,
       (zslpk.pool_key_id IS NOT NULL OR zslc.pool_key_id IS NOT NULL)
                                                                  AS is_zero_seed_launch_pool
FROM pool_keys pk
         JOIN pool_states ps USING (pool_key_id)
         LEFT JOIN pool_tvl pt USING (pool_key_id)
         -- Position matters twice over. It must come after the two USING
         -- joins, or a second pool_key_id on the left side makes them
         -- ambiguous. And it must sit inside the first eight relations: the
         -- planner collapses a JOIN list only up to join_collapse_limit (8 by
         -- default; 17 relations here), so a join placed further down is
         -- planned after the first group is fixed and its index can never
         -- drive the plan -- the predicate would go back to being a filter
         -- over every pool. Verified against the real planner at 3,000 pools.
         JOIN pool_last_event_id plei ON plei.pool_key_id = pk.pool_key_id
                                     AND plei.chain_id = pk.chain_id
                                     AND plei.core_address = pk.core_address
         LEFT JOIN erc20_tokens t0 ON t0.chain_id = pk.chain_id AND t0.token_address = pk.token0
         LEFT JOIN erc20_tokens_latest_price p0 ON p0.chain_id = pk.chain_id AND p0.token_address = pk.token0
         LEFT JOIN erc20_tokens t1 ON t1.chain_id = pk.chain_id AND t1.token_address = pk.token1
         LEFT JOIN erc20_tokens_latest_price p1 ON p1.chain_id = pk.chain_id AND p1.token_address = pk.token1
         LEFT JOIN twamm_pool_states tps ON pk.pool_key_id = tps.pool_key_id
         LEFT JOIN oracle_pool_states ops ON ops.pool_key_id = pk.pool_key_id
         LEFT JOIN mev_capture_pool_keys mcpk ON mcpk.pool_key_id = pk.pool_key_id
         LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
         LEFT JOIN spline_pools sp ON sp.pool_key_id = pk.pool_key_id
         LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
         LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
         LEFT JOIN zero_seed_launch_created zslc ON zslc.pool_key_id = pk.pool_key_id
         LEFT JOIN zero_seed_launch_pool_keys zslpk ON zslpk.pool_key_id = pk.pool_key_id;
