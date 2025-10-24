CREATE VIEW pool_states_view AS (
    WITH lss AS (
        SELECT id AS pool_key_id,
            COALESCE(
                last_swap.pool_balance_change_id,
                pi.event_id
            ) AS last_swap_event_id,
            COALESCE(last_swap.sqrt_ratio_after, pi.sqrt_ratio) AS sqrt_ratio,
            COALESCE(last_swap.tick_after, pi.tick) AS tick,
            COALESCE(last_swap.liquidity_after, 0) AS liquidity_last
        FROM pool_keys
            LEFT JOIN LATERAL (
                SELECT pool_balance_change_id,
                    sqrt_ratio_after,
                    tick_after,
                    liquidity_after
                FROM swaps s
                    JOIN pool_balance_change_event pbc on s.chain_id = pbc.chain_id
                    and s.pool_balance_change_id = pbc.event_id
                WHERE pool_keys.id = pbc.pool_key_id
                ORDER BY pool_balance_change_id DESC
                LIMIT 1
            ) AS last_swap ON TRUE
            LEFT JOIN LATERAL (
                SELECT event_id,
                    sqrt_ratio,
                    tick
                FROM pool_initializations
                WHERE pool_initializations.pool_key_id = pool_keys.id
            ) AS pi ON TRUE
    ),
    pl AS (
        SELECT pool_key_id,
            (
                SELECT pool_balance_change_id
                FROM position_updates pu
                    JOIN pool_balance_change_event pbc on pu.chain_id = pbc.chain_id
                    and pu.pool_balance_change_id = pbc.event_id
                WHERE lss.pool_key_id = pbc.pool_key_id
                ORDER BY pool_balance_change_id DESC
                LIMIT 1
            ) AS last_update_event_id,
            (
                COALESCE(liquidity_last, 0) + COALESCE(
                    (
                        SELECT SUM(liquidity_delta)
                        FROM position_updates AS pu
                            JOIN pool_balance_change_event pbc on pu.chain_id = pbc.chain_id
                            and pu.pool_balance_change_id = pbc.event_id
                        WHERE lss.last_swap_event_id < pu.pool_balance_change_id
                            AND pbc.pool_key_id = lss.pool_key_id
                            AND lss.tick BETWEEN pu.lower_bound AND (pu.upper_bound - 1)
                    ),
                    0
                )
            ) AS liquidity
        FROM lss
    )
    SELECT lss.pool_key_id,
        sqrt_ratio,
        tick,
        liquidity,
        GREATEST(lss.last_swap_event_id, pl.last_update_event_id) AS last_event_id,
        pl.last_update_event_id AS last_liquidity_update_event_id
    FROM lss
        JOIN pl ON lss.pool_key_id = pl.pool_key_id
);
CREATE MATERIALIZED VIEW pool_states_materialized AS (
    SELECT pool_key_id,
        last_event_id,
        last_liquidity_update_event_id,
        sqrt_ratio,
        liquidity,
        tick
    FROM pool_states_view
);
CREATE UNIQUE INDEX idx_pool_states_materialized_pool_key_id ON pool_states_materialized USING btree (pool_key_id);