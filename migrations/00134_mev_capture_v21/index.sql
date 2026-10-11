-- MEVCapture v2.1 (EKU-1578, under EKU-1023 / EKU-946). Additive only: v1
-- (mev_capture_pool_keys), all_pool_states_view, pool_last_event_id and every
-- per-swap trigger are untouched. Nothing here is written unless a worker sets
-- MEV_CAPTURE_V21_V3_ADDRESS.
--
-- Source of truth: evm-contracts da368348 (PR 381), src/extensions/MEVCaptureV21.sol.
-- Core's logs do not carry the extension's per-pool state, so the worker reads
-- it explicitly: getConfig() once per extension and getAnchor(poolId) at the
-- end of every block in which Core logged a swap, position update or
-- initialization for a v2.1 pool. Both reads are eth_call pinned to the block
-- hash (EIP-1898, requireCanonical), in the same transaction that writes the
-- block's Core events. A failed read fails the block, which the runtime
-- retries; nothing is written with a gap.
--
-- Every row hangs off blocks (chain_id, block_number) ON DELETE CASCADE, so a
-- reorg removes the reads and events of the orphaned blocks and the next
-- canonical block re-reads.

-- One row per v2.1 extension: the version registry and its immutable config.
-- getConfig() is read at the block of the first v2.1 activity the worker sees.
CREATE TABLE mev_capture_v21_configs (
    chain_id int8 NOT NULL,
    extension numeric NOT NULL,
    block_number int8 NOT NULL,
    block_hash numeric NOT NULL,
    half_life int8 NOT NULL CHECK (half_life BETWEEN 1 AND 1048576),
    slope_k int2 NOT NULL CHECK (slope_k BETWEEN 1 AND 16),
    segment_exp int2 NOT NULL CHECK (segment_exp BETWEEN 0 AND 8),
    j_lin int2 NOT NULL CHECK (j_lin BETWEEN 1 AND 64),
    max_fee int4 NOT NULL CHECK (max_fee BETWEEN 1 AND 32768),
    clamp_ticks int8 NOT NULL CHECK (clamp_ticks BETWEEN 1 AND 177445670),
    m_gate int2 NOT NULL CHECK (m_gate BETWEEN 0 AND 16),
    max_segments int2 NOT NULL CHECK (max_segments = j_lin + 24),
    PRIMARY KEY (chain_id, extension),
    FOREIGN KEY (chain_id, block_number)
        REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON mev_capture_v21_configs (chain_id, block_number);

-- Pools initialized on the configured v2.1 extension. Version is selected by
-- extension address, never by the generic v1 MEVCapture flag.
CREATE TABLE mev_capture_v21_pools (
    pool_key_id int8 PRIMARY KEY REFERENCES pool_keys (pool_key_id),
    chain_id int8 NOT NULL,
    extension numeric NOT NULL,
    block_number int8 NOT NULL,
    FOREIGN KEY (chain_id, block_number)
        REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON mev_capture_v21_pools (chain_id, block_number);
CREATE INDEX ON mev_capture_v21_pools (chain_id, extension);

-- getAnchor(poolId) at the end of each block that touched the pool. uint32
-- times are stored as read (they wrap in 2106); anchor_x16 is signed Q48.16.
CREATE TABLE mev_capture_v21_anchor_states (
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    block_number int8 NOT NULL,
    chain_id int8 NOT NULL,
    block_hash numeric NOT NULL,
    last_update_time int8 NOT NULL CHECK (last_update_time BETWEEN 0 AND 4294967295),
    l_ref_time int8 NOT NULL CHECK (l_ref_time BETWEEN 0 AND 4294967295),
    last_pos_time int8 NOT NULL CHECK (last_pos_time BETWEEN 0 AND 4294967295),
    l_ref_bits int2 NOT NULL CHECK (l_ref_bits BETWEEN 0 AND 255),
    snap_bits int2 NOT NULL CHECK (snap_bits BETWEEN 0 AND 255),
    l_ref_raise_time int8 NOT NULL CHECK (l_ref_raise_time BETWEEN 0 AND 4294967295),
    anchor_x16 int8 NOT NULL,
    PRIMARY KEY (pool_key_id, block_number),
    FOREIGN KEY (chain_id, block_number)
        REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON mev_capture_v21_anchor_states (chain_id, block_number);

CREATE TRIGGER no_updates_mev_capture_v21_anchor_states
    BEFORE UPDATE ON mev_capture_v21_anchor_states
    FOR EACH ROW EXECUTE FUNCTION block_updates();

-- AnchorGateFailed(bytes32 indexed poolId, uint8 lObs, uint8 eRef).
CREATE TABLE mev_capture_v21_gate_failures (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS
        (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
    pool_id numeric NOT NULL,
    l_obs int2 NOT NULL CHECK (l_obs BETWEEN 0 AND 255),
    e_ref int2 NOT NULL CHECK (e_ref BETWEEN 0 AND 255),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number)
        REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON mev_capture_v21_gate_failures (chain_id, block_number);
CREATE INDEX ON mev_capture_v21_gate_failures (pool_key_id, event_id DESC);

CREATE TRIGGER no_updates_mev_capture_v21_gate_failures
    BEFORE UPDATE ON mev_capture_v21_gate_failures
    FOR EACH ROW EXECUTE FUNCTION block_updates();

-- Quoter contract: one row per v2.1 pool with its config and latest anchor.
-- A pool without a config or anchor row is absent, so a consumer fails closed.
CREATE VIEW mev_capture_v21_pool_states AS
SELECT p.chain_id,
       pk.core_address,
       pk.pool_id,
       p.pool_key_id,
       p.extension,
       'v2.1'::text AS mev_capture_version,
       c.half_life, c.slope_k, c.segment_exp, c.j_lin, c.max_fee,
       c.clamp_ticks, c.m_gate, c.max_segments,
       a.block_number AS anchor_block_number,
       a.block_hash AS anchor_block_hash,
       a.last_update_time, a.l_ref_time, a.last_pos_time, a.l_ref_bits,
       a.snap_bits, a.l_ref_raise_time, a.anchor_x16
FROM mev_capture_v21_pools p
JOIN pool_keys pk ON pk.pool_key_id = p.pool_key_id
JOIN mev_capture_v21_configs c
  ON c.chain_id = p.chain_id AND c.extension = p.extension
CROSS JOIN LATERAL (
    SELECT *
    FROM mev_capture_v21_anchor_states s
    WHERE s.pool_key_id = p.pool_key_id
    ORDER BY s.block_number DESC
    LIMIT 1
) a;

-- bitLength() of MEVCaptureV21.sol for a non-negative integer: 0 for 0, else
-- floor(log2(x)) + 1. log() is corrected by exact powers so rounding at an
-- exact power of two cannot be off by one.
CREATE FUNCTION mev_capture_v21_bit_length(x numeric)
RETURNS int4 LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE
        WHEN x <= 0 THEN 0
        ELSE (SELECT CASE
                  WHEN power(2::numeric, n + 1) <= x THEN n + 2
                  WHEN power(2::numeric, n) > x THEN n
                  ELSE n + 1
              END
              FROM (SELECT floor(log(2::numeric, x))::int4 AS n) f)
    END;
$$;

-- Monitor input, not a monitor: per-pool anchor/gate health as of p_as_of.
-- Ages use uint32 modular arithmetic like the contract. e_ref_now is the
-- decayed gate reference the next first-of-timestamp swap would compare to;
-- stale_anchor means the anchor has not been updated for more than 2*tau.
-- gate_margin_now = bitlen(latest indexed active liquidity) + mGate - e_ref_now:
-- negative fails, 0 is the edge. The liquidity is the latest swap's
-- liquidity_after, so it ignores position updates since that swap.
CREATE FUNCTION mev_capture_v21_pool_health(p_chain_id int8, p_as_of timestamptz)
RETURNS TABLE (
    pool_key_id int8,
    extension numeric,
    anchor_block_number int8,
    anchor_age_seconds int8,
    ref_age_seconds int8,
    half_life int8,
    stale_anchor boolean,
    l_ref_bits int2,
    e_ref_now int4,
    liquidity_bits_now int4,
    gate_margin_now int4,
    gate_failures_2tau int8,
    last_gate_failure_block int8,
    last_gate_failure_l_obs int2,
    last_gate_failure_e_ref int2
)
LANGUAGE sql STABLE AS $$
    WITH base AS (
        SELECT s.*,
               mod(extract(epoch FROM p_as_of)::int8, 4294967296) AS now32
        FROM mev_capture_v21_pool_states s
        WHERE s.chain_id = p_chain_id
    ), aged AS (
        SELECT b.*,
               mod(b.now32 - b.last_update_time + 4294967296, 4294967296) AS anchor_age,
               mod(b.now32 - b.l_ref_time + 4294967296, 4294967296) AS ref_age
        FROM base b
    )
    SELECT a.pool_key_id,
           a.extension,
           a.anchor_block_number,
           a.anchor_age,
           a.ref_age,
           a.half_life,
           a.anchor_age > 2 * a.half_life,
           a.l_ref_bits,
           greatest(a.l_ref_bits - (a.ref_age / a.half_life), 0)::int4,
           liq.bits,
           (liq.bits + a.m_gate - greatest(a.l_ref_bits - (a.ref_age / a.half_life), 0))::int4,
           (SELECT count(*) FROM mev_capture_v21_gate_failures g
              JOIN blocks bl ON bl.chain_id = g.chain_id AND bl.block_number = g.block_number
             WHERE g.pool_key_id = a.pool_key_id
               AND bl.block_time > p_as_of - make_interval(secs => 2 * a.half_life)
               AND bl.block_time <= p_as_of),
           lg.block_number,
           lg.l_obs,
           lg.e_ref
    FROM aged a
    LEFT JOIN LATERAL (
        SELECT mev_capture_v21_bit_length(sw.liquidity_after) AS bits
        FROM swaps sw
        WHERE sw.pool_key_id = a.pool_key_id
        ORDER BY sw.event_id DESC
        LIMIT 1
    ) liq ON true
    LEFT JOIN LATERAL (
        SELECT g.block_number, g.l_obs, g.e_ref
        FROM mev_capture_v21_gate_failures g
        WHERE g.pool_key_id = a.pool_key_id
        ORDER BY g.event_id DESC
        LIMIT 1
    ) lg ON true;
$$;
