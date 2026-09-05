-- Make the quoter's pool-state poll indexable on last_event_id.
--
-- Measured on ekubo-db-nyc1 on 2026-09-05, after #171/#173.
--
-- The single largest consumer of CPU on the instance is quoter-service's
-- pool-state sync: every 5 seconds, per chain, it runs
--
--     SELECT ... FROM all_pool_states_view
--     WHERE chain_id = $1 AND core_address = $2 AND last_event_id > $3 AND (...)
--
-- 3,048,876 calls over 10 days at 96.8 ms and 112,558 buffers each; in a
-- 10-minute steady-state sample it was 5.85% of the 4-vCPU box on its own, at
-- 2.4 calls/s -- more than every remaining cron job combined. The predicate is
-- incremental in intent: $3 is the quoter's watermark, and almost every poll
-- should match a handful of pools or none.
--
-- It cannot be incremental in execution, because the view defines
--
--     GREATEST(ps.last_event_id, tps.last_event_id, bps.last_event_id,
--              lops.last_event_id, vps.last_event_id) AS last_event_id
--
-- across five state tables. EXPLAIN shows that predicate as a top-level Filter
-- on the joined row: nothing can index a GREATEST over five relations, so each
-- poll walks every pool on the chain through the ~10 side-table probes the
-- view joins (pool_states, twamm, oracle, spline, limit-order, ve33, boosted
-- fees, tvl, tokens, prices) and only then discards the unchanged ones. The
-- per-pool jsonb aggregates (ticks, twamm_orders, donations) run only for
-- survivors, so the cost is the join-and-filter itself: ~1,500 pools x ~10
-- probes x a few buffers each, every 5 s, on every chain.
--
-- The fix stores that GREATEST. pool_last_event_id holds one row per pool
-- with the value, kept exact by row triggers on the five state tables, and
-- the view's last_event_id column now reads from it through an inner join.
-- chain_id and core_address are denormalised onto it (both immutable per
-- pool) so that the index (chain_id, core_address, last_event_id) can drive
-- the plan: the quoter's WHERE lands on pool_keys' columns, equivalence
-- through the join carries it to plei's, and `last_event_id > $3` becomes an
-- index range scan that yields only the changed pools. Everything else in
-- the view then joins for those pools alone.
--
-- The view keeps its column list, names, order and types, so this is
-- CREATE OR REPLACE and neither quoter-service nor the API changes.
--
-- Correctness notes.
--
-- * The trigger recomputes the GREATEST from the five sources rather than
--   taking a running max, so it is exact under reorgs: when a fork is
--   discarded, cascades remove events, the state functions rewrite the state
--   rows with lower last_event_ids, and the stored value follows them down.
--   The quoter already handles that via fork_counter.
-- * Membership matches the view's existing inner join on pool_states: a pool
--   has a pool_last_event_id row exactly while it has a pool_states row.
-- * last_event_id is indexed and changes on every state write, so updates
--   cannot be HOT; the table is ~5,000 rows, and fillfactor plus an
--   aggressive autovacuum scale factor keep it compact, the same treatment
--   00119 gave pool_states.
--
-- Deploy: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on all five state tables,
-- which workers hold ROW EXCLUSIVE on mid-transaction -- the lock-ordering
-- deadlock #173 fixed. Parking the workers by locking blocks first is what
-- makes that safe; it stays the first statement.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE pool_last_event_id
(
    pool_key_id   int8    PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    chain_id      int8    NOT NULL,
    core_address  NUMERIC NOT NULL,
    last_event_id int8    NOT NULL
) WITH (autovacuum_vacuum_scale_factor = 0.01, fillfactor = 70);

CREATE INDEX pool_last_event_id_chain_id_core_address_last_event_id_idx
    ON pool_last_event_id (chain_id, core_address, last_event_id);

-- Exact recompute for one pool from the five state tables. Removes the row
-- when the pool no longer has a pool_states row, mirroring the view's inner
-- join.
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
                    vps.last_event_id)
    FROM pool_keys pk
             JOIN pool_states ps USING (pool_key_id)
             LEFT JOIN twamm_pool_states tps ON tps.pool_key_id = pk.pool_key_id
             LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
             LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
             LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
    WHERE pk.pool_key_id = p_pool_key_id
    ON CONFLICT (pool_key_id) DO UPDATE
        SET last_event_id = EXCLUDED.last_event_id
        WHERE pool_last_event_id.last_event_id IS DISTINCT FROM EXCLUDED.last_event_id;

    DELETE
    FROM pool_last_event_id
    WHERE pool_key_id = p_pool_key_id
      AND NOT EXISTS (SELECT 1 FROM pool_states ps WHERE ps.pool_key_id = p_pool_key_id);
END;
$$;

CREATE OR REPLACE FUNCTION trg_pool_last_event_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    PERFORM recompute_pool_last_event_id(COALESCE(NEW.pool_key_id, OLD.pool_key_id));
    RETURN NULL;
END;
$$;

-- One trigger per state table that feeds the GREATEST. UPDATE OF last_event_id
-- keeps writes to other columns (sqrt_ratio, liquidity, tick, ...) from
-- firing it.
DO
$$
    DECLARE
        state_table TEXT;
    BEGIN
        FOREACH state_table IN ARRAY ARRAY [
            'pool_states',
            'twamm_pool_states',
            'boosted_fees_pool_states',
            'limit_order_pool_states',
            've33_pool_states'
            ]
            LOOP
                EXECUTE FORMAT(
                        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OF last_event_id OR DELETE ON %I '
                            || 'FOR EACH ROW EXECUTE FUNCTION trg_pool_last_event_id()',
                        state_table || '_maintain_pool_last_event_id',
                        state_table
                        );
            END LOOP;
    END;
$$;

-- Seed every pool that is currently in the view.
INSERT INTO pool_last_event_id (pool_key_id, chain_id, core_address, last_event_id)
SELECT pk.pool_key_id,
       pk.chain_id,
       pk.core_address,
       GREATEST(ps.last_event_id, tps.last_event_id, bps.last_event_id, lops.last_event_id, vps.last_event_id)
FROM pool_keys pk
         JOIN pool_states ps USING (pool_key_id)
         LEFT JOIN twamm_pool_states tps ON tps.pool_key_id = pk.pool_key_id
         LEFT JOIN boosted_fees_pool_states bps ON bps.pool_key_id = pk.pool_key_id
         LEFT JOIN limit_order_pool_states lops ON lops.pool_key_id = pk.pool_key_id
         LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id
         -- Placed after the USING joins: another pool_key_id on the left side
         -- would make them ambiguous. It is an inner join on pk's columns, so
         -- the planner can still start from its index.
         JOIN pool_last_event_id plei ON plei.pool_key_id = pk.pool_key_id
                                     AND plei.chain_id = pk.chain_id
                                     AND plei.core_address = pk.core_address;

ANALYZE pool_last_event_id;

-- The view, verbatim from 00105 except for the last_event_id column and the
-- join that supplies it.
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
       (vps.pool_key_id IS NOT NULL)                             AS is_ve33_pool
FROM pool_keys pk
         JOIN pool_states ps USING (pool_key_id)
         LEFT JOIN pool_tvl pt USING (pool_key_id)
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
         -- Placed after the USING joins: another pool_key_id on the left side
         -- would make them ambiguous. It is an inner join on pk's columns, so
         -- the planner can still start from its index.
         JOIN pool_last_event_id plei ON plei.pool_key_id = pk.pool_key_id
                                     AND plei.chain_id = pk.chain_id
                                     AND plei.core_address = pk.core_address;
