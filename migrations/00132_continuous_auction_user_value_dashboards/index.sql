-- Per-chain user-value dashboards over the 00131 metrics.
--
-- Two grains for the same series, so Grafana/Dune can chart history and the
-- current state without reimplementing the derivations:
--
-- * continuous_auction_daily_metrics(chain, from, to): one row per pool per
--   UTC day overlapping [from, to), calling
--   continuous_auction_pool_metrics per day bucket.
-- * continuous_auction_trailing_24h_metrics(chain): one row per pool over
--   [head - 86400, head].
--
-- Derived columns (all ratios are NULL when their denominator is zero):
--
-- * access_share = live / observed. Usable access needs executability as
--   well, which 00131 only measures in rent (rent_paid_unexecutable), not in
--   seconds, so usable_access_share = access_share * (1 -
--   unexecutable_rent_share) is a labeled estimate: it applies the
--   rent-weighted unexecutable share to the time share, and counts
--   rent_paid_unresolved (tenures the monitor has not classified yet) as
--   usable. Pools whose monitor has never run report the unresolved amount
--   alongside so the estimate is never mistaken for a measurement.
-- * independent_share_of_gross = rent collected by independent (not
--   holder-linked) beneficiaries / gross rent paid. Collection lags payment,
--   so this compares cash delivered against cash asked in the same window
--   rather than settling per tenure.
-- * discarded_rent_share = (unallocated + position-change discards) / gross
--   rent settled, the same definition continuous_auction_alerts pages on.
--   Negative position-change discards (rounding dust absorbed by the
--   reconciliation) are floored at zero, matching the alerts.
--
-- No new tables and no locks on worker-written tables (CREATE FUNCTION
-- only), so the workers do not need to be parked.

CREATE FUNCTION continuous_auction_daily_metrics(p_chain_id int8, p_from int8, p_to int8)
    RETURNS TABLE
            (
                day_start                      int8,
                day_end                        int8,
                pool_key_id                    int8,
                token0                         NUMERIC,
                token1                         NUMERIC,
                observed_seconds               int8,
                live_seconds                   int8,
                closed_seconds                 int8,
                closed_streak_seconds          int8,
                access_share                   NUMERIC,
                unexecutable_rent_share        NUMERIC,
                usable_access_share            NUMERIC,
                gross_rent_paid                NUMERIC,
                net_rent_independent           NUMERIC,
                independent_share_of_gross     NUMERIC,
                rent_paid_unresolved           NUMERIC,
                rent_allocated                 NUMERIC,
                rent_unallocated               NUMERIC,
                rent_discarded_position_change NUMERIC,
                discarded_rent_share           NUMERIC,
                rent_collected                 NUMERIC,
                top_beneficiary_share          NUMERIC,
                fee_time_weighted              NUMERIC,
                fee_max                        NUMERIC,
                swap_fee_charges               int8,
                displacements_pending          int8,
                displacements_incumbent        int8,
                displacements_then_closed      int8
            )
    LANGUAGE sql
    STABLE
AS
$$
WITH head AS (SELECT EXTRACT(EPOCH FROM get_chain_head_time(p_chain_id))::int8 AS t),
     days AS (SELECT GREATEST(d, p_from) AS bucket_from,
                     LEAST(d + 86400, h.t, p_to) AS bucket_to
              FROM head h,
                   GENERATE_SERIES((p_from / 86400) * 86400, LEAST(p_to, h.t) - 1, 86400) AS d
              WHERE d + 86400 > p_from AND d < LEAST(p_to, h.t)),
     m AS (SELECT d.bucket_from AS day_start,
                  d.bucket_to AS day_end,
                  pm.*
           FROM days d,
                LATERAL continuous_auction_pool_metrics(p_chain_id, d.bucket_from, d.bucket_to) pm
           WHERE pm.window_to > pm.window_from)
SELECT m.day_start,
       m.day_end,
       m.pool_key_id,
       pk.token0,
       pk.token1,
       m.observed_seconds,
       m.live_seconds,
       m.closed_seconds,
       m.closed_streak_seconds,
       m.live_seconds::NUMERIC / NULLIF(m.observed_seconds, 0),
       m.rent_paid_unexecutable / NULLIF(m.rent_paid, 0),
       (m.live_seconds::NUMERIC / NULLIF(m.observed_seconds, 0)) *
       (1 - COALESCE(m.rent_paid_unexecutable / NULLIF(m.rent_paid, 0), 0)),
       m.rent_paid,
       m.rent_collected_independent,
       m.rent_collected_independent / NULLIF(m.rent_paid, 0),
       m.rent_paid_unresolved,
       m.rent_allocated,
       m.rent_unallocated,
       m.rent_discarded_position_change,
       (m.rent_unallocated + GREATEST(COALESCE(m.rent_discarded_position_change, 0), 0)) /
       NULLIF(m.rent_allocated + m.rent_unallocated, 0),
       m.rent_collected,
       m.top_beneficiary_share,
       m.fee_time_weighted,
       m.fee_max,
       m.swap_fee_charges,
       m.displacements_pending,
       m.displacements_incumbent,
       m.displacements_then_closed
FROM m
         JOIN pool_keys pk ON pk.pool_key_id = m.pool_key_id
$$;

CREATE FUNCTION continuous_auction_trailing_24h_metrics(p_chain_id int8)
    RETURNS TABLE
            (
                window_from                    int8,
                window_to                      int8,
                pool_key_id                    int8,
                token0                         NUMERIC,
                token1                         NUMERIC,
                observed_seconds               int8,
                live_seconds                   int8,
                closed_seconds                 int8,
                closed_streak_seconds          int8,
                access_share                   NUMERIC,
                unexecutable_rent_share        NUMERIC,
                usable_access_share            NUMERIC,
                gross_rent_paid                NUMERIC,
                net_rent_independent           NUMERIC,
                independent_share_of_gross     NUMERIC,
                rent_paid_unresolved           NUMERIC,
                rent_allocated                 NUMERIC,
                rent_unallocated               NUMERIC,
                rent_discarded_position_change NUMERIC,
                discarded_rent_share           NUMERIC,
                rent_collected                 NUMERIC,
                top_beneficiary_share          NUMERIC,
                fee_time_weighted              NUMERIC,
                fee_max                        NUMERIC,
                swap_fee_charges               int8,
                displacements_pending          int8,
                displacements_incumbent        int8,
                displacements_then_closed      int8
            )
    LANGUAGE sql
    STABLE
AS
$$
WITH head AS (SELECT EXTRACT(EPOCH FROM get_chain_head_time(p_chain_id))::int8 AS t),
     m AS (SELECT pm.*
           FROM head h,
                LATERAL continuous_auction_pool_metrics(p_chain_id, h.t - 86400, h.t) pm
           WHERE pm.window_to > pm.window_from)
SELECT m.window_from,
       m.window_to,
       m.pool_key_id,
       pk.token0,
       pk.token1,
       m.observed_seconds,
       m.live_seconds,
       m.closed_seconds,
       m.closed_streak_seconds,
       m.live_seconds::NUMERIC / NULLIF(m.observed_seconds, 0),
       m.rent_paid_unexecutable / NULLIF(m.rent_paid, 0),
       (m.live_seconds::NUMERIC / NULLIF(m.observed_seconds, 0)) *
       (1 - COALESCE(m.rent_paid_unexecutable / NULLIF(m.rent_paid, 0), 0)),
       m.rent_paid,
       m.rent_collected_independent,
       m.rent_collected_independent / NULLIF(m.rent_paid, 0),
       m.rent_paid_unresolved,
       m.rent_allocated,
       m.rent_unallocated,
       m.rent_discarded_position_change,
       (m.rent_unallocated + GREATEST(COALESCE(m.rent_discarded_position_change, 0), 0)) /
       NULLIF(m.rent_allocated + m.rent_unallocated, 0),
       m.rent_collected,
       m.top_beneficiary_share,
       m.fee_time_weighted,
       m.fee_max,
       m.swap_fee_charges,
       m.displacements_pending,
       m.displacements_incumbent,
       m.displacements_then_closed
FROM m
         JOIN pool_keys pk ON pk.pool_key_id = m.pool_key_id
$$;
