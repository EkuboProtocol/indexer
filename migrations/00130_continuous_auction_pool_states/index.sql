-- Index the ContinuousAuction extension's bid schedule and expose it on
-- all_pool_states_view for quoter-service.
--
-- continuous_auction_pool_states mirrors ContinuousAuction.auctions(poolId):
-- the current bid, the next bid (NULL while none is pending), and
-- lastSettled. The contract emits no event for activation. It emits one
-- BidUpdated per bid update, and every settlement that charges rent emits
-- RentAccrued or RentUnallocated. A pending bid always charges rent once it
-- activates, so every activation has one of those. The schedule is therefore
-- a fold over two event tables:
--
-- * continuous_auction_bid_updated: placing, replacing, shortening,
--   cancelling and displacing are all this one event. The row also stores
--   the schedule right after the update (the current_* and next_* columns).
--   A BEFORE INSERT trigger computes those from the schedule as of the
--   previous event, using the contract's own _updateBid rules.
-- * continuous_auction_rent_settled: RentAccrued (allocated) and
--   RentUnallocated (not allocated). A settlement after the latest bid
--   update advances lastSettled to its block time and activates the pending
--   bid.
--
-- The state for a pool is then the latest bid update's stored schedule,
-- settled at the latest rent event after it. That takes two index probes, so
-- inserts and reorg deletes both recompute it exactly instead of replaying
-- the pool's history.
--
-- One known gap: a settlement that charges no rent emits nothing. That
-- happens when no bid is live and none is pending, for example on
-- accrue(), a position update, or a rent collection on a closed pool. Then
-- the stored last_settled lags the contract's. It never changes which bid
-- holds the pool or its fee. It only feeds the quoter's settlement gas
-- estimate, which then assumes a settlement is still due.
--
-- continuous_auction_pool_keys lists the pools whose extension is the
-- configured ContinuousAuction deployment. It is filled at PoolInitialized,
-- as mev_capture_pool_keys is, and drives is_continuous_auction_pool, so a
-- pool with no bid yet is still flagged. The quoter then skips it as closed
-- instead of routing through it.
--
-- The state table feeds pool_last_event_id like the other five state
-- tables, so every bid update and settlement moves the pool's last_event_id
-- and the quoter re-syncs it.
--
-- Deploy: CREATE TRIGGER on the new tables does not conflict with workers.
-- CREATE OR REPLACE VIEW and the pool_last_event_id function swap do not
-- either, but park the workers anyway, as 00123 does. That keeps
-- recompute_pool_last_event_id from running half-replaced mid-transaction.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE continuous_auction_pool_keys
(
    pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id)
);

CREATE TABLE continuous_auction_bid_updated
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
    locker            NUMERIC NOT NULL,
    salt              NUMERIC NOT NULL,
    -- keccak256(abi.encode(locker, salt)), ContinuousAuctionLib.bidderId
    bidder            NUMERIC NOT NULL,
    -- bid token base units per second; zero removes the locker's scheduled bid
    rate              NUMERIC NOT NULL,
    -- unix seconds
    bid_start         int8    NOT NULL,
    bid_end           int8    NOT NULL,
    executor          NUMERIC NOT NULL,
    -- 0.32 fixed-point fraction
    fee               int8    NOT NULL,
    delta             NUMERIC NOT NULL,

    -- The pool's schedule right after this update, set by
    -- trg_continuous_auction_bid_updated_schedule. NULL only when the pool is
    -- unknown (pool_key_id IS NULL). next_* are NULL when no bid is pending.
    current_bidder    NUMERIC,
    current_rate      NUMERIC,
    current_executor  NUMERIC,
    current_start     int8,
    current_end       int8,
    current_fee       int8,
    next_bidder       NUMERIC,
    next_rate         NUMERIC,
    next_executor     NUMERIC,
    next_start        int8,
    next_end          int8,
    next_fee          int8,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON continuous_auction_bid_updated (chain_id, block_number);
CREATE INDEX ON continuous_auction_bid_updated (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_continuous_auction_bid_updated
    BEFORE UPDATE
    ON continuous_auction_bid_updated
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE continuous_auction_rent_settled
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
    amount            NUMERIC NOT NULL,
    -- true for RentAccrued, false for RentUnallocated (no active liquidity)
    allocated         bool    NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON continuous_auction_rent_settled (chain_id, block_number);
CREATE INDEX ON continuous_auction_rent_settled (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_continuous_auction_rent_settled
    BEFORE UPDATE
    ON continuous_auction_rent_settled
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE continuous_auction_pool_states
(
    pool_key_id                int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    -- ContinuousAuction.auctions(poolId).current; all zero before the first
    -- bid activates
    current_bidder             NUMERIC NOT NULL,
    current_rate               NUMERIC NOT NULL,
    current_executor           NUMERIC NOT NULL,
    current_start              int8    NOT NULL,
    current_end                int8    NOT NULL,
    current_fee                int8    NOT NULL,
    -- ContinuousAuction.auctions(poolId).next; NULL when next.bidder == 0
    next_bidder                NUMERIC,
    next_rate                  NUMERIC,
    next_executor              NUMERIC,
    next_start                 int8,
    next_end                   int8,
    next_fee                   int8,
    -- unix seconds; see the header for when it lags the contract
    last_settled               int8    NOT NULL,
    last_bid_updated_event_id  int8,
    last_rent_settled_event_id int8,
    last_event_id              int8    NOT NULL
) WITH (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

-- ContinuousAuction._accrue for the schedule part: the first settlement in a
-- later second activates the pending bid and moves lastSettled.
CREATE FUNCTION continuous_auction_settle(s continuous_auction_pool_states, p_time int8)
    RETURNS continuous_auction_pool_states
    LANGUAGE plpgsql
    IMMUTABLE AS
$$
BEGIN
    IF p_time <= s.last_settled THEN
        RETURN s;
    END IF;

    IF s.next_bidder IS NOT NULL THEN
        s.current_bidder := s.next_bidder;
        s.current_rate := s.next_rate;
        s.current_executor := s.next_executor;
        s.current_start := s.next_start;
        s.current_end := s.next_end;
        s.current_fee := s.next_fee;
        s.next_bidder := NULL;
        s.next_rate := NULL;
        s.next_executor := NULL;
        s.next_start := NULL;
        s.next_end := NULL;
        s.next_fee := NULL;
    END IF;

    s.last_settled := p_time;
    RETURN s;
END
$$;

-- The pool's schedule from its events with event_id below p_before_event_id
-- (all of them when NULL), or NULL when there are none: the latest bid
-- update's stored schedule, settled at the latest rent event after it.
CREATE FUNCTION continuous_auction_schedule_before(p_pool_key_id int8, p_before_event_id int8)
    RETURNS continuous_auction_pool_states
    LANGUAGE plpgsql
    STABLE AS
$$
DECLARE
    s               continuous_auction_pool_states;
    v_bid           continuous_auction_bid_updated%ROWTYPE;
    v_bid_time      int8;
    v_rent_event_id int8;
    v_rent_time     int8;
BEGIN
    SELECT bu.*
    INTO v_bid
    FROM continuous_auction_bid_updated bu
    WHERE bu.pool_key_id = p_pool_key_id
      AND (p_before_event_id IS NULL OR bu.event_id < p_before_event_id)
    ORDER BY bu.event_id DESC
    LIMIT 1;

    SELECT rs.event_id, EXTRACT(EPOCH FROM b.block_time)::int8
    INTO v_rent_event_id, v_rent_time
    FROM continuous_auction_rent_settled rs
             JOIN blocks b ON b.chain_id = rs.chain_id AND b.block_number = rs.block_number
    WHERE rs.pool_key_id = p_pool_key_id
      AND (p_before_event_id IS NULL OR rs.event_id < p_before_event_id)
    ORDER BY rs.event_id DESC
    LIMIT 1;

    IF v_bid.event_id IS NULL AND v_rent_event_id IS NULL THEN
        RETURN NULL;
    END IF;

    s.pool_key_id := p_pool_key_id;

    IF v_bid.event_id IS NULL THEN
        s.current_bidder := 0;
        s.current_rate := 0;
        s.current_executor := 0;
        s.current_start := 0;
        s.current_end := 0;
        s.current_fee := 0;
        s.last_settled := 0;
    ELSE
        SELECT EXTRACT(EPOCH FROM b.block_time)::int8
        INTO STRICT v_bid_time
        FROM blocks b
        WHERE b.chain_id = v_bid.chain_id
          AND b.block_number = v_bid.block_number;

        s.current_bidder := v_bid.current_bidder;
        s.current_rate := v_bid.current_rate;
        s.current_executor := v_bid.current_executor;
        s.current_start := v_bid.current_start;
        s.current_end := v_bid.current_end;
        s.current_fee := v_bid.current_fee;
        s.next_bidder := v_bid.next_bidder;
        s.next_rate := v_bid.next_rate;
        s.next_executor := v_bid.next_executor;
        s.next_start := v_bid.next_start;
        s.next_end := v_bid.next_end;
        s.next_fee := v_bid.next_fee;
        -- _updateBid settles before it changes anything
        s.last_settled := v_bid_time;
        s.last_bid_updated_event_id := v_bid.event_id;
    END IF;

    IF v_rent_event_id > COALESCE(v_bid.event_id, -9223372036854775807::int8) THEN
        s := continuous_auction_settle(s, v_rent_time);
    END IF;

    s.last_rent_settled_event_id := v_rent_event_id;
    s.last_event_id := GREATEST(v_bid.event_id, v_rent_event_id);
    RETURN s;
END
$$;

-- ContinuousAuction._updateBid for the schedule part, applied to the
-- schedule as of the previous event. Mirrors the contract step by step.
CREATE FUNCTION trg_continuous_auction_bid_updated_schedule()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
DECLARE
    s             continuous_auction_pool_states;
    v_time        int8;
    v_has_next    bool;
    v_own_next    bool;
    v_own_current bool;
BEGIN
    IF NEW.pool_key_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT EXTRACT(EPOCH FROM b.block_time)::int8
    INTO STRICT v_time
    FROM blocks b
    WHERE b.chain_id = NEW.chain_id
      AND b.block_number = NEW.block_number;

    -- event_id is a stored generated column, so it is not computed yet here
    s := continuous_auction_schedule_before(
            NEW.pool_key_id,
            compute_event_id(NEW.block_number, NEW.transaction_index, NEW.event_index)
         );

    IF s.pool_key_id IS NULL THEN
        s.current_bidder := 0;
        s.current_rate := 0;
        s.current_executor := 0;
        s.current_start := 0;
        s.current_end := 0;
        s.current_fee := 0;
        s.last_settled := 0;
    END IF;

    -- _accrue runs first
    s := continuous_auction_settle(s, v_time);

    v_has_next := s.next_bidder IS NOT NULL;
    v_own_next := v_has_next AND s.next_bidder = NEW.bidder;
    -- the current bid still covers the new start
    v_own_current := s.current_end > NEW.bid_start AND s.current_bidder = NEW.bidder;

    -- a next bid is replaced by its owner, or displaced by anyone else's new bid
    IF v_own_next OR (v_has_next AND NEW.rate <> 0) THEN
        s.next_bidder := NULL;
        s.next_rate := NULL;
        s.next_executor := NULL;
        s.next_start := NULL;
        s.next_end := NULL;
        s.next_fee := NULL;
    END IF;

    -- shortening your own current bid ends it at the new start
    IF v_own_current THEN
        s.current_end := NEW.bid_start;
    END IF;

    IF NEW.rate <> 0 THEN
        s.next_bidder := NEW.bidder;
        s.next_rate := NEW.rate;
        s.next_executor := NEW.executor;
        s.next_start := NEW.bid_start;
        s.next_end := NEW.bid_end;
        s.next_fee := NEW.fee;
    END IF;

    NEW.current_bidder := s.current_bidder;
    NEW.current_rate := s.current_rate;
    NEW.current_executor := s.current_executor;
    NEW.current_start := s.current_start;
    NEW.current_end := s.current_end;
    NEW.current_fee := s.current_fee;
    NEW.next_bidder := s.next_bidder;
    NEW.next_rate := s.next_rate;
    NEW.next_executor := s.next_executor;
    NEW.next_start := s.next_start;
    NEW.next_end := s.next_end;
    NEW.next_fee := s.next_fee;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_continuous_auction_bid_updated_schedule
    BEFORE INSERT
    ON continuous_auction_bid_updated
    FOR EACH ROW
EXECUTE FUNCTION trg_continuous_auction_bid_updated_schedule();

-- Exact recompute of one pool's state from its events; also the repair tool.
CREATE FUNCTION recompute_continuous_auction_pool_state(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql AS
$$
DECLARE
    s continuous_auction_pool_states;
BEGIN
    s := continuous_auction_schedule_before(p_pool_key_id, NULL);

    IF s.pool_key_id IS NULL THEN
        DELETE FROM continuous_auction_pool_states WHERE pool_key_id = p_pool_key_id;
        RETURN;
    END IF;

    INSERT INTO continuous_auction_pool_states
    SELECT s.*
    ON CONFLICT (pool_key_id) DO UPDATE
        SET current_bidder             = EXCLUDED.current_bidder,
            current_rate               = EXCLUDED.current_rate,
            current_executor           = EXCLUDED.current_executor,
            current_start              = EXCLUDED.current_start,
            current_end                = EXCLUDED.current_end,
            current_fee                = EXCLUDED.current_fee,
            next_bidder                = EXCLUDED.next_bidder,
            next_rate                  = EXCLUDED.next_rate,
            next_executor              = EXCLUDED.next_executor,
            next_start                 = EXCLUDED.next_start,
            next_end                   = EXCLUDED.next_end,
            next_fee                   = EXCLUDED.next_fee,
            last_settled               = EXCLUDED.last_settled,
            last_bid_updated_event_id  = EXCLUDED.last_bid_updated_event_id,
            last_rent_settled_event_id = EXCLUDED.last_rent_settled_event_id,
            last_event_id              = EXCLUDED.last_event_id;
END
$$;

CREATE FUNCTION trg_continuous_auction_pool_state()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
DECLARE
    v_pool_key_id int8 := CASE WHEN TG_OP = 'DELETE' THEN OLD.pool_key_id ELSE NEW.pool_key_id END;
BEGIN
    IF v_pool_key_id IS NOT NULL THEN
        PERFORM recompute_continuous_auction_pool_state(v_pool_key_id);
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_continuous_auction_bid_updated_pool_state
    AFTER INSERT OR DELETE
    ON continuous_auction_bid_updated
    FOR EACH ROW
EXECUTE FUNCTION trg_continuous_auction_pool_state();

CREATE TRIGGER trg_continuous_auction_rent_settled_pool_state
    AFTER INSERT OR DELETE
    ON continuous_auction_rent_settled
    FOR EACH ROW
EXECUTE FUNCTION trg_continuous_auction_pool_state();

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
                    vps.last_event_id, caps.last_event_id)
    FROM pool_keys pk
             JOIN pool_states ps USING (pool_key_id)
             LEFT JOIN twamm_pool_states tps ON tps.pool_key_id = pk.pool_key_id
             LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
             LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
             LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
             LEFT JOIN continuous_auction_pool_states caps ON caps.pool_key_id = pk.pool_key_id
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

CREATE TRIGGER continuous_auction_pool_states_maintain_pool_last_event_id
    AFTER INSERT OR DELETE
    ON continuous_auction_pool_states
    FOR EACH ROW
EXECUTE FUNCTION trg_pool_last_event_id();

CREATE TRIGGER continuous_auction_pool_states_maintain_pool_last_event_id_upd
    AFTER UPDATE OF last_event_id
    ON continuous_auction_pool_states
    FOR EACH ROW
    WHEN (OLD.last_event_id IS DISTINCT FROM NEW.last_event_id)
EXECUTE FUNCTION trg_pool_last_event_id();

-- The view, verbatim from 00123 with the auction columns appended (CREATE OR
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

       -- continuous auction state: unix seconds, fees as 0.32 fractions
       caps.current_start                                        AS continuous_auction_current_bid_start,
       caps.current_end                                          AS continuous_auction_current_bid_end,
       caps.current_fee                                          AS continuous_auction_current_bid_fee,
       caps.next_start                                           AS continuous_auction_next_bid_start,
       caps.next_end                                             AS continuous_auction_next_bid_end,
       caps.next_fee                                             AS continuous_auction_next_bid_fee,
       caps.last_settled                                         AS continuous_auction_last_settled,
       -- only the auction emits bid events, so a state row also identifies
       -- one whose PoolInitialized predates the address being configured
       (capk.pool_key_id IS NOT NULL OR caps.pool_key_id IS NOT NULL)
                                                                  AS is_continuous_auction_pool
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
         LEFT JOIN continuous_auction_pool_states caps ON caps.pool_key_id = pk.pool_key_id
         LEFT JOIN continuous_auction_pool_keys capk ON capk.pool_key_id = pk.pool_key_id;
