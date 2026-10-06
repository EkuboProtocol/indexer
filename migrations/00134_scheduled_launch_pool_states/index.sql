-- Index the launchpad contracts (ScheduledLaunch, LockedLaunchLiquidity and
-- LaunchRouter at EkuboProtocol/evm-contracts
-- 40e5bb11f7d4a8b40bb40232027fa7888052eacb) and expose launch pool state on
-- all_pool_states_view for quoter-service.
--
-- One table per event, each with the standard event columns and a
-- pool_key_id resolved from (chain_id, core_address, pool id). Every id the
-- launch contracts emit (ScheduledLaunch's poolId, LockedLaunchLiquidity's and
-- LaunchRouter's launchId) is the launch pool's id on the V3 core.
--
--   scheduled_launch_created              ScheduledLaunch.LaunchCreated
--   scheduled_launch_advanced             ScheduledLaunch.LaunchAdvanced
--   scheduled_launch_swapped              ScheduledLaunch.LaunchSwapped
--   scheduled_launch_creator_fees_claimed ScheduledLaunch.CreatorFeesClaimed
--   launch_principal_received             LockedLaunchLiquidity.PrincipalReceived
--   launch_liquidity_locked               LockedLaunchLiquidity.LiquidityLocked
--   launch_locked_fees_claimed            LockedLaunchLiquidity.FeesClaimed
--   launch_created_by                     LaunchRouter.LaunchCreatedBy
--
-- scheduled_launch_pool_keys lists the pools whose extension is the
-- configured ScheduledLaunch deployment. It is filled at PoolInitialized, as
-- mev_capture_pool_keys is, and drives is_scheduled_launch_pool.
--
-- scheduled_launch_pool_states holds one row per launch: the LaunchCreated
-- config and the launch's saved state. ScheduledLaunch's saved reserves for a
-- launch change only at creation and inside _advance, and every _advance
-- after startTime emits LaunchAdvanced with the post-advance (deployed,
-- reserve0, reserve1, complete). Every launch swap runs _advance first, so a
-- swap transaction carries LaunchAdvanced, then Core's swap, then
-- LaunchSwapped. Creator fees are saved under a separate salt and never touch
-- the reserves. The state is therefore exactly the config plus the latest
-- LaunchAdvanced; before the first one it is deployed = 0, the whole supply on
-- the launch token's side, and complete = false. Inserts and reorg deletes on
-- either source table recompute it from two index probes, as 00130 on the
-- closed ContinuousAuction branch did.
--
-- The state table feeds pool_last_event_id as a sixth source, so every
-- creation and advance, and therefore every launch swap, moves the pool's
-- last_event_id and the quoter re-syncs it. Core's own swap and position
-- events on the launch pool already move pool_states.
--
-- launch_creators and scheduled_launch_terminal_pools are views over the
-- LaunchCreatedBy and LiquidityLocked tables, so reorgs need no maintenance.
--
-- No table stores a transaction's sender, because the indexer reads logs
-- only. Attributing an event to its sender means resolving transaction_hash.
--
-- Deploy: additive. CREATE TRIGGER on the new tables does not conflict with
-- the workers, and neither do CREATE OR REPLACE VIEW and the
-- recompute_pool_last_event_id swap, but park the workers anyway by locking
-- blocks first, as 00123 does. That keeps recompute_pool_last_event_id from
-- running half-replaced mid-transaction. The new tables start empty and no
-- existing pool gets a launch state, so nothing is backfilled and the lock is
-- held for well under a second.
--
-- Rollback (after rolling back any quoter-service or api release that selects
-- the new columns), in one transaction that locks blocks first: DROP VIEW
-- all_pool_states_view and recreate it from 00123, since CREATE OR REPLACE
-- cannot drop columns; restore recompute_pool_last_event_id from 00123; then
-- DROP the two launch views, scheduled_launch_pool_states and its functions,
-- the eight event tables and scheduled_launch_pool_keys.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE scheduled_launch_pool_keys
(
    pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE TABLE scheduled_launch_created
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
    -- the launch token, deployed by the creation
    token                NUMERIC NOT NULL,
    -- owner of record of the creator fees; LaunchRouter for launches created
    -- through it (LaunchConfig.owner, equal to the indexed owner)
    owner                NUMERIC NOT NULL,
    quote_token          NUMERIC NOT NULL,
    -- NUL characters are stripped; Postgres text cannot hold them
    name                 TEXT    NOT NULL,
    symbol               TEXT    NOT NULL,
    decimals             int2    NOT NULL,
    total_supply         NUMERIC NOT NULL,
    -- unix seconds
    start_time           int8    NOT NULL,
    end_time             int8    NOT NULL,
    -- ticks of raw quote units per launch token, independent of token order
    target_tick          int4    NOT NULL,
    upper_tick           int4    NOT NULL,
    tick_spacing         int4    NOT NULL,
    -- 0.64 fixed-point fractions
    initial_fee          NUMERIC NOT NULL,
    final_fee            NUMERIC NOT NULL,
    migration_tick_lower int4    NOT NULL,
    migration_tick_upper int4    NOT NULL,
    -- ScheduledLaunch._initialize: token0 is the lower address
    token_is_token1      bool GENERATED ALWAYS AS (token > quote_token) STORED,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON scheduled_launch_created (chain_id, block_number);
CREATE INDEX ON scheduled_launch_created (pool_key_id, event_id DESC);
CREATE INDEX ON scheduled_launch_created (chain_id, token);

CREATE TABLE scheduled_launch_advanced
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
    deployed          NUMERIC NOT NULL,
    reserve0          NUMERIC NOT NULL,
    reserve1          NUMERIC NOT NULL,
    complete          bool    NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON scheduled_launch_advanced (chain_id, block_number);
CREATE INDEX ON scheduled_launch_advanced (pool_key_id, event_id DESC);

CREATE TABLE scheduled_launch_swapped
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
    -- the locker that forwarded the swap, usually a router
    locker            NUMERIC NOT NULL,
    -- fee-inclusive pool-perspective deltas returned to the locker
    delta0            NUMERIC NOT NULL,
    delta1            NUMERIC NOT NULL,
    fee_amount        NUMERIC NOT NULL,
    fee_is_token1     bool    NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON scheduled_launch_swapped (chain_id, block_number);
CREATE INDEX ON scheduled_launch_swapped (pool_key_id, event_id DESC);

CREATE TABLE scheduled_launch_creator_fees_claimed
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
    recipient         NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON scheduled_launch_creator_fees_claimed (chain_id, block_number);
CREATE INDEX ON scheduled_launch_creator_fees_claimed (pool_key_id, event_id DESC);

CREATE TABLE launch_principal_received
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    -- the launch pool
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    launch_id         NUMERIC NOT NULL,
    -- ScheduledLaunch for migrated principal, otherwise the locker that
    -- forwarded LAUNCH_FUND (LaunchRouter for LaunchRouter.fund)
    from_address      NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON launch_principal_received (chain_id, block_number);
CREATE INDEX ON launch_principal_received (pool_key_id, event_id DESC);

CREATE TABLE launch_liquidity_locked
(
    chain_id             int8    NOT NULL,
    block_number         int8    NOT NULL,
    transaction_index    int4    NOT NULL,
    event_index          int4    NOT NULL,
    transaction_hash     NUMERIC NOT NULL,
    emitter              NUMERIC NOT NULL,
    event_id             int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    -- the launch pool
    pool_key_id          int8 REFERENCES pool_keys (pool_key_id),
    launch_id            NUMERIC NOT NULL,
    -- the full-range TWAMM pool the principal is locked in
    terminal_pool_key_id int8 REFERENCES pool_keys (pool_key_id),
    terminal_pool_id     NUMERIC NOT NULL,
    liquidity            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON launch_liquidity_locked (chain_id, block_number);
CREATE INDEX ON launch_liquidity_locked (pool_key_id, event_id DESC);
CREATE INDEX ON launch_liquidity_locked (terminal_pool_key_id);

CREATE TABLE launch_locked_fees_claimed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    -- the launch pool
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    launch_id         NUMERIC NOT NULL,
    recipient         NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON launch_locked_fees_claimed (chain_id, block_number);
CREATE INDEX ON launch_locked_fees_claimed (pool_key_id, event_id DESC);

CREATE TABLE launch_created_by
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    -- the launch pool
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    launch_id         NUMERIC NOT NULL,
    -- msg.sender of LaunchRouter.create, the only account that may claim fees
    creator           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON launch_created_by (chain_id, block_number);
CREATE INDEX ON launch_created_by (pool_key_id, event_id DESC);
CREATE INDEX ON launch_created_by (chain_id, creator);

DO
$$
    DECLARE
        event_table TEXT;
    BEGIN
        FOREACH event_table IN ARRAY ARRAY [
            'scheduled_launch_created',
            'scheduled_launch_advanced',
            'scheduled_launch_swapped',
            'scheduled_launch_creator_fees_claimed',
            'launch_principal_received',
            'launch_liquidity_locked',
            'launch_locked_fees_claimed',
            'launch_created_by'
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

-- LaunchRouter.creator(launchId). A launch is created once, so one row each.
CREATE VIEW launch_creators AS
SELECT pool_key_id, chain_id, launch_id, creator, event_id, transaction_hash
FROM launch_created_by;

-- LockedLaunchLiquidity.getTerminal(launchId).poolKey, once liquidity has been
-- locked there. Migration can deposit more than once (LockedLaunchLiquidity.
-- migrate retries), so liquidity is the running total.
CREATE VIEW scheduled_launch_terminal_pools AS
SELECT pool_key_id,
       chain_id,
       launch_id,
       terminal_pool_key_id,
       terminal_pool_id,
       SUM(liquidity)  AS locked_liquidity,
       MIN(event_id)   AS first_locked_event_id,
       MAX(event_id)   AS last_locked_event_id
FROM launch_liquidity_locked
GROUP BY pool_key_id, chain_id, launch_id, terminal_pool_key_id, terminal_pool_id;

CREATE TABLE scheduled_launch_pool_states
(
    pool_key_id            int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    -- config, from LaunchCreated; see scheduled_launch_created
    token                  NUMERIC NOT NULL,
    quote_token            NUMERIC NOT NULL,
    owner                  NUMERIC NOT NULL,
    token_is_token1        bool    NOT NULL,
    total_supply           NUMERIC NOT NULL,
    start_time             int8    NOT NULL,
    end_time               int8    NOT NULL,
    target_tick            int4    NOT NULL,
    upper_tick             int4    NOT NULL,
    tick_spacing           int4    NOT NULL,
    initial_fee            NUMERIC NOT NULL,
    final_fee              NUMERIC NOT NULL,
    migration_tick_lower   int4    NOT NULL,
    migration_tick_upper   int4    NOT NULL,
    -- state, from the latest LaunchAdvanced
    deployed               NUMERIC NOT NULL,
    reserve0               NUMERIC NOT NULL,
    reserve1               NUMERIC NOT NULL,
    complete               bool    NOT NULL,
    created_event_id       int8    NOT NULL,
    last_advanced_event_id int8,
    last_event_id          int8    NOT NULL
) WITH (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

-- Exact recompute of one launch's state from its events; also the repair
-- tool. No LaunchCreated row means no launch state.
CREATE FUNCTION recompute_scheduled_launch_pool_state(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql AS
$$
DECLARE
    c scheduled_launch_created%ROWTYPE;
    a scheduled_launch_advanced%ROWTYPE;
BEGIN
    SELECT *
    INTO c
    FROM scheduled_launch_created
    WHERE pool_key_id = p_pool_key_id
    ORDER BY event_id DESC
    LIMIT 1;

    IF c.event_id IS NULL THEN
        DELETE FROM scheduled_launch_pool_states WHERE pool_key_id = p_pool_key_id;
        RETURN;
    END IF;

    SELECT *
    INTO a
    FROM scheduled_launch_advanced
    WHERE pool_key_id = p_pool_key_id
      AND event_id > c.event_id
    ORDER BY event_id DESC
    LIMIT 1;

    INSERT INTO scheduled_launch_pool_states
    (pool_key_id, token, quote_token, owner, token_is_token1, total_supply, start_time, end_time,
     target_tick, upper_tick, tick_spacing, initial_fee, final_fee, migration_tick_lower,
     migration_tick_upper, deployed, reserve0, reserve1, complete, created_event_id,
     last_advanced_event_id, last_event_id)
    VALUES (p_pool_key_id, c.token, c.quote_token, c.owner, c.token_is_token1, c.total_supply,
            c.start_time, c.end_time, c.target_tick, c.upper_tick, c.tick_spacing, c.initial_fee,
            c.final_fee, c.migration_tick_lower, c.migration_tick_upper,
            COALESCE(a.deployed, 0),
            COALESCE(a.reserve0, CASE WHEN c.token_is_token1 THEN 0 ELSE c.total_supply END),
            COALESCE(a.reserve1, CASE WHEN c.token_is_token1 THEN c.total_supply ELSE 0 END),
            COALESCE(a.complete, FALSE),
            c.event_id,
            a.event_id,
            GREATEST(c.event_id, a.event_id))
    ON CONFLICT (pool_key_id) DO UPDATE
        SET token                  = EXCLUDED.token,
            quote_token            = EXCLUDED.quote_token,
            owner                  = EXCLUDED.owner,
            token_is_token1        = EXCLUDED.token_is_token1,
            total_supply           = EXCLUDED.total_supply,
            start_time             = EXCLUDED.start_time,
            end_time               = EXCLUDED.end_time,
            target_tick            = EXCLUDED.target_tick,
            upper_tick             = EXCLUDED.upper_tick,
            tick_spacing           = EXCLUDED.tick_spacing,
            initial_fee            = EXCLUDED.initial_fee,
            final_fee              = EXCLUDED.final_fee,
            migration_tick_lower   = EXCLUDED.migration_tick_lower,
            migration_tick_upper   = EXCLUDED.migration_tick_upper,
            deployed               = EXCLUDED.deployed,
            reserve0               = EXCLUDED.reserve0,
            reserve1               = EXCLUDED.reserve1,
            complete               = EXCLUDED.complete,
            created_event_id       = EXCLUDED.created_event_id,
            last_advanced_event_id = EXCLUDED.last_advanced_event_id,
            last_event_id          = EXCLUDED.last_event_id;
END
$$;

CREATE FUNCTION trg_scheduled_launch_pool_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
DECLARE
    v_pool_key_id int8 := CASE WHEN TG_OP = 'DELETE' THEN OLD.pool_key_id ELSE NEW.pool_key_id END;
BEGIN
    IF v_pool_key_id IS NOT NULL THEN
        PERFORM recompute_scheduled_launch_pool_state(v_pool_key_id);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_scheduled_launch_created_pool_state
    AFTER INSERT OR DELETE
    ON scheduled_launch_created
    FOR EACH ROW
EXECUTE FUNCTION trg_scheduled_launch_pool_state();

CREATE TRIGGER trg_scheduled_launch_advanced_pool_state
    AFTER INSERT OR DELETE
    ON scheduled_launch_advanced
    FOR EACH ROW
EXECUTE FUNCTION trg_scheduled_launch_pool_state();

-- pool_last_event_id: the 00123 recompute with the sixth state table.
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
                    vps.last_event_id, slps.last_event_id)
    FROM pool_keys pk
             JOIN pool_states ps USING (pool_key_id)
             LEFT JOIN twamm_pool_states tps ON tps.pool_key_id = pk.pool_key_id
             LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
             LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
             LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
             LEFT JOIN scheduled_launch_pool_states slps ON slps.pool_key_id = pk.pool_key_id
    WHERE pk.pool_key_id = p_pool_key_id
    ON CONFLICT (pool_key_id) DO UPDATE
        SET last_event_id = EXCLUDED.last_event_id,
            -- immutable in practice, but the view's join needs them to match
            -- pool_keys, so a repair must be able to re-sync them
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

CREATE TRIGGER scheduled_launch_pool_states_maintain_pool_last_event_id
    AFTER INSERT OR DELETE
    ON scheduled_launch_pool_states
    FOR EACH ROW
EXECUTE FUNCTION trg_pool_last_event_id();

CREATE TRIGGER scheduled_launch_pool_states_maintain_pool_last_event_id_upd
    AFTER UPDATE OF last_event_id
    ON scheduled_launch_pool_states
    FOR EACH ROW
    WHEN (OLD.last_event_id IS DISTINCT FROM NEW.last_event_id)
EXECUTE FUNCTION trg_pool_last_event_id();

-- The view, verbatim from 00123 with the launch columns appended (CREATE OR
-- REPLACE VIEW can only add columns at the end) and their two joins placed
-- last, so the pool_last_event_id join stays within join_collapse_limit.
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

       -- scheduled launch config and state; see scheduled_launch_pool_states.
       -- Ticks are raw quote units per launch token: when the launch token is
       -- token1 the pool's target tick is -target_tick and the launch
       -- position spans [-upper_tick, -target_tick], otherwise
       -- [target_tick, upper_tick]. Unix seconds; fees as 0.64 fractions.
       slps.token_is_token1                                      AS scheduled_launch_token_is_token1,
       slps.total_supply                                         AS scheduled_launch_total_supply,
       slps.start_time                                           AS scheduled_launch_start_time,
       slps.end_time                                             AS scheduled_launch_end_time,
       slps.target_tick                                          AS scheduled_launch_target_tick,
       slps.upper_tick                                           AS scheduled_launch_upper_tick,
       slps.tick_spacing                                         AS scheduled_launch_tick_spacing,
       slps.initial_fee                                          AS scheduled_launch_initial_fee,
       slps.final_fee                                            AS scheduled_launch_final_fee,
       slps.deployed                                             AS scheduled_launch_deployed,
       slps.reserve0                                             AS scheduled_launch_reserve0,
       slps.reserve1                                             AS scheduled_launch_reserve1,
       slps.complete                                             AS scheduled_launch_complete,
       -- a state row also identifies a launch whose PoolInitialized predates
       -- the address being configured
       (slpk.pool_key_id IS NOT NULL OR slps.pool_key_id IS NOT NULL)
                                                                  AS is_scheduled_launch_pool
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
         LEFT JOIN scheduled_launch_pool_states slps ON slps.pool_key_id = pk.pool_key_id
         LEFT JOIN scheduled_launch_pool_keys slpk ON slpk.pool_key_id = pk.pool_key_id;
