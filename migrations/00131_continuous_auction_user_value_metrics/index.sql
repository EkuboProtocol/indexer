-- User-value metrics and alert inputs for ContinuousAuction pools.
--
-- Gross bids are not a user-value metric. What matters is how much rent
-- reaches LPs who are not the holder, how much paid access could actually be
-- used, what fees holders charge everyone else, how often holders are
-- displaced, and how much rent nobody receives. This migration derives those
-- from the events 00130 already indexes plus two more:
--
-- * continuous_auction_rent_collected: RentCollected, rent paid out to a
--   position.
-- * continuous_auction_swap_fee_charged: SwapFeeCharged, the holder's fee
--   taken from another swapper.
--
-- Everything else is a view or function over the event tables:
--
-- * continuous_auction_live_segments / continuous_auction_tenures: the
--   seconds each bid actually held the pool. Each bid update row stores the
--   schedule right after it (00130), and nothing changes who holds the pool
--   until the next bid update, so row i covers [t_i, t_i+1) and at most two
--   bids are live in it: current until next.start, then next. A tenure is
--   one bid, keyed by (bidder, bid_start), since every bid starts one second
--   after its update.
-- * continuous_auction_displacements: a pending bid replaced by another
--   bidder (credited in full, never live), and a live bid cut short at the
--   activation of another bidder's bid (credited its tail).
-- * continuous_auction_rent_collections: collections with the beneficiary
--   (the NFT owner at the time when the owner is a positions contract) and
--   whether it is linked to a holder of that pool, i.e. is any locker or
--   executor that ever bid on it. On-chain addresses are accounting
--   identities, not principals, and transaction senders are not indexed, so
--   "independent" is an upper bound on rent to independent LPs.
--   continuous_auction_pool_metrics also reports the largest beneficiary's
--   share, which catches self-rent through unlinked addresses.
--
-- Two inputs need data the event stream cannot give, and are written by
-- scripts/continuousAuctionMonitor.ts rather than by the indexer:
--
-- * continuous_auction_tenure_executability: whether any block has a
--   timestamp inside the tenure. A paid second is not an executable block;
--   the indexer only sees blocks with events, so this needs block headers.
-- * continuous_auction_rent_reconciliations: rent discarded by nonzero
--   liquidity changes. The contract resets the position's snapshot without
--   paying it and emits nothing, so it is measured as
--   allocated - collected - claimable at one block, with claimable read from
--   getPositionRent. The difference also absorbs rounding dust.
--
-- continuous_auction_alerts evaluates continuous_auction_alert_thresholds
-- (one row per chain, chain_id 0 as the default) against the trailing window
-- and returns one row per firing alert.
--
-- Deploy: the foreign keys to blocks take SHARE ROW EXCLUSIVE on it, so park
-- the workers first, as 00130 does.

SET LOCAL lock_timeout = '15min';

LOCK TABLE blocks IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE continuous_auction_rent_collected
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
    -- the Core position owner: a positions contract, or the locker itself
    owner             NUMERIC NOT NULL,
    position_id       NUMERIC NOT NULL,
    -- positions contracts use the NFT id as the salt
    salt              NUMERIC NOT NULL,
    lower_bound       int4    NOT NULL,
    upper_bound       int4    NOT NULL,
    -- bid token base units
    amount            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON continuous_auction_rent_collected (chain_id, block_number);
CREATE INDEX ON continuous_auction_rent_collected (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_continuous_auction_rent_collected
    BEFORE UPDATE
    ON continuous_auction_rent_collected
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

CREATE TABLE continuous_auction_swap_fee_charged
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
    bidder            NUMERIC NOT NULL,
    -- pool token base units
    amount0           NUMERIC NOT NULL,
    amount1           NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON continuous_auction_swap_fee_charged (chain_id, block_number);
CREATE INDEX ON continuous_auction_swap_fee_charged (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_continuous_auction_swap_fee_charged
    BEFORE UPDATE
    ON continuous_auction_swap_fee_charged
    FOR EACH ROW
EXECUTE FUNCTION block_updates();

-- Written by the monitor. A row is final once executable; otherwise it only
-- holds for the live_until it was computed against, since a tenure that is
-- still open can gain a block.
CREATE TABLE continuous_auction_tenure_executability
(
    pool_key_id        int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    bidder             NUMERIC     NOT NULL,
    bid_start          int8        NOT NULL,
    live_until         int8        NOT NULL,
    -- the first block with a timestamp at or after bid_start
    first_block_number int8        NOT NULL,
    first_block_time   int8        NOT NULL,
    executable         bool        NOT NULL,
    checked_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_key_id, bidder, bid_start)
);

-- Written by the monitor at an indexed block.
CREATE TABLE continuous_auction_rent_reconciliations
(
    pool_key_id  int8        NOT NULL REFERENCES pool_keys (pool_key_id),
    block_number int8        NOT NULL,
    block_time   timestamptz NOT NULL,
    -- RentAccrued through block_number
    allocated    NUMERIC     NOT NULL,
    -- RentCollected through block_number
    collected    NUMERIC     NOT NULL,
    -- sum of getPositionRent at block_number over the pool's positions
    claimable    NUMERIC     NOT NULL,
    discarded    NUMERIC GENERATED ALWAYS AS (allocated - collected - claimable) STORED,
    checked_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_key_id, block_number)
);

CREATE TABLE continuous_auction_alert_thresholds
(
    -- 0 is the default for chains without their own row
    chain_id                   int8    PRIMARY KEY,
    -- trailing window the share alerts are computed over
    window_seconds             int8    NOT NULL,
    -- share alerts stay quiet until the pool has been observed this long
    min_window_seconds         int8    NOT NULL,
    -- pools with no live bid for this long are dormant: trend review, not alerts
    dormant_after_seconds      int8    NOT NULL,
    -- the pool has had no live bid for this long
    closed_streak_warn_seconds int8    NOT NULL,
    closed_streak_page_seconds int8    NOT NULL,
    -- closed seconds / observed seconds
    closed_share_warn          NUMERIC NOT NULL,
    closed_share_page          NUMERIC NOT NULL,
    -- (unallocated + position-change discards) / gross rent
    discarded_share_warn       NUMERIC NOT NULL,
    discarded_share_page       NUMERIC NOT NULL,
    -- rent paid for tenures without an executable block / rent paid
    unexecutable_share_warn    NUMERIC NOT NULL
);

-- Asset-agnostic starting points until the per-chain deployment assumptions
-- are set; recalibrate per chain once the bid asset and cadence are known.
INSERT INTO continuous_auction_alert_thresholds
VALUES (0, 86400, 3600, 86400, 900, 3600, 0.25, 0.5, 0.05, 0.2, 0.05);

CREATE VIEW continuous_auction_live_segments AS
WITH updates AS (SELECT bu.chain_id,
                        bu.pool_key_id,
                        bu.event_id,
                        EXTRACT(EPOCH FROM b.block_time)::int8 AS t,
                        LEAD(EXTRACT(EPOCH FROM b.block_time)::int8)
                        OVER (PARTITION BY bu.pool_key_id ORDER BY bu.event_id) AS t_next,
                        bu.current_bidder,
                        bu.current_rate,
                        bu.current_executor,
                        bu.current_start,
                        bu.current_end,
                        bu.current_fee,
                        bu.next_bidder,
                        bu.next_rate,
                        bu.next_executor,
                        bu.next_start,
                        bu.next_end,
                        bu.next_fee
                 FROM continuous_auction_bid_updated bu
                          JOIN blocks b ON b.chain_id = bu.chain_id AND b.block_number = bu.block_number
                 WHERE bu.pool_key_id IS NOT NULL),
     bounded AS (SELECT u.*,
                        -- the latest schedule holds through the indexed head
                        EXTRACT(EPOCH FROM get_chain_head_time(u.chain_id))::int8 AS observed_until,
                        COALESCE(u.t_next,
                                 GREATEST(u.t, EXTRACT(EPOCH FROM get_chain_head_time(u.chain_id))::int8)) AS t_until
                 FROM updates u),
     segments AS (SELECT chain_id,
                         pool_key_id,
                         event_id,
                         observed_until,
                         current_bidder                                              AS bidder,
                         current_rate                                                AS rate,
                         current_executor                                            AS executor,
                         current_fee                                                 AS fee,
                         current_start                                               AS bid_start,
                         current_end                                                 AS bid_end,
                         GREATEST(current_start, t)                                  AS live_from,
                         LEAST(current_end, COALESCE(next_start, current_end), t_until) AS live_until
                  FROM bounded
                  WHERE current_bidder <> 0
                  UNION ALL
                  SELECT chain_id,
                         pool_key_id,
                         event_id,
                         observed_until,
                         next_bidder,
                         next_rate,
                         next_executor,
                         next_fee,
                         next_start,
                         next_end,
                         GREATEST(next_start, t),
                         LEAST(next_end, t_until)
                  FROM bounded
                  WHERE next_bidder IS NOT NULL)
SELECT *
FROM segments
WHERE live_until > live_from;

CREATE VIEW continuous_auction_tenures AS
SELECT chain_id,
       pool_key_id,
       bidder,
       bid_start,
       rate,
       executor,
       fee,
       -- own shortening lowers the scheduled end; displacement does not
       MIN(bid_end)                          AS scheduled_end,
       MIN(live_from)                        AS live_from,
       MAX(live_until)                       AS live_until,
       SUM(live_until - live_from)::int8     AS live_seconds,
       rate * SUM(live_until - live_from)    AS rent_paid,
       MAX(observed_until)                   AS observed_until
FROM continuous_auction_live_segments
GROUP BY chain_id, pool_key_id, bidder, bid_start, rate, executor, fee;

CREATE VIEW continuous_auction_displacements AS
WITH ordered AS (SELECT bu.chain_id,
                        bu.pool_key_id,
                        bu.event_id,
                        bu.block_number,
                        bu.transaction_hash,
                        EXTRACT(EPOCH FROM b.block_time)::int8 AS t,
                        bu.bidder,
                        bu.rate,
                        LAG(bu.next_bidder) OVER w             AS prev_next_bidder,
                        LAG(bu.next_rate) OVER w               AS prev_next_rate,
                        LAG(bu.next_start) OVER w              AS prev_next_start,
                        LAG(bu.next_end) OVER w                AS prev_next_end
                 FROM continuous_auction_bid_updated bu
                          JOIN blocks b ON b.chain_id = bu.chain_id AND b.block_number = bu.block_number
                 WHERE bu.pool_key_id IS NOT NULL
                 WINDOW w AS (PARTITION BY bu.pool_key_id ORDER BY bu.event_id))
-- A pending bid still pending at t (it activates at the first later second)
-- replaced by another bidder's bid. Its tenure never started.
SELECT chain_id,
       pool_key_id,
       'pending'                        AS kind,
       t                                AS displaced_at,
       bidder                           AS displacer,
       rate                             AS displacer_rate,
       NULL::int8                       AS displacer_live_seconds,
       NULL::int8                       AS displacer_live_until,
       prev_next_bidder                 AS displaced,
       prev_next_rate                   AS displaced_rate,
       prev_next_end - prev_next_start  AS displaced_remaining_seconds
FROM ordered
WHERE rate <> 0
  AND prev_next_bidder IS NOT NULL
  AND prev_next_start > t
  AND prev_next_bidder <> bidder
UNION ALL
-- A live bid cut short: it ended before its scheduled end, at the start of
-- another bidder's tenure.
SELECT a.chain_id,
       a.pool_key_id,
       'incumbent',
       a.live_until,
       d.bidder,
       d.rate,
       d.live_seconds,
       d.live_until,
       a.bidder,
       a.rate,
       a.scheduled_end - a.live_until
FROM continuous_auction_tenures a
         JOIN continuous_auction_tenures d
              ON d.pool_key_id = a.pool_key_id AND d.live_from = a.live_until AND d.bidder <> a.bidder
WHERE a.live_until < a.scheduled_end
  AND a.live_until < a.observed_until;

CREATE VIEW continuous_auction_rent_collections AS
SELECT rc.chain_id,
       rc.pool_key_id,
       rc.event_id,
       rc.transaction_hash,
       EXTRACT(EPOCH FROM b.block_time)::int8 AS collected_at,
       rc.owner,
       rc.salt,
       rc.lower_bound,
       rc.upper_bound,
       rc.amount,
       COALESCE(nft.to_address, rc.owner)     AS beneficiary,
       EXISTS (SELECT 1
               FROM continuous_auction_bid_updated bu
               WHERE bu.pool_key_id = rc.pool_key_id
                 AND (bu.locker IN (rc.owner, COALESCE(nft.to_address, rc.owner))
                   OR bu.executor IN (rc.owner, COALESCE(nft.to_address, rc.owner)))
       )                                      AS linked_to_holder
FROM continuous_auction_rent_collected rc
         JOIN blocks b ON b.chain_id = rc.chain_id AND b.block_number = rc.block_number
         LEFT JOIN LATERAL (SELECT t.to_address
                            FROM nonfungible_token_transfers t
                            WHERE t.chain_id = rc.chain_id
                              AND t.emitter = rc.owner
                              AND t.token_id = rc.salt
                              AND t.event_id < rc.event_id
                            ORDER BY t.event_id DESC
                            LIMIT 1) nft ON TRUE
WHERE rc.pool_key_id IS NOT NULL;

-- Per-pool metrics over [p_from, p_to) in unix seconds, clamped to the
-- indexed head and to the pool's first live second. Rent and fee amounts are
-- base units; fees are 0.32 fractions converted to [0, 1).
CREATE FUNCTION continuous_auction_pool_metrics(p_chain_id int8, p_from int8, p_to int8)
    RETURNS TABLE
            (
                pool_key_id                    int8,
                window_from                    int8,
                window_to                      int8,
                observed_seconds               int8,
                live_seconds                   int8,
                closed_seconds                 int8,
                last_live_until                int8,
                closed_streak_seconds          int8,
                rent_paid                      NUMERIC,
                rent_paid_unexecutable         NUMERIC,
                rent_paid_unresolved           NUMERIC,
                tenures                        int8,
                tenures_unexecutable           int8,
                rent_allocated                 NUMERIC,
                rent_unallocated               NUMERIC,
                rent_discarded_position_change NUMERIC,
                rent_collected                 NUMERIC,
                rent_collected_independent     NUMERIC,
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
WITH head AS (SELECT LEAST(p_to, EXTRACT(EPOCH FROM get_chain_head_time(p_chain_id))::int8) AS head_to),
     pools AS (SELECT t.pool_key_id,
                      GREATEST(p_from, MIN(t.live_from)) AS window_from,
                      h.head_to                          AS window_to,
                      MAX(t.live_until) FILTER (WHERE t.live_from < h.head_to) AS last_live_until
               FROM continuous_auction_tenures t,
                    head h
               WHERE t.chain_id = p_chain_id
               GROUP BY t.pool_key_id, h.head_to
               HAVING MIN(t.live_from) < h.head_to),
     overlap AS (SELECT t.*,
                        p.window_from,
                        p.window_to,
                        GREATEST(0, LEAST(t.live_until, p.window_to) - GREATEST(t.live_from, p.window_from)) AS secs,
                        e.executable
                 FROM continuous_auction_tenures t
                          JOIN pools p ON p.pool_key_id = t.pool_key_id
                          LEFT JOIN continuous_auction_tenure_executability e
                                    ON e.pool_key_id = t.pool_key_id AND e.bidder = t.bidder AND
                                       e.bid_start = t.bid_start AND
                                       (e.executable OR e.live_until = t.live_until)),
     tenure_metrics AS (SELECT o.pool_key_id,
                               SUM(o.secs)::int8                                                      AS live_seconds,
                               SUM(o.rate * o.secs)                                                   AS rent_paid,
                               COALESCE(SUM(o.rate * o.secs) FILTER (WHERE o.executable = FALSE), 0) AS rent_paid_unexecutable,
                               COALESCE(SUM(o.rate * o.secs) FILTER (WHERE o.executable IS NULL), 0) AS rent_paid_unresolved,
                               COUNT(*) FILTER (WHERE o.secs > 0)                                     AS tenures,
                               COUNT(*) FILTER (WHERE o.secs > 0 AND o.executable = FALSE)            AS tenures_unexecutable,
                               SUM(o.fee::NUMERIC * o.secs) / NULLIF(SUM(o.secs), 0) / 4294967296     AS fee_time_weighted,
                               MAX(o.fee) FILTER (WHERE o.secs > 0)::NUMERIC / 4294967296             AS fee_max,
                               -- some tenure covers the last second of the window
                               BOOL_OR(o.live_from < o.window_to AND o.live_until >= o.window_to)   AS live_at_end
                        FROM overlap o
                        GROUP BY o.pool_key_id),
     settled AS (SELECT rs.pool_key_id,
                        COALESCE(SUM(rs.amount) FILTER (WHERE rs.allocated), 0)     AS rent_allocated,
                        COALESCE(SUM(rs.amount) FILTER (WHERE NOT rs.allocated), 0) AS rent_unallocated
                 FROM continuous_auction_rent_settled rs
                          JOIN blocks b ON b.chain_id = rs.chain_id AND b.block_number = rs.block_number
                          JOIN pools p ON p.pool_key_id = rs.pool_key_id
                 WHERE EXTRACT(EPOCH FROM b.block_time)::int8 >= p_from
                   AND EXTRACT(EPOCH FROM b.block_time)::int8 < p.window_to
                 GROUP BY rs.pool_key_id),
     collected AS (SELECT c.pool_key_id,
                          SUM(c.amount)                                          AS rent_collected,
                          COALESCE(SUM(c.amount) FILTER (WHERE NOT c.linked_to_holder), 0) AS rent_collected_independent
                   FROM continuous_auction_rent_collections c
                            JOIN pools p ON p.pool_key_id = c.pool_key_id
                   WHERE c.collected_at >= p_from
                     AND c.collected_at < p.window_to
                   GROUP BY c.pool_key_id),
     beneficiaries AS (SELECT c.pool_key_id, c.beneficiary, SUM(c.amount) AS amount
                       FROM continuous_auction_rent_collections c
                                JOIN pools p ON p.pool_key_id = c.pool_key_id
                       WHERE c.collected_at >= p_from
                         AND c.collected_at < p.window_to
                       GROUP BY c.pool_key_id, c.beneficiary),
     concentration AS (SELECT pool_key_id, MAX(amount) / NULLIF(SUM(amount), 0) AS top_beneficiary_share
                       FROM beneficiaries
                       GROUP BY pool_key_id),
     reconciled AS (SELECT p.pool_key_id,
                           (SELECT r.discarded
                            FROM continuous_auction_rent_reconciliations r
                            WHERE r.pool_key_id = p.pool_key_id
                              AND EXTRACT(EPOCH FROM r.block_time)::int8 < p.window_to
                            ORDER BY r.block_number DESC
                            LIMIT 1) -
                           COALESCE((SELECT r.discarded
                                     FROM continuous_auction_rent_reconciliations r
                                     WHERE r.pool_key_id = p.pool_key_id
                                       AND EXTRACT(EPOCH FROM r.block_time)::int8 < p_from
                                     ORDER BY r.block_number DESC
                                     LIMIT 1), 0) AS rent_discarded_position_change
                    FROM pools p),
     fees AS (SELECT f.pool_key_id, COUNT(*) AS swap_fee_charges
              FROM continuous_auction_swap_fee_charged f
                       JOIN blocks b ON b.chain_id = f.chain_id AND b.block_number = f.block_number
                       JOIN pools p ON p.pool_key_id = f.pool_key_id
              WHERE EXTRACT(EPOCH FROM b.block_time)::int8 >= p_from
                AND EXTRACT(EPOCH FROM b.block_time)::int8 < p.window_to
              GROUP BY f.pool_key_id),
     displaced AS (SELECT d.pool_key_id,
                          COUNT(*) FILTER (WHERE d.kind = 'pending')   AS displacements_pending,
                          COUNT(*) FILTER (WHERE d.kind = 'incumbent') AS displacements_incumbent,
                          -- a displacer that held the pool for less time than it took
                          -- away, after which nobody held it
                          COUNT(*) FILTER (WHERE d.kind = 'incumbent'
                              AND d.displacer_live_seconds < d.displaced_remaining_seconds
                              AND d.displacer_live_until < p.window_to
                              AND NOT EXISTS (SELECT 1
                                              FROM continuous_auction_tenures n
                                              WHERE n.pool_key_id = d.pool_key_id
                                                AND n.live_from = d.displacer_live_until))
                                                                       AS displacements_then_closed
                   FROM continuous_auction_displacements d
                            JOIN pools p ON p.pool_key_id = d.pool_key_id
                   WHERE d.displaced_at >= p_from
                     AND d.displaced_at < p.window_to
                   GROUP BY d.pool_key_id)
SELECT p.pool_key_id,
       p.window_from,
       p.window_to,
       p.window_to - p.window_from,
       tm.live_seconds,
       p.window_to - p.window_from - tm.live_seconds,
       p.last_live_until,
       CASE WHEN tm.live_at_end THEN 0 ELSE p.window_to - LEAST(p.last_live_until, p.window_to) END,
       tm.rent_paid,
       tm.rent_paid_unexecutable,
       tm.rent_paid_unresolved,
       tm.tenures,
       tm.tenures_unexecutable,
       COALESCE(s.rent_allocated, 0),
       COALESCE(s.rent_unallocated, 0),
       r.rent_discarded_position_change,
       COALESCE(c.rent_collected, 0),
       COALESCE(c.rent_collected_independent, 0),
       k.top_beneficiary_share,
       tm.fee_time_weighted,
       tm.fee_max,
       COALESCE(f.swap_fee_charges, 0),
       COALESCE(d.displacements_pending, 0),
       COALESCE(d.displacements_incumbent, 0),
       COALESCE(d.displacements_then_closed, 0)
FROM pools p
         JOIN tenure_metrics tm ON tm.pool_key_id = p.pool_key_id
         LEFT JOIN settled s ON s.pool_key_id = p.pool_key_id
         LEFT JOIN collected c ON c.pool_key_id = p.pool_key_id
         LEFT JOIN concentration k ON k.pool_key_id = p.pool_key_id
         LEFT JOIN reconciled r ON r.pool_key_id = p.pool_key_id
         LEFT JOIN fees f ON f.pool_key_id = p.pool_key_id
         LEFT JOIN displaced d ON d.pool_key_id = p.pool_key_id
$$;

-- Firing alerts for one chain over the trailing window ending at p_at (the
-- indexed head when NULL). severity is 'page' or 'warn'.
CREATE FUNCTION continuous_auction_alerts(p_chain_id int8, p_at int8 DEFAULT NULL)
    RETURNS TABLE
            (
                pool_key_id int8,
                alert       text,
                severity    text,
                value       NUMERIC,
                threshold   NUMERIC,
                window_from int8,
                window_to   int8
            )
    LANGUAGE sql
    STABLE
AS
$$
WITH th AS (SELECT *
            FROM continuous_auction_alert_thresholds
            WHERE chain_id IN (p_chain_id, 0)
            ORDER BY chain_id DESC
            LIMIT 1),
     clock AS (SELECT COALESCE(p_at, EXTRACT(EPOCH FROM get_chain_head_time(p_chain_id))::int8) AS t),
     m AS (SELECT m.*, th.*
           FROM th,
                clock,
                continuous_auction_pool_metrics(p_chain_id, clock.t - th.window_seconds, clock.t) m
           WHERE m.last_live_until >= m.window_to - th.dormant_after_seconds),
     candidates AS (SELECT pool_key_id,
                           'closed_streak'                                              AS alert,
                           closed_streak_seconds::NUMERIC                               AS value,
                           closed_streak_warn_seconds::NUMERIC                          AS warn,
                           closed_streak_page_seconds::NUMERIC                          AS page,
                           window_from,
                           window_to
                    FROM m
                    UNION ALL
                    SELECT pool_key_id,
                           'closed_share',
                           closed_seconds::NUMERIC / observed_seconds,
                           closed_share_warn,
                           closed_share_page,
                           window_from,
                           window_to
                    FROM m
                    WHERE observed_seconds >= min_window_seconds
                    UNION ALL
                    SELECT pool_key_id,
                           'discarded_rent_share',
                           (rent_unallocated + GREATEST(COALESCE(rent_discarded_position_change, 0), 0)) /
                           (rent_allocated + rent_unallocated),
                           discarded_share_warn,
                           discarded_share_page,
                           window_from,
                           window_to
                    FROM m
                    WHERE observed_seconds >= min_window_seconds
                      AND rent_allocated + rent_unallocated > 0
                    UNION ALL
                    SELECT pool_key_id,
                           'unexecutable_rent_share',
                           rent_paid_unexecutable / rent_paid,
                           unexecutable_share_warn,
                           NULL,
                           window_from,
                           window_to
                    FROM m
                    WHERE observed_seconds >= min_window_seconds
                      AND rent_paid > 0)
SELECT pool_key_id,
       alert,
       CASE WHEN value >= page THEN 'page' ELSE 'warn' END,
       value,
       CASE WHEN value >= page THEN page ELSE warn END,
       window_from,
       window_to
FROM candidates
WHERE value >= warn
$$;
