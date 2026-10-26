-- Zero-seed launches of EkuboProtocol/evm-contracts 853b608 (final source
-- freeze; not deployed). Source ABIs: src/evm/abis/zero-seed-launch/, hashes
-- in tests/fixtures/zero-seed-launch/freeze-853b608/PROVENANCE.md.
--
-- Unreleased: this migration only ever existed on the launch branch (main
-- stops at 00139) and replaces every earlier draft of itself (the #246
-- ScheduledLaunch draft numbered 00134, and the fixed-base and tick-rate
-- drafts numbered 00139/00140). A local database that applied an earlier draft
-- must be rebuilt; there is no data migration.
--
--   zero_seed_launch_pool_keys      pools whose extension is the configured
--                                   ZeroSeedLaunch, filled at PoolInitialized
--   zero_seed_launch_created        ZeroSeedLaunch.LaunchCreated
--   zero_seed_launch_swapped        ZeroSeedLaunch.LaunchSwapped
--   zero_seed_launch_fees_claimed   ZeroSeedLaunch.CreatorFeesClaimed: the
--                                   claim itself (the ledger moves here)
--   zero_seed_launch_fees_paid      ZeroSeedLaunchPeriphery.LaunchFeesClaimed:
--                                   owner and recipient of that same claim,
--                                   linked 1:1 to it; never a second claim
--   zero_seed_launch_owner_changed  ZeroSeedLaunchPeriphery.LaunchOwnerChanged
--   zero_seed_launch_token_events   raw LaunchToken Transfer/Approval logs of
--                                   the launch tokens, mints included
--   zero_seed_launch_states         one row per launch: fee ledger, counts,
--                                   creator and current owner
--   zero_seed_launch_claims         view: one row per claim
--
-- Claims: a periphery claim emits CreatorFeesClaimed (extension) and then
-- LaunchFeesClaimed (periphery) with equal amounts in one transaction. The
-- claim is keyed on the extension event; the payout row must match its
-- amounts and points at it (claimed_event_id, unique), so it can only attach
-- the owner and recipient. claimed{0,1} sums the extension events only.
-- paid{0,1} is kept for reconciliation and must equal claimed{0,1} for
-- periphery launches; it is never added to it.
--
-- Supply, raw launch-token units. LaunchToken mints exactly once, inside the
-- creation: Transfer(0, Core, installed) and, if positive, Transfer(0, 0,
-- requested - installed). requested_supply = LaunchParameters.supply =
-- totalSupply. installed_supply is the launch-token delta of Core's
-- PositionUpdated of the creation (Core's debit is the first mint's amount).
-- sink_supply = requested - installed went to address(0) and can never move;
-- it is not a burn and totalSupply stays requested_supply. The writer refuses
-- a creation whose captured mints differ from exactly these.
--
-- LaunchToken logs: every Transfer and Approval of each launch token is kept
-- raw in zero_seed_launch_token_events (no balances or allowances are
-- derived). The stream follows each token from its LaunchCreated, including
-- the mints that precede it in the creation transaction (see
-- docs/zero-seed-launch-events.md).
--
-- Ticks: ask_tick/upper_tick are the requested economic ticks of
-- LaunchParameters. The installed range uses the derived spacing
-- s = (upper - ask + 255) / 256 and the signed-aligned bounds
-- aligned_ask = ceil(ask / s) * s, aligned_upper = floor(upper / s) * s,
-- checked against the pool key and position id by the writer.
-- tick_lower/tick_upper are the pool ticks of the position.
--
-- Fee: the shifted exponential of the contract (zero_seed_launch_fee_at).
--
-- Reorgs: every event table cascades from blocks. Ledger columns are kept by
-- AFTER INSERT/DELETE row triggers that add or subtract exactly the row, and
-- owner columns are recomputed from the remaining owner changes, so deleting
-- blocks >= n and replaying them restores the same state. Writers insert with
-- ON CONFLICT (chain_id, event_id) DO NOTHING, so a redelivered log changes
-- nothing. recompute_zero_seed_launch_state is the exact repair function.
--
-- Rollback before release: DROP VIEW all_pool_states_view and recreate it from
-- 00139; restore recompute_pool_last_event_id from 00123; drop the
-- zero_seed_launch_* objects.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE zero_seed_launch_pool_keys
(
    pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE TABLE zero_seed_launch_created
(
    chain_id           int8    NOT NULL,
    block_number       int8    NOT NULL,
    transaction_index  int4    NOT NULL,
    event_index        int4    NOT NULL,
    transaction_hash   NUMERIC NOT NULL,
    emitter            NUMERIC NOT NULL,
    event_id           int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id        int8 REFERENCES pool_keys (pool_key_id),
    pool_id            NUMERIC NOT NULL,
    token              NUMERIC NOT NULL,
    -- the forwarding locker of the creation (the periphery for periphery
    -- launches), the only locker that may claim; not the owner
    controller         NUMERIC NOT NULL,
    -- LaunchParameters.quoteToken; 0 is native ETH (then always token0)
    quote_token        NUMERIC NOT NULL,
    quote_kind         TEXT GENERATED ALWAYS AS (CASE WHEN quote_token = 0 THEN 'native' ELSE 'erc20' END) STORED,
    position_id        NUMERIC NOT NULL,
    liquidity          NUMERIC NOT NULL,
    requested_supply   NUMERIC NOT NULL,
    installed_supply   NUMERIC NOT NULL,
    sink_supply        NUMERIC GENERATED ALWAYS AS (requested_supply - installed_supply) STORED,
    -- LaunchParameters.name/symbol: the canonical LibString.packOne words
    name_word          NUMERIC NOT NULL,
    symbol_word        NUMERIC NOT NULL,
    -- their content as UTF-8 text; NULL when it is not valid UTF-8 or holds a
    -- NUL byte (Postgres text cannot), the words stay authoritative
    name               TEXT,
    symbol             TEXT,
    -- LaunchCreated.logoUrl exactly as emitted ('' when absent); never
    -- fetched or rewritten. logo_url is the same bytes as text, NULL when
    -- they are not valid UTF-8 or hold a NUL byte.
    logo_url_bytes     BYTEA   NOT NULL,
    logo_url           TEXT,
    -- requested economic ticks: log1.000001 of raw quote per raw launch token
    ask_tick           int4    NOT NULL,
    upper_tick         int4    NOT NULL,
    -- derived spacing and installed (aligned) economic bounds
    tick_spacing       int8    NOT NULL,
    aligned_ask_tick   int4    NOT NULL,
    aligned_upper_tick int4    NOT NULL,
    -- unix seconds
    trading_start      NUMERIC NOT NULL,
    -- uint64 Q32.32 ticks per second; 0 keeps initial_fee
    decay_rate_x32     NUMERIC NOT NULL,
    -- Q0.64 fractions (2^64 = 100%, not encodable)
    initial_fee        NUMERIC NOT NULL,
    final_fee          NUMERIC NOT NULL,
    -- the salt the extension received; a periphery passes
    -- keccak256(abi.encode(owner, userSalt))
    salt               NUMERIC NOT NULL,
    token_is_token1    bool GENERATED ALWAYS AS (token > quote_token) STORED,
    tick_lower         int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -aligned_upper_tick ELSE aligned_ask_tick END) STORED,
    tick_upper         int4 GENERATED ALWAYS AS (CASE WHEN token > quote_token THEN -aligned_ask_tick ELSE aligned_upper_tick END) STORED,
    CHECK (0 < installed_supply AND installed_supply <= requested_supply),
    CHECK (requested_supply <= 1000000000000000000000000000000),
    CHECK (ask_tick < upper_tick),
    CHECK (tick_spacing = (upper_tick::int8 - ask_tick + 255) / 256),
    CHECK (aligned_ask_tick < aligned_upper_tick),
    CHECK (final_fee <= initial_fee),
    CHECK (decay_rate_x32 BETWEEN 0 AND 18446744073709551615),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_created (chain_id, block_number);
CREATE UNIQUE INDEX ON zero_seed_launch_created (pool_key_id);
CREATE INDEX ON zero_seed_launch_created (chain_id, token);

CREATE TABLE zero_seed_launch_token_events
(
    chain_id          int8    NOT NULL,
    block_number      int8    NOT NULL,
    transaction_index int4    NOT NULL,
    event_index       int4    NOT NULL,
    transaction_hash  NUMERIC NOT NULL,
    -- the launch token (zero_seed_launch_created.token); no foreign key: the
    -- mints precede LaunchCreated in the creation transaction
    emitter           NUMERIC NOT NULL,
    event_id          int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    kind              TEXT    NOT NULL CHECK (kind IN ('transfer', 'approval')),
    -- Transfer: from, to; Approval: owner, spender
    from_or_owner     NUMERIC NOT NULL,
    to_or_spender     NUMERIC NOT NULL,
    -- raw launch-token units (uint256)
    value             NUMERIC NOT NULL CHECK (value BETWEEN 0 AND 115792089237316195423570985008687907853269984665640564039457584007913129639935),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON zero_seed_launch_token_events (chain_id, block_number);
CREATE INDEX ON zero_seed_launch_token_events (chain_id, emitter, event_id);

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
    -- the extension CreatorFeesClaimed of the same claim (same transaction,
    -- equal amounts)
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
            'zero_seed_launch_fees_paid',
            'zero_seed_launch_token_events'
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

-- One row per claim, keyed on the extension event. owner and recipient come
-- from the periphery payout of the same claim and are NULL for a launch whose
-- controller is not the periphery.
CREATE VIEW zero_seed_launch_claims AS
SELECT c.chain_id,
       c.pool_key_id,
       c.pool_id,
       c.event_id,
       c.block_number,
       c.transaction_index,
       c.event_index,
       c.transaction_hash,
       c.controller,
       p.owner,
       p.recipient,
       c.amount0,
       c.amount1,
       p.event_id AS payout_event_id
FROM zero_seed_launch_fees_claimed c
         LEFT JOIN zero_seed_launch_fees_paid p
                   ON p.chain_id = c.chain_id AND p.claimed_event_id = c.event_id;

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
    -- claimed <= accrued holds between transactions but not mid-cascade, so
    -- it is asserted by tests and the repair check, not a CHECK constraint
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

-- Owner columns from the remaining owner changes: the first one's new owner
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

-- feeAt of the contract (math/feeDecay.sol decayedFee, ZeroSeedLaunch._feeAt)
-- at p_time (unix seconds), in its normative order: at or before the start,
-- or with rate 0, the initial fee; elapsed > MAX_DECAY_PRODUCT / rate (integer
-- division first; MAX_DECAY_PRODUCT = (88722835 + 1) * 2^32 - 1) is the final
-- fee, the floor; otherwise m = floor(rate * elapsed / 2^32) and
-- final + floor((initial - final) * factor(m) / 2^128).
CREATE FUNCTION zero_seed_launch_fee_at(p_trading_start NUMERIC, p_decay_rate_x32 NUMERIC,
                                        p_initial NUMERIC, p_final NUMERIC, p_time NUMERIC)
    RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE STRICT PARALLEL SAFE AS
$$
SELECT CASE
           WHEN p_time <= p_trading_start OR p_decay_rate_x32 = 0 THEN p_initial
           WHEN p_time - p_trading_start > DIV(381061679028371455, p_decay_rate_x32) THEN p_final
           ELSE p_final + DIV((p_initial - p_final) *
                              zero_seed_launch_tick_factor_q128(
                                      DIV(p_decay_rate_x32 * (p_time - p_trading_start), 4294967296)::int8),
                              340282366920938463463374607431768211456)
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
