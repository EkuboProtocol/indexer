CREATE TABLE ve33_pool_states
(
    pool_key_id                                int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    pool_total_vote_weight                    NUMERIC     NOT NULL,
    swap_fee                                  NUMERIC     NOT NULL,
    last_vote_weight_applied_event_id         int8,
    last_pool_fees_accounted_event_id         int8,
    last_pool_fees_accounted_block_timestamp  timestamptz,
    last_pool_fees_accounted_amount0          NUMERIC,
    last_pool_fees_accounted_amount1          NUMERIC,
    total_pool_fees_accounted0                NUMERIC     NOT NULL,
    total_pool_fees_accounted1                NUMERIC     NOT NULL,
    last_pool_emissions_accrued_event_id      int8,
    last_pool_emissions_accrued_block_timestamp timestamptz,
    last_pool_emissions_accrued_amount        NUMERIC,
    total_pool_emissions_accrued              NUMERIC     NOT NULL,
    last_event_id                             int8        NOT NULL
);

CREATE FUNCTION recompute_ve33_pool_state(p_pool_key_id int8)
    RETURNS VOID
    LANGUAGE plpgsql AS
$$
DECLARE
    v_last_vote_event_id                int8;
    v_swap_fee                          NUMERIC;
    v_pool_total_vote_weight            NUMERIC;

    v_last_pool_fees_accounted_event_id int8;
    v_last_pool_fees_accounted_time     timestamptz;
    v_last_pool_fees_accounted_amount0  NUMERIC;
    v_last_pool_fees_accounted_amount1  NUMERIC;
    v_total_pool_fees_accounted0        NUMERIC;
    v_total_pool_fees_accounted1        NUMERIC;

    v_last_pool_emissions_event_id      int8;
    v_last_pool_emissions_time          timestamptz;
    v_last_pool_emissions_amount        NUMERIC;
    v_total_pool_emissions_accrued      NUMERIC;

    v_last_event_id                     int8;
BEGIN
    SELECT vwa.event_id,
           vwa.swap_fee
    INTO v_last_vote_event_id,
        v_swap_fee
    FROM ve33_vote_weight_applied vwa
    WHERE vwa.pool_key_id = p_pool_key_id
    ORDER BY vwa.event_id DESC
    LIMIT 1;

    WITH latest_votes AS (
        SELECT DISTINCT ON (vwa.chain_id, vwa.emitter, vwa.owner, vwa.stake_id, vwa.pool_id)
               vwa.weight,
               vwa.event_id
        FROM ve33_vote_weight_applied vwa
        WHERE vwa.pool_key_id = p_pool_key_id
        ORDER BY vwa.chain_id,
                 vwa.emitter,
                 vwa.owner,
                 vwa.stake_id,
                 vwa.pool_id,
                 vwa.event_id DESC
    )
    SELECT COALESCE(SUM(weight), 0)
    INTO v_pool_total_vote_weight
    FROM latest_votes;

    SELECT pfa.event_id,
           b.block_time,
           pfa.amount0,
           pfa.amount1
    INTO v_last_pool_fees_accounted_event_id,
        v_last_pool_fees_accounted_time,
        v_last_pool_fees_accounted_amount0,
        v_last_pool_fees_accounted_amount1
    FROM ve33_pool_fees_accounted pfa
             JOIN blocks b
                  ON b.chain_id = pfa.chain_id AND b.block_number = pfa.block_number
    WHERE pfa.pool_key_id = p_pool_key_id
    ORDER BY pfa.event_id DESC
    LIMIT 1;

    SELECT COALESCE(SUM(amount0), 0),
           COALESCE(SUM(amount1), 0)
    INTO v_total_pool_fees_accounted0,
        v_total_pool_fees_accounted1
    FROM ve33_pool_fees_accounted
    WHERE pool_key_id = p_pool_key_id;

    SELECT pea.event_id,
           b.block_time,
           pea.amount
    INTO v_last_pool_emissions_event_id,
        v_last_pool_emissions_time,
        v_last_pool_emissions_amount
    FROM ve33_pool_emissions_accrued pea
             JOIN blocks b
                  ON b.chain_id = pea.chain_id AND b.block_number = pea.block_number
    WHERE pea.pool_key_id = p_pool_key_id
    ORDER BY pea.event_id DESC
    LIMIT 1;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_pool_emissions_accrued
    FROM ve33_pool_emissions_accrued
    WHERE pool_key_id = p_pool_key_id;

    v_last_event_id := GREATEST(
            v_last_vote_event_id,
            v_last_pool_fees_accounted_event_id,
            v_last_pool_emissions_event_id
                       );

    IF v_last_event_id IS NULL THEN
        DELETE FROM ve33_pool_states WHERE pool_key_id = p_pool_key_id;
        RETURN;
    END IF;

    INSERT INTO ve33_pool_states AS s (
        pool_key_id,
        pool_total_vote_weight,
        swap_fee,
        last_vote_weight_applied_event_id,
        last_pool_fees_accounted_event_id,
        last_pool_fees_accounted_block_timestamp,
        last_pool_fees_accounted_amount0,
        last_pool_fees_accounted_amount1,
        total_pool_fees_accounted0,
        total_pool_fees_accounted1,
        last_pool_emissions_accrued_event_id,
        last_pool_emissions_accrued_block_timestamp,
        last_pool_emissions_accrued_amount,
        total_pool_emissions_accrued,
        last_event_id
    )
    VALUES (
        p_pool_key_id,
        v_pool_total_vote_weight,
        COALESCE(v_swap_fee, 0),
        v_last_vote_event_id,
        v_last_pool_fees_accounted_event_id,
        v_last_pool_fees_accounted_time,
        v_last_pool_fees_accounted_amount0,
        v_last_pool_fees_accounted_amount1,
        v_total_pool_fees_accounted0,
        v_total_pool_fees_accounted1,
        v_last_pool_emissions_event_id,
        v_last_pool_emissions_time,
        v_last_pool_emissions_amount,
        v_total_pool_emissions_accrued,
        v_last_event_id
    )
    ON CONFLICT (pool_key_id) DO UPDATE
        SET pool_total_vote_weight                       = EXCLUDED.pool_total_vote_weight,
            swap_fee                                     = EXCLUDED.swap_fee,
            last_vote_weight_applied_event_id            = EXCLUDED.last_vote_weight_applied_event_id,
            last_pool_fees_accounted_event_id            = EXCLUDED.last_pool_fees_accounted_event_id,
            last_pool_fees_accounted_block_timestamp     = EXCLUDED.last_pool_fees_accounted_block_timestamp,
            last_pool_fees_accounted_amount0             = EXCLUDED.last_pool_fees_accounted_amount0,
            last_pool_fees_accounted_amount1             = EXCLUDED.last_pool_fees_accounted_amount1,
            total_pool_fees_accounted0                   = EXCLUDED.total_pool_fees_accounted0,
            total_pool_fees_accounted1                   = EXCLUDED.total_pool_fees_accounted1,
            last_pool_emissions_accrued_event_id         = EXCLUDED.last_pool_emissions_accrued_event_id,
            last_pool_emissions_accrued_block_timestamp  = EXCLUDED.last_pool_emissions_accrued_block_timestamp,
            last_pool_emissions_accrued_amount           = EXCLUDED.last_pool_emissions_accrued_amount,
            total_pool_emissions_accrued                 = EXCLUDED.total_pool_emissions_accrued,
            last_event_id                                = EXCLUDED.last_event_id;
END
$$;

CREATE FUNCTION trg_ve33_pool_state_recompute()
    RETURNS TRIGGER
    LANGUAGE plpgsql AS
$$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.pool_key_id IS NOT NULL THEN
            PERFORM recompute_ve33_pool_state(NEW.pool_key_id);
        END IF;
    ELSE
        IF OLD.pool_key_id IS NOT NULL THEN
            PERFORM recompute_ve33_pool_state(OLD.pool_key_id);
        END IF;
    END IF;

    RETURN NULL;
END
$$;

CREATE TRIGGER trg_ve33_vote_weight_applied_pool_state
    AFTER INSERT OR DELETE
    ON ve33_vote_weight_applied
    FOR EACH ROW
EXECUTE FUNCTION trg_ve33_pool_state_recompute();

CREATE TRIGGER trg_ve33_pool_fees_accounted_pool_state
    AFTER INSERT OR DELETE
    ON ve33_pool_fees_accounted
    FOR EACH ROW
EXECUTE FUNCTION trg_ve33_pool_state_recompute();

CREATE TRIGGER trg_ve33_pool_emissions_accrued_pool_state
    AFTER INSERT OR DELETE
    ON ve33_pool_emissions_accrued
    FOR EACH ROW
EXECUTE FUNCTION trg_ve33_pool_state_recompute();

DROP VIEW IF EXISTS all_pool_states_view;

CREATE VIEW all_pool_states_view AS
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
       GREATEST(ps.last_event_id, tps.last_event_id, bps.last_event_id, lops.last_event_id,
                vps.last_event_id)                             AS last_event_id,
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
         LEFT JOIN ve33_pool_states vps ON vps.pool_key_id = pk.pool_key_id;

SELECT recompute_ve33_pool_state(pool_key_id)
FROM (
    SELECT pool_key_id
    FROM ve33_vote_weight_applied
    WHERE pool_key_id IS NOT NULL
    UNION
    SELECT pool_key_id
    FROM ve33_pool_fees_accounted
    WHERE pool_key_id IS NOT NULL
    UNION
    SELECT pool_key_id
    FROM ve33_pool_emissions_accrued
    WHERE pool_key_id IS NOT NULL
) AS ve33_pools;
