-- DRAFT for the contract freeze. Not deployed.
-- Schema version: zero-seed-launch-index/v4
-- Source ABIs, one per fee model (sha256 of `jq -cS .abi`, no trailing newline):
--   fixed_base_duration_v1  EkuboProtocol/evm-contracts 43d6628
--                           ZeroSeedLaunch efae9388...e41e,
--                           ZeroSeedLaunchPeriphery df24d9f0...7305
--   tick_rate_v2            EkuboProtocol/evm-contracts 3d6378f
--                           ZeroSeedLaunch 89ff4d15...aadd,
--                           ZeroSeedLaunchPeriphery a6d43b36...db07
--
-- Replaces the unshipped draft 00134_scheduled_launch_pool_states of
-- indexer PR #246 (ScheduledLaunch, LockedLaunchLiquidity, LaunchRouter).
-- That migration never ran in production (main stops at 00139), so this
-- is a replacement of a development format, not a data migration. Nothing of
-- the staged/advance/migrate/terminal/seed design survives here.
--
-- v2 revises this unshipped migration in place for the forward-only extension
-- with a native ETH quote, the fixed-base creator-fee table and the separate
-- periphery: LaunchParameters lost quoteToken and decayFactor, LaunchCreated
-- names the controller (the forwarding locker, normally the periphery) instead
-- of a creator, CreatorFeesClaimed lost its recipient, and the periphery's
-- LaunchOwnerChanged and LaunchFeesClaimed are indexed.
--
-- v3 revises it again for the per-launch quote and the requested supply:
-- LaunchParameters.quoteToken replaced LaunchParameters.liquidity and the
-- extension's constructor quote, so one extension and periphery serve every
-- quote and quote_token is the launch's own. The extension now computes the
-- installed liquidity from the requested supply (LaunchParameters.supply, the
-- token's totalSupply), puts installed_supply <= requested_supply into the
-- position and mints the remainder, sink_supply, to address(0). `supply` is
-- replaced by requested_supply, installed_supply and the generated
-- sink_supply. LaunchCreated does not carry the installed amount: it is the
-- launch-token delta of Core's PositionUpdated of the creation, which the
-- writer requires in the same transaction. A database that applied an earlier
-- draft of this migration (numbered 00134 or 00139) must be rebuilt; none
-- exists outside local tests. It is numbered 00140 to follow the applied
-- 00139_mev_capture_v21, whose objects it does not touch.
--
-- v4 adds the second fee model. The replacement extension (evm-contracts
-- 3d6378f) replaces LaunchParameters.feeDuration (uint32 seconds) with
-- decayRateX32 (uint64, unsigned Q32.32 ticks per second): the excess over the
-- long-run floor final_fee shrinks by tickToSqrtRatio(-m) with
-- m = floor(rate * elapsed / 2^32), and saturates to final_fee when m would
-- leave the tick range. The model is a property of the deployment (the
-- indexer pin), recorded per launch in fee_model; a launch row carries exactly
-- its model's parameter. Launches of the 43d6628 deployment keep their
-- fixed-base table math unchanged. Still unapplied anywhere.
--
--   zero_seed_launch_pool_keys      pools whose extension is a configured
--                                   ZeroSeedLaunch, filled at PoolInitialized
--   zero_seed_launch_created        ZeroSeedLaunch.LaunchCreated
--   zero_seed_launch_swapped        ZeroSeedLaunch.LaunchSwapped
--   zero_seed_launch_fees_claimed   ZeroSeedLaunch.CreatorFeesClaimed: the
--                                   controller moving the fee ledger onto its
--                                   lock
--   zero_seed_launch_owner_changed  ZeroSeedLaunchPeriphery.LaunchOwnerChanged
--   zero_seed_launch_fees_paid      ZeroSeedLaunchPeriphery.LaunchFeesClaimed:
--                                   the payout of that same claim
--   zero_seed_launch_states         one row per launch: the creator fee
--                                   ledger and the owner (the immutable
--                                   config, principal and supply are in
--                                   zero_seed_launch_created)
--
-- Principal and fees are separate ledgers by construction:
--   * Principal is the single position (salt 0, tick_lower, tick_upper) with
--     constant liquidity. Its current token/quote composition follows the Core
--     pool price (pool_states, swaps, pool_balance_change), which never include
--     the creator fee.
--   * The creator fee ledger is saved by the extension under salt = pool id.
--     accrued{0,1} sums LaunchSwapped.fee_amount by side, claimed{0,1} sums
--     the extension's CreatorFeesClaimed only. Balance = accrued - claimed. It
--     never includes principal.
--   * A periphery claim emits both CreatorFeesClaimed (extension, ledger) and
--     LaunchFeesClaimed (periphery, payout) with the same amounts in the same
--     transaction. Only the first moves the ledger; paid{0,1} sums the second
--     for reconciliation and is never added to claimed.
--
-- Ownership: the extension knows only the controller. For launches whose
-- controller is the pinned periphery, the initial creator is the new owner of
-- LaunchOwnerChanged(poolId, 0, owner), emitted after LaunchCreated in the
-- creation transaction, and never changes. Every later LaunchOwnerChanged
-- moves current_owner, which holds the unclaimed and future fee rights.
-- Launches created by another controller have no owner here.
--
-- Native ETH is quote address 0: always token0, 18 decimals, no token
-- contract. quote_kind records native versus ERC-20 explicitly. Every launch
-- of an indexed extension is recorded whatever its quote; whether a quote is
-- supported is the reader's policy.
--
-- Supply, raw launch-token units: requested_supply is LaunchParameters.supply
-- and the token's totalSupply; installed_supply is what Core took into the
-- position (Core PositionUpdated of the creation), all of the circulating
-- inventory; sink_supply = requested - installed was minted to address(0) and
-- can never move. It is not a burn: totalSupply stays requested_supply.
--
-- The fee phase is derived from a block timestamp and the immutable schedule;
-- nothing is stored for it, and there is no completed/migrated state.
--
-- Reorgs: every event table cascades from blocks. Ledger columns are maintained
-- by AFTER INSERT/DELETE row triggers that add or subtract exactly the row's
-- amounts, and owner columns are recomputed from the remaining transfers, so
-- deleting blocks >= n and replaying them restores the same state. Writers
-- insert with ON CONFLICT (chain_id, event_id) DO NOTHING so a redelivered log
-- fires no trigger. recompute_zero_seed_launch_state is the exact repair
-- function.
--
-- No column stores a transaction sender. LaunchSwapped.locker is the contract
-- that forwarded the swap (normally a router); it is not a user.
--
-- Rollback before issuance: in one transaction that locks blocks first,
-- DROP VIEW all_pool_states_view and recreate it from 00123; restore
-- recompute_pool_last_event_id from 00123; DROP the zero_seed_launch_* tables
-- and functions. This returns to the 00139 schema, never to the #246 draft.

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
    -- the locker that forwarded the creation (normally the periphery); the
    -- only locker that may claim the fee ledger; not a user
    controller           NUMERIC NOT NULL,
    -- LaunchParameters.quoteToken, the other token of the pool key; 0 is
    -- native ETH
    quote_token          NUMERIC NOT NULL,
    quote_kind           TEXT GENERATED ALWAYS AS (CASE WHEN quote_token = 0 THEN 'native' ELSE 'erc20' END) STORED,
    position_id          NUMERIC NOT NULL,
    -- installed principal, immutable: the liquidity the extension computed
    liquidity            NUMERIC NOT NULL,
    -- LaunchParameters.supply, the token's totalSupply
    requested_supply     NUMERIC NOT NULL,
    -- launch-token delta of Core's PositionUpdated of the creation
    installed_supply     NUMERIC NOT NULL,
    -- minted to address(0) at creation; never spendable, not a burn
    sink_supply          NUMERIC GENERATED ALWAYS AS (requested_supply - installed_supply) STORED,
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
    -- the deployment's fee model: 'fixed_base_duration_v1' (evm-contracts
    -- 43d6628, fee_duration) or 'tick_rate_v2' (3d6378f, decay_rate_x32)
    fee_model            TEXT    NOT NULL,
    -- v1 only: seconds from trading_start to final_fee
    fee_duration         int8,
    -- v2 only: uint64 Q32.32 ticks per second; 0 keeps initial_fee
    decay_rate_x32       NUMERIC,
    -- Q0.64 fractions (2^64 = 100%)
    initial_fee          NUMERIC NOT NULL,
    final_fee            NUMERIC NOT NULL,
    -- the salt the extension received; a periphery passes
    -- keccak256(abi.encode(owner, userSalt))
    salt                 NUMERIC NOT NULL,
    token_is_token1      bool GENERATED ALWAYS AS (token > quote_token) STORED,
    -- pool-tick bounds of the position
    tick_lower           int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -upper_tick ELSE ask_tick END) STORED,
    tick_upper           int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -ask_tick ELSE upper_tick END) STORED,
    -- v1 only; v2 has no end: final_fee is a floor that is approached
    fee_end              int8 GENERATED ALWAYS AS (trading_start + fee_duration) STORED,
    CHECK (0 < installed_supply AND installed_supply <= requested_supply),
    -- exactly the model's parameter; IS NOT NULL keeps a NULL from passing
    CHECK ((fee_model = 'fixed_base_duration_v1' AND fee_duration IS NOT NULL
            AND fee_duration BETWEEN 1 AND 4294967295 AND decay_rate_x32 IS NULL)
        OR (fee_model = 'tick_rate_v2' AND fee_duration IS NULL AND decay_rate_x32 IS NOT NULL
            AND decay_rate_x32 BETWEEN 0 AND 18446744073709551615
            AND decay_rate_x32 = TRUNC(decay_rate_x32))),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_created (chain_id, block_number);
CREATE UNIQUE INDEX ON zero_seed_launch_created (pool_key_id);
CREATE INDEX ON zero_seed_launch_created (chain_id, token);

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
    controller        NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_fees_claimed (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_fees_claimed (pool_key_id, event_id DESC);

CREATE TABLE zero_seed_launch_owner_changed
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    -- the periphery
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    -- 0 at creation
    previous_owner    NUMERIC NOT NULL,
    new_owner         NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_owner_changed (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_owner_changed (pool_key_id, event_id DESC);
CREATE INDEX ON zero_seed_launch_owner_changed (chain_id, new_owner, event_id DESC);

CREATE TABLE zero_seed_launch_fees_paid
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    -- the periphery
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id       int8 REFERENCES pool_keys (pool_key_id),
    pool_id           NUMERIC NOT NULL,
    owner             NUMERIC NOT NULL,
    recipient         NUMERIC NOT NULL,
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    -- the extension CreatorFeesClaimed of the same claim (same transaction)
    claimed_event_id  int8    NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE,
    FOREIGN KEY (chain_id, claimed_event_id) REFERENCES zero_seed_launch_fees_claimed (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_fees_paid (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_fees_paid (pool_key_id, event_id DESC);
CREATE UNIQUE INDEX ON zero_seed_launch_fees_paid (chain_id, claimed_event_id);

DO
$$
    DECLARE
        event_table TEXT;
    BEGIN
        FOREACH event_table IN ARRAY ARRAY [
            'zero_seed_launch_created',
            'zero_seed_launch_swapped',
            'zero_seed_launch_fees_claimed',
            'zero_seed_launch_owner_changed',
            'zero_seed_launch_fees_paid'
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
    pool_key_id        int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    created_event_id   int8    NOT NULL,
    -- creator fee ledger, raw units of token0/token1
    accrued0           NUMERIC NOT NULL DEFAULT 0,
    accrued1           NUMERIC NOT NULL DEFAULT 0,
    claimed0           NUMERIC NOT NULL DEFAULT 0,
    claimed1           NUMERIC NOT NULL DEFAULT 0,
    -- periphery payouts of those claims; reconciliation only, never ledger
    paid0              NUMERIC NOT NULL DEFAULT 0,
    paid1              NUMERIC NOT NULL DEFAULT 0,
    swap_count         int8    NOT NULL DEFAULT 0,
    claim_count        int8    NOT NULL DEFAULT 0,
    -- claimed <= accrued holds between transactions but not mid-cascade (a
    -- reorg may delete a swap before the claim that followed it), so it is
    -- asserted by tests and the repair check, not a CHECK constraint
    last_event_id      int8    NOT NULL,
    -- periphery owner; NULL until LaunchOwnerChanged(poolId, 0, owner) and for
    -- launches of any other controller
    initial_owner      NUMERIC,
    current_owner      NUMERIC,
    owner_event_id     int8,
    owner_change_count int8    NOT NULL DEFAULT 0
) WITH (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

CREATE INDEX ON zero_seed_launch_states (current_owner) WHERE current_owner IS NOT NULL;
CREATE INDEX ON zero_seed_launch_states (initial_owner) WHERE initial_owner IS NOT NULL;

-- Owner columns from the remaining transfers: the first transfer's new owner
-- is the creator, the last one's is the current owner.
CREATE FUNCTION recompute_zero_seed_launch_owner(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE sql AS
$$
UPDATE zero_seed_launch_states s
SET initial_owner      = o.initial_owner,
    current_owner      = o.current_owner,
    owner_event_id     = o.owner_event_id,
    owner_change_count = o.n
FROM (SELECT (SELECT new_owner FROM zero_seed_launch_owner_changed
              WHERE pool_key_id = p_pool_key_id ORDER BY event_id LIMIT 1)      AS initial_owner,
             (SELECT new_owner FROM zero_seed_launch_owner_changed
              WHERE pool_key_id = p_pool_key_id ORDER BY event_id DESC LIMIT 1) AS current_owner,
             (SELECT MAX(event_id) FROM zero_seed_launch_owner_changed
              WHERE pool_key_id = p_pool_key_id)                               AS owner_event_id,
             (SELECT COUNT(*) FROM zero_seed_launch_owner_changed
              WHERE pool_key_id = p_pool_key_id)                               AS n) o
WHERE s.pool_key_id = p_pool_key_id;
$$;

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
    (pool_key_id, created_event_id, accrued0, accrued1, claimed0, claimed1, paid0, paid1, swap_count,
     claim_count, last_event_id)
    SELECT p_pool_key_id,
           c_event_id,
           COALESCE(sw.a0, 0), COALESCE(sw.a1, 0),
           COALESCE(cl.c0, 0), COALESCE(cl.c1, 0),
           COALESCE(pd.p0, 0), COALESCE(pd.p1, 0),
           COALESCE(sw.n, 0), COALESCE(cl.n, 0),
           GREATEST(c_event_id, sw.last, cl.last, oc.last, pd.last)
    FROM (SELECT SUM(fee_amount) FILTER (WHERE NOT fee_is_token1) AS a0,
                 SUM(fee_amount) FILTER (WHERE fee_is_token1)     AS a1,
                 COUNT(*) AS n, MAX(event_id) AS last
          FROM zero_seed_launch_swapped WHERE pool_key_id = p_pool_key_id) sw,
         (SELECT SUM(amount0) AS c0, SUM(amount1) AS c1, COUNT(*) AS n, MAX(event_id) AS last
          FROM zero_seed_launch_fees_claimed WHERE pool_key_id = p_pool_key_id) cl,
         (SELECT SUM(amount0) AS p0, SUM(amount1) AS p1, MAX(event_id) AS last
          FROM zero_seed_launch_fees_paid WHERE pool_key_id = p_pool_key_id) pd,
         (SELECT MAX(event_id) AS last
          FROM zero_seed_launch_owner_changed WHERE pool_key_id = p_pool_key_id) oc
    ON CONFLICT (pool_key_id) DO UPDATE
        SET created_event_id = EXCLUDED.created_event_id,
            accrued0 = EXCLUDED.accrued0, accrued1 = EXCLUDED.accrued1,
            claimed0 = EXCLUDED.claimed0, claimed1 = EXCLUDED.claimed1,
            paid0 = EXCLUDED.paid0, paid1 = EXCLUDED.paid1,
            swap_count = EXCLUDED.swap_count, claim_count = EXCLUDED.claim_count,
            last_event_id = EXCLUDED.last_event_id;
    PERFORM recompute_zero_seed_launch_owner(p_pool_key_id);
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

-- Incremental, O(1) per row. A swap, claim or payout must follow its
-- LaunchCreated (same pool); one without a state row is a decoder bug and is
-- refused. Payouts move paid{0,1} only, never the claimed ledger.
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
    p0   NUMERIC := 0;
    p1   NUMERIC := 0;
    dsw  int8 := 0;
    dcl  int8 := 0;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF TG_TABLE_NAME = 'zero_seed_launch_swapped' THEN
        IF r.fee_is_token1 THEN d1 := r.fee_amount; ELSE d0 := r.fee_amount; END IF;
        dsw := 1;
    ELSIF TG_TABLE_NAME = 'zero_seed_launch_fees_claimed' THEN
        c0 := r.amount0;
        c1 := r.amount1;
        dcl := 1;
    ELSE
        p0 := r.amount0;
        p1 := r.amount1;
    END IF;

    UPDATE zero_seed_launch_states
    SET accrued0    = accrued0 + sgn * d0,
        accrued1    = accrued1 + sgn * d1,
        claimed0    = claimed0 + sgn * c0,
        claimed1    = claimed1 + sgn * c1,
        paid0       = paid0 + sgn * p0,
        paid1       = paid1 + sgn * p1,
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
        PERFORM zero_seed_launch_recompute_last_event_id(r.pool_key_id);
    END IF;
    RETURN NULL;
END
$$;

CREATE FUNCTION zero_seed_launch_recompute_last_event_id(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE sql AS
$$
UPDATE zero_seed_launch_states s
SET last_event_id = GREATEST(s.created_event_id,
                             (SELECT MAX(event_id) FROM zero_seed_launch_swapped WHERE pool_key_id = p_pool_key_id),
                             (SELECT MAX(event_id) FROM zero_seed_launch_fees_claimed WHERE pool_key_id = p_pool_key_id),
                             (SELECT MAX(event_id) FROM zero_seed_launch_fees_paid WHERE pool_key_id = p_pool_key_id),
                             (SELECT MAX(event_id) FROM zero_seed_launch_owner_changed WHERE pool_key_id = p_pool_key_id))
WHERE s.pool_key_id = p_pool_key_id;
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

CREATE TRIGGER trg_zero_seed_launch_fees_paid_ledger
    AFTER INSERT OR DELETE
    ON zero_seed_launch_fees_paid
    FOR EACH ROW
EXECUTE FUNCTION trg_zero_seed_launch_ledger();

-- Ownership: recomputed from the remaining transfers on every insert and
-- delete, a handful of rows per launch.
CREATE FUNCTION trg_zero_seed_launch_owner()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
DECLARE
    r RECORD;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF NOT EXISTS (SELECT 1 FROM zero_seed_launch_states WHERE pool_key_id = r.pool_key_id) THEN
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'zero-seed launch owner change for pool_key_id % without LaunchCreated', r.pool_key_id;
        END IF;
        RETURN NULL;
    END IF;
    PERFORM recompute_zero_seed_launch_owner(r.pool_key_id);
    IF TG_OP = 'INSERT' THEN
        UPDATE zero_seed_launch_states
        SET last_event_id = GREATEST(last_event_id, r.event_id)
        WHERE pool_key_id = r.pool_key_id;
    ELSE
        PERFORM zero_seed_launch_recompute_last_event_id(r.pool_key_id);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_zero_seed_launch_owner_changed_owner
    AFTER INSERT OR DELETE
    ON zero_seed_launch_owner_changed
    FOR EACH ROW
EXECUTE FUNCTION trg_zero_seed_launch_owner();

-- fixed_base_duration_v1 only (evm-contracts 43d6628).
-- decayQ128 of the contract (math/feeDecay.sol): 2^(-elapsed/600) in Q128.
-- Starting at 2^128, multiply by the constant of every set bit of p_elapsed in
-- ascending bit order and floor to Q128 after each multiply; exactly zero from
-- 2^17 seconds on. The constants and the operation order are normative. DIV is
-- exact integer division on NUMERIC.
CREATE FUNCTION zero_seed_launch_decay_q128(p_elapsed int8)
    RETURNS NUMERIC
    LANGUAGE plpgsql
    IMMUTABLE STRICT PARALLEL SAFE AS
$$
DECLARE
    q      CONSTANT NUMERIC   := 340282366920938463463374607431768211456;
    t      CONSTANT NUMERIC[] := ARRAY [
        339889484297159900493648602831395569057,
        339497055287118257930533248299650400736,
        338713556013920184336129943844147573651,
        337151977828609613753562640265082287810,
        334050386396171404885545237344599070716,
        327932539264834336949184815807600758235,
        316030922441737935988095136387330274498,
        293507844215098455952964317090465751204,
        253162852354938356992240649094357060196,
        188347784201757897225807540435664088841,
        104251325552682051605813724741512712010,
        31939177389160626453527783486618815759,
        2997836947964109484105344435429137776,
        26410496811510722015611852309540293,
        2049810421099131403277778219901,
        12347753427443481862030,
        448060
        ];
    result NUMERIC            := q;
BEGIN
    IF p_elapsed < 0 THEN
        RAISE EXCEPTION 'negative elapsed time %', p_elapsed;
    END IF;
    IF p_elapsed >= 131072 THEN
        RETURN 0;
    END IF;
    FOR i IN 0..16
        LOOP
            IF (p_elapsed >> i) & 1 = 1 THEN
                result := DIV(result * t[i + 1], q);
            END IF;
        END LOOP;
    RETURN result;
END
$$;

-- fixed_base_duration_v1 (evm-contracts 43d6628) only.
-- The fee in effect at p_time (unix seconds), as feeAt in the contract: initial
-- until the start, then final + floor((initial - final) * (decay(t) - decay(D))
-- / (2^128 - decay(D))) for elapsed t below duration D, then final.
CREATE FUNCTION zero_seed_launch_fee_at(p_trading_start int8, p_fee_duration int8, p_initial NUMERIC,
                                        p_final NUMERIC, p_time int8)
    RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE PARALLEL SAFE AS
$$
SELECT CASE
           WHEN p_time <= p_trading_start THEN p_initial
           WHEN p_time - p_trading_start >= p_fee_duration THEN p_final
           ELSE p_final + DIV((p_initial - p_final) *
                              (zero_seed_launch_decay_q128(p_time - p_trading_start) -
                               zero_seed_launch_decay_q128(p_fee_duration)),
                              340282366920938463463374607431768211456 - zero_seed_launch_decay_q128(p_fee_duration))
           END
$$;

-- fixed_base_duration_v1 only. Fee phase at p_time. A schedule label only;
-- trading and the pool are unchanged.
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

-- toFixed(tickToSqrtRatio(-p_magnitude)) of the contracts (math/ticks.sol,
-- types/sqrtRatio.sol): from 2^128, multiply by the constant of every set bit
-- of the magnitude in ascending order and floor to Q128 after each multiply,
-- then round down to the compact 94-bit mantissa of the region the value
-- lands in. Bit 0's constant is 2^128 minus the contract's subtrahend. Only
-- magnitudes 0..88722835 exist; the contract reverts InvalidTick beyond.
CREATE FUNCTION zero_seed_launch_tick_factor_q128(p_magnitude int8)
    RETURNS NUMERIC
    LANGUAGE plpgsql
    IMMUTABLE STRICT PARALLEL SAFE AS
$$
DECLARE
    q      CONSTANT NUMERIC   := 340282366920938463463374607431768211456;
    t      CONSTANT NUMERIC[] := ARRAY [
        340282196779882608775400081051345954875,
        340282026638911824551550055881712329744,
        340281686357225467326082729798982530761,
        340281005794873596573094710012989410072,
        340279644674253220331048947518555486588,
        340276922449345852680114346161748269428,
        340271478064864046934932689706268169160,
        340260589557227275536970734808027446368,
        340238813587222069206590352882444122789,
        340195265827972829906238800850533898084,
        340108187030021964395011332102514443192,
        339934096296338836553381438728885759063,
        339586182118148867994722769619739863337,
        338891421642114786711725022995822495130,
        337506162020136007223375792700736547955,
        334752606878476170032608184381010470119,
        329312708224965356314372077522414179198,
        318696677643769341895946499718036526719,
        298480268784467865547185399201474874621,
        261813363001402740542020888190605903085,
        201439286044552466954512953679502885114,
        119247395418425876229630149779831629514,
        41788651709309085859755118322591422179,
        5131889223303998677939799486543748348,
        77395391476111124436543048938586576,
        17603164912545197391926702422886,
        910630244353091011850553
        ];
    result NUMERIC            := q;
    shift  NUMERIC;
BEGIN
    IF p_magnitude < 0 OR p_magnitude > 88722835 THEN
        RAISE EXCEPTION 'tick magnitude % outside 0..88722835', p_magnitude;
    END IF;
    FOR i IN 0..26
        LOOP
            IF (p_magnitude >> i) & 1 = 1 THEN
                result := DIV(result * t[i + 1], q);
            END IF;
        END LOOP;
    -- regions >= 2^160 cannot occur for a non-positive tick
    shift := CASE
                 WHEN result >= q THEN 73786976294838206464          -- 2^66
                 WHEN result >= 79228162514264337593543950336 THEN 17179869184 -- 2^96: 2^34
                 ELSE 4                                                 -- 2^2
        END;
    RETURN DIV(result, shift) * shift;
END
$$;

-- decayedFee of the tick-rate contract (evm-contracts 3d6378f,
-- math/feeDecay.sol) in its normative order: rate 0 is the initial fee;
-- elapsed > MAX_DECAY_PRODUCT / rate (integer division before any multiply;
-- MAX_DECAY_PRODUCT = (88722835 + 1) * 2^32 - 1) is the final fee, the floor;
-- otherwise m = floor(rate * elapsed / 2^32) and
-- final + floor((initial - final) * factor(m) / 2^128).
CREATE FUNCTION zero_seed_launch_tick_rate_fee(p_initial NUMERIC, p_final NUMERIC,
                                               p_decay_rate_x32 NUMERIC, p_elapsed NUMERIC)
    RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE STRICT PARALLEL SAFE AS
$$
SELECT CASE
           WHEN p_elapsed <= 0 OR p_decay_rate_x32 = 0 THEN p_initial
           WHEN p_elapsed > DIV(381061679028371455, p_decay_rate_x32) THEN p_final
           ELSE p_final + DIV((p_initial - p_final) *
                              zero_seed_launch_tick_factor_q128(
                                      DIV(p_decay_rate_x32 * p_elapsed, 4294967296)::int8),
                              340282366920938463463374607431768211456)
           END
$$;

-- feeAt of either fee model at p_time (unix seconds): the launch row's own
-- model decides; the other model's parameter must be NULL.
CREATE FUNCTION zero_seed_launch_model_fee_at(p_fee_model TEXT, p_trading_start int8,
                                              p_fee_duration int8, p_decay_rate_x32 NUMERIC,
                                              p_initial NUMERIC, p_final NUMERIC, p_time int8)
    RETURNS NUMERIC
    LANGUAGE plpgsql
    IMMUTABLE PARALLEL SAFE AS
$$
BEGIN
    IF p_fee_model = 'fixed_base_duration_v1' AND p_decay_rate_x32 IS NULL THEN
        RETURN zero_seed_launch_fee_at(p_trading_start, p_fee_duration, p_initial, p_final, p_time);
    ELSIF p_fee_model = 'tick_rate_v2' AND p_fee_duration IS NULL THEN
        RETURN zero_seed_launch_tick_rate_fee(p_initial, p_final, p_decay_rate_x32,
                                              p_time::NUMERIC - p_trading_start);
    END IF;
    RAISE EXCEPTION 'invalid zero-seed launch fee model %', p_fee_model;
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
       zslc.fee_model                                            AS zero_seed_launch_fee_model,
       zslc.fee_duration                                         AS zero_seed_launch_fee_duration,
       zslc.decay_rate_x32                                       AS zero_seed_launch_decay_rate_x32,
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
