-- Per-pool MEVCapture series: swap volume, base fee income, surcharge income,
-- active liquidity and first-touch swaps, in the same (chain, from, to) epoch
-- shape as the continuous auction dashboards.
--
-- * mev_capture_block_series(chain, from, to): one row per MEVCapture pool
--   per block with a swap in [from, to).
-- * mev_capture_daily_metrics(chain, from, to): one row per MEVCapture pool
--   per UTC day overlapping [from, to).
--
-- How the numbers are derived (evm-contracts src/extensions/MEVCapture.sol):
--
-- * Core's swap event is emitted before the extension adds its surcharge, so
--   swaps.delta0/delta1 are pre-surcharge amounts, and the surcharge is not in
--   any swap row. The extension keeps it in saved balances and donates it with
--   accumulateAsFees -- one fees_accumulated row -- at the pool's first touch
--   in a later timestamp. That donation holds exactly what the most recent
--   earlier swapping block accrued: every later-timestamp touch donates before
--   it swaps. So a fees_accumulated row is attributed to the block of the
--   pool's last swap before it. A donation whose predecessor swap is before
--   the scanned range is dropped rather than misattributed. Accruals from the
--   last swapping block before the head are reported as pending (NULL
--   surcharge), not zero.
-- * base_fee is the contractual pool fee on the input amount,
--   ceil(input * fee / fee_denominator), as Core charges it. Crossing ticks
--   rounds per step, so it can differ from Core's own sum by a few wei per
--   swap.
-- * tick_last is the tick at the block's first touch: the tick after the
--   pool's last swap before the block (or the initialization tick). Only swaps
--   move the tick, so this is what the extension stores.
-- * Active liquidity comes from swaps.liquidity_after. position_updates has no
--   state-after column, so liquidity changes between swaps are not reflected;
--   liquidity_before_first_swap is the value after the previous swap.
-- * first_touch_* is the first swap on the pool in the block by event order
--   (the pre-registered first-touch definition). transaction_hash is exposed
--   so priority fees and builder payments can be joined from chain data.
--
-- surcharge is NULL (pending) for a block whose donation has not been indexed
-- yet and 0 when the pool swapped again with no donation in between, so
-- recent rows can change as the next touch arrives.
--
-- CREATE FUNCTION only: no new tables or indexes and no locks on
-- worker-written tables, so the workers do not need to be parked.
--
-- Rollback: DROP FUNCTION mev_capture_daily_metrics(int8, int8, int8);
--           DROP FUNCTION mev_capture_block_series(int8, int8, int8);

CREATE FUNCTION mev_capture_block_series(p_chain_id int8, p_from int8, p_to int8)
    RETURNS TABLE
            (
                pool_key_id                 int8,
                block_number                int8,
                block_time                  timestamptz,
                swaps                       int8,
                amount_in0                  NUMERIC,
                amount_in1                  NUMERIC,
                amount_out0                 NUMERIC,
                amount_out1                 NUMERIC,
                base_fee0                   NUMERIC,
                base_fee1                   NUMERIC,
                surcharge0                  NUMERIC,
                surcharge1                  NUMERIC,
                surcharge_donation_block    int8,
                tick_last                   int4,
                tick_after_last_swap        int4,
                liquidity_before_first_swap NUMERIC,
                liquidity_after_last_swap   NUMERIC,
                first_touch_transaction_hash NUMERIC,
                first_touch_transaction_index int4,
                first_touch_event_index     int4,
                first_touch_locker          NUMERIC,
                first_touch_delta0          NUMERIC,
                first_touch_delta1          NUMERIC
            )
    LANGUAGE sql
    STABLE
AS
$$
WITH pools AS (SELECT pk.pool_key_id, pk.fee, pk.fee_denominator
               FROM mev_capture_pool_keys m
                        JOIN pool_keys pk USING (pool_key_id)
               WHERE pk.chain_id = p_chain_id),
     s AS (SELECT s.pool_key_id,
                  s.block_number,
                  s.block_time,
                  s.event_id,
                  s.transaction_hash,
                  s.transaction_index,
                  s.event_index,
                  s.locker,
                  s.delta0,
                  s.delta1,
                  s.tick_after,
                  s.liquidity_after,
                  CASE WHEN s.delta0 > 0 THEN DIV(s.delta0 * p.fee + p.fee_denominator - 1, p.fee_denominator) ELSE 0 END AS fee0,
                  CASE WHEN s.delta1 > 0 THEN DIV(s.delta1 * p.fee + p.fee_denominator - 1, p.fee_denominator) ELSE 0 END AS fee1,
                  ROW_NUMBER() OVER (PARTITION BY s.pool_key_id, s.block_number ORDER BY s.event_id) AS nth,
                  COUNT(*) OVER (PARTITION BY s.pool_key_id, s.block_number) AS swaps_in_block
           FROM swaps s
                    JOIN pools p USING (pool_key_id)
           WHERE s.chain_id = p_chain_id
             AND s.block_time >= TO_TIMESTAMP(p_from)
             AND s.block_time < TO_TIMESTAMP(p_to)),
     b AS (SELECT s.pool_key_id,
                  s.block_number,
                  MIN(s.block_time)                                    AS block_time,
                  COUNT(*)                                             AS swaps,
                  SUM(GREATEST(s.delta0, 0))                           AS amount_in0,
                  SUM(GREATEST(s.delta1, 0))                           AS amount_in1,
                  SUM(GREATEST(-s.delta0, 0))                          AS amount_out0,
                  SUM(GREATEST(-s.delta1, 0))                          AS amount_out1,
                  SUM(s.fee0)                                          AS base_fee0,
                  SUM(s.fee1)                                          AS base_fee1,
                  MIN(s.event_id)                                      AS first_event_id,
                  MAX(s.event_id)                                      AS last_event_id,
                  -- First-touch and last-swap fields are picked here rather
                  -- than by joining s back to itself: a self-join on the
                  -- materialized CTE merge-joins on pool_key_id alone, which
                  -- is quadratic in a pool's swaps.
                  MAX(s.transaction_hash) FILTER (WHERE s.nth = 1)     AS ft_transaction_hash,
                  MAX(s.transaction_index) FILTER (WHERE s.nth = 1)    AS ft_transaction_index,
                  MAX(s.event_index) FILTER (WHERE s.nth = 1)          AS ft_event_index,
                  MAX(s.locker) FILTER (WHERE s.nth = 1)               AS ft_locker,
                  MAX(s.delta0) FILTER (WHERE s.nth = 1)               AS ft_delta0,
                  MAX(s.delta1) FILTER (WHERE s.nth = 1)               AS ft_delta1,
                  MAX(s.tick_after) FILTER (WHERE s.nth = s.swaps_in_block)      AS lst_tick_after,
                  MAX(s.liquidity_after) FILTER (WHERE s.nth = s.swaps_in_block) AS lst_liquidity_after
           FROM s
           GROUP BY s.pool_key_id, s.block_number)
SELECT b.pool_key_id,
       b.block_number,
       b.block_time,
       b.swaps,
       b.amount_in0,
       b.amount_in1,
       b.amount_out0,
       b.amount_out1,
       b.base_fee0,
       b.base_fee1,
       CASE WHEN d.event_id IS NOT NULL THEN d.delta0 WHEN nxt.event_id IS NOT NULL THEN 0 END AS surcharge0,
       CASE WHEN d.event_id IS NOT NULL THEN d.delta1 WHEN nxt.event_id IS NOT NULL THEN 0 END AS surcharge1,
       d.block_number                                                                      AS surcharge_donation_block,
       COALESCE(prev.tick_after, init.tick)                                                AS tick_last,
       b.lst_tick_after                                                                    AS tick_after_last_swap,
       prev.liquidity_after                                                                AS liquidity_before_first_swap,
       b.lst_liquidity_after                                                               AS liquidity_after_last_swap,
       b.ft_transaction_hash,
       b.ft_transaction_index,
       b.ft_event_index,
       b.ft_locker,
       b.ft_delta0,
       b.ft_delta1
FROM b
         LEFT JOIN LATERAL (SELECT sw.tick_after, sw.liquidity_after
                            FROM swaps sw
                            WHERE sw.pool_key_id = b.pool_key_id
                              AND sw.event_id < b.first_event_id
                            ORDER BY sw.event_id DESC
                            LIMIT 1) prev ON TRUE
         LEFT JOIN LATERAL (SELECT pi.tick
                            FROM pool_initializations pi
                            WHERE pi.pool_key_id = b.pool_key_id
                            LIMIT 1) init ON TRUE
    -- The pool's next swap after this block, if any: a donation for this
    -- block's accrual must come before it.
         LEFT JOIN LATERAL (SELECT sw.event_id
                            FROM swaps sw
                            WHERE sw.pool_key_id = b.pool_key_id
                              AND sw.event_id > b.last_event_id
                            ORDER BY sw.event_id
                            LIMIT 1) nxt ON TRUE
         LEFT JOIN LATERAL (SELECT fa.event_id, fa.block_number, fa.delta0, fa.delta1
                            FROM fees_accumulated fa
                            WHERE fa.chain_id = p_chain_id
                              AND fa.pool_key_id = b.pool_key_id
                              AND fa.block_number > b.block_number
                              AND fa.event_id > b.last_event_id
                              AND (nxt.event_id IS NULL OR fa.event_id < nxt.event_id)
                            ORDER BY fa.event_id
                            LIMIT 1) d ON TRUE
$$;

CREATE FUNCTION mev_capture_daily_metrics(p_chain_id int8, p_from int8, p_to int8)
    RETURNS TABLE
            (
                day_start                     int8,
                day_end                       int8,
                pool_key_id                   int8,
                token0                        NUMERIC,
                token1                        NUMERIC,
                fee                           NUMERIC,
                fee_denominator               NUMERIC,
                tick_spacing                  int4,
                swaps                         int8,
                first_touch_swaps             int8,
                amount_in0                    NUMERIC,
                amount_in1                    NUMERIC,
                amount_out0                   NUMERIC,
                amount_out1                   NUMERIC,
                base_fee0                     NUMERIC,
                base_fee1                     NUMERIC,
                surcharge0                    NUMERIC,
                surcharge1                    NUMERIC,
                blocks_surcharge_pending      int8,
                liquidity_mean_over_swap_blocks NUMERIC,
                liquidity_last                NUMERIC
            )
    LANGUAGE sql
    STABLE
AS
$$
WITH days AS (SELECT GREATEST(d, p_from) AS bucket_from, LEAST(d + 86400, p_to) AS bucket_to
              FROM GENERATE_SERIES((p_from / 86400) * 86400, p_to - 1, 86400) AS d
              WHERE d + 86400 > p_from AND d < p_to),
     bs AS (SELECT (EXTRACT(EPOCH FROM b.block_time)::int8 / 86400) * 86400 AS day, b.*
            FROM mev_capture_block_series(p_chain_id, p_from, p_to) b),
     agg AS (SELECT bs.day,
                    bs.pool_key_id,
                    SUM(bs.swaps)::int8                                      AS swaps,
                    COUNT(*)                                                 AS first_touch_swaps,
                    SUM(bs.amount_in0)                                       AS amount_in0,
                    SUM(bs.amount_in1)                                       AS amount_in1,
                    SUM(bs.amount_out0)                                      AS amount_out0,
                    SUM(bs.amount_out1)                                      AS amount_out1,
                    SUM(bs.base_fee0)                                        AS base_fee0,
                    SUM(bs.base_fee1)                                        AS base_fee1,
                    COALESCE(SUM(bs.surcharge0), 0)                          AS surcharge0,
                    COALESCE(SUM(bs.surcharge1), 0)                          AS surcharge1,
                    COUNT(*) FILTER (WHERE bs.surcharge0 IS NULL)            AS blocks_surcharge_pending,
                    AVG(bs.liquidity_after_last_swap)                        AS liquidity_mean_over_swap_blocks,
                    (ARRAY_AGG(bs.liquidity_after_last_swap ORDER BY bs.block_number DESC))[1] AS liquidity_last
             FROM bs
             GROUP BY bs.day, bs.pool_key_id)
SELECT d.bucket_from,
       d.bucket_to,
       a.pool_key_id,
       pk.token0,
       pk.token1,
       pk.fee,
       pk.fee_denominator,
       pk.tick_spacing,
       a.swaps,
       a.first_touch_swaps,
       a.amount_in0,
       a.amount_in1,
       a.amount_out0,
       a.amount_out1,
       a.base_fee0,
       a.base_fee1,
       a.surcharge0,
       a.surcharge1,
       a.blocks_surcharge_pending,
       a.liquidity_mean_over_swap_blocks,
       a.liquidity_last
FROM days d
         JOIN agg a ON a.day = (d.bucket_from / 86400) * 86400
         JOIN pool_keys pk ON pk.pool_key_id = a.pool_key_id
ORDER BY d.bucket_from, a.pool_key_id
$$;
