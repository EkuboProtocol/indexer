-- Additive: no changes to all_pool_states_view, pool_last_event_id, or any
-- per-swap trigger. Call-point changes are rare and are polled independently
-- by the quoter, which must replace its graph when eligibility changes.
CREATE TABLE starknet_extension_call_points (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS
        (compute_event_id(block_number, transaction_index, event_index)) STORED,
    pool_extension numeric NOT NULL,
    call_points int2 NOT NULL CHECK (call_points BETWEEN 1 AND 255),
    PRIMARY KEY (chain_id, event_id),
    FOREIGN KEY (chain_id, block_number)
        REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON starknet_extension_call_points (chain_id, block_number);
CREATE INDEX ON starknet_extension_call_points
    (chain_id, emitter, pool_extension, event_id DESC) INCLUDE (call_points);

CREATE TRIGGER no_updates_starknet_extension_call_points
    BEFORE UPDATE ON starknet_extension_call_points
    FOR EACH ROW EXECUTE FUNCTION block_updates();

-- Last canonical event wins, including when older history arrives later.
-- A reorg's block cascade automatically exposes the preceding registration.
-- Apply the swap-hook predicate OUTSIDE this view: filtering history first
-- would incorrectly resurrect an earlier safe registration.
CREATE VIEW starknet_extension_call_points_latest AS
SELECT DISTINCT ON (chain_id, emitter, pool_extension)
       chain_id, emitter, pool_extension, event_id, call_points
FROM starknet_extension_call_points
ORDER BY chain_id, emitter, pool_extension, event_id DESC;

-- New consumers fail closed until the historical event backfill is complete.
CREATE TABLE starknet_extension_call_points_backfill (
    chain_id int8 NOT NULL,
    core_address numeric NOT NULL,
    through_block int8 NOT NULL,
    eligible_extensions numeric[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (chain_id, core_address)
);

-- Materialize the small set on these rare writes, never on the quoter's hot
-- pool poll. One PK lookup on its existing head query retrieves the set.
CREATE FUNCTION refresh_starknet_extension_routing(p_chain int8, p_core numeric)
RETURNS void LANGUAGE sql AS $$
    UPDATE starknet_extension_call_points_backfill
    SET eligible_extensions = ARRAY(
        SELECT pool_extension FROM starknet_extension_call_points_latest
        WHERE chain_id = p_chain AND emitter = p_core
          AND (call_points & 96) = 0
        ORDER BY pool_extension
    )
    WHERE chain_id = p_chain AND core_address = p_core;
$$;

CREATE FUNCTION trg_starknet_extension_routing()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Serialize with a backfill completion and other writes for this Core.
    -- Normal ingestion is already serialized by the chain's advisory lock.
    PERFORM 1 FROM starknet_extension_call_points_backfill
    WHERE chain_id = COALESCE(NEW.chain_id, OLD.chain_id)
      AND core_address = COALESCE(NEW.emitter, OLD.emitter) FOR UPDATE;
    PERFORM refresh_starknet_extension_routing(
        COALESCE(NEW.chain_id, OLD.chain_id), COALESCE(NEW.emitter, OLD.emitter));
    RETURN NULL;
END;
$$;

CREATE TRIGGER maintain_starknet_extension_routing
    AFTER INSERT OR DELETE ON starknet_extension_call_points
    FOR EACH ROW EXECUTE FUNCTION trg_starknet_extension_routing();
