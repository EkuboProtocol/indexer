-- Track each chain's head block on indexer_cursor, so blocks no longer has to
-- hold a row for every empty block just to answer "where is this chain".
--
-- Measured on ekubo-db-nyc1 on 2026-09-04.
--
-- 85% of the blocks written are empty. Over one hour the 13 chains wrote
-- 15,177 blocks of which 12,916 had num_events = 0, and 8 of the 13 chains
-- (Optimism, Unichain, BNB, Ink, Base, World Chain, Gnosis, MegaETH) were 100%
-- empty. Each of those rows is inserted, kept for a day, then deleted by
-- delete_old_empty_blocks() -- and on the way out pays all 43 of the
-- ON DELETE CASCADE lookups that hang off blocks, despite never having had a
-- child row. That was 2,298,518 of the 4,291,310 block deletions in the
-- 10-day window, so roughly 99M of the 184.5M cascade executions were for
-- rows that could not have had children.
--
-- 00121 makes each of those lookups cheap. This removes them.
--
-- Everything that actually reads an empty block only ever wants the chain
-- head, never the history:
--
--   * quoter-service's LATEST_BLOCK_QUERY -- "ORDER BY block_number DESC
--     LIMIT $3", 11 calls/sec, 10,000,890 rows over 10,000,896 calls, so
--     always one row. It is also the only consumer of base_fee_per_gas
--     anywhere: no view, matview or function in this database references that
--     column.
--   * incentives.compute_pending_reward_periods -- MAX(block_time) per chain,
--     the watermark deciding whether a reward period has fully elapsed. On a
--     chain whose blocks are all empty this is exactly what needs empty blocks
--     to advance.
--   * public.get_oracle_twap_tick -- ORDER BY block_number DESC LIMIT 1 for
--     the end of the TWAP window.
--   * the API's getLatestBlock.
--
-- Nothing reads block_hash back except that quoter query, so blocks is not
-- serving as a reorg hash chain either; reorgs are handled by deleting forward
-- from a height, with fork_counter and unique_key on indexer_cursor.
--
-- incentives.compute_rewards_for_period_v1 and the API's lookups by timestamp
-- or by number do want historical blocks, and they keep reading blocks. They
-- already tolerate empty blocks being absent, because empty blocks older than
-- a day have been swept for as long as that sweep has existed; this makes the
-- behaviour they already have for old blocks uniform.
--
-- Typed columns rather than a single json column: the shape is fixed and four
-- fields wide, so json buys nothing and costs the per-column NOT NULL and type
-- checks. It would also be a precision trap. block_number is comfortably
-- inside a JavaScript number -- chains are at 10^8-10^9 blocks against a
-- 2^53 limit -- but block_hash is NUMERIC holding a 256-bit value, and every
-- standard json parser turns a json number into a double. In json the hash
-- would have to be a string to survive, which is exactly the kind of thing
-- that is easy to get wrong later. As columns, a reader casts ::TEXT the same
-- way the existing quoter query already casts base_fee_per_gas.

ALTER TABLE indexer_cursor
    ADD COLUMN head_block_number     BIGINT,
    ADD COLUMN head_block_hash       NUMERIC,
    ADD COLUMN head_block_time       TIMESTAMPTZ,
    ADD COLUMN head_base_fee_per_gas NUMERIC;

-- Seed from what blocks currently holds. From here the indexer maintains these
-- columns itself, in writeCursor -- which already upserts this row once per
-- block, so the head costs no extra write.
UPDATE indexer_cursor ic
SET head_block_number     = b.block_number,
    head_block_hash       = b.block_hash,
    head_block_time       = b.block_time,
    head_base_fee_per_gas = b.base_fee_per_gas
FROM (SELECT DISTINCT ON (chain_id) chain_id, block_number, block_hash, block_time, base_fee_per_gas
      FROM blocks
      ORDER BY chain_id, block_number DESC) b
WHERE b.chain_id = ic.chain_id;

-- DEPLOY ORDER IS LOAD-BEARING. There is deliberately no trigger bridging
-- blocks -> indexer_cursor, so nothing keeps these columns current except the
-- indexer build that ships with this migration, and nothing keeps a
-- blocks-based tip query correct once that build stops writing empty blocks.
-- The indexer, the API and quoter-service therefore have to go out together.
-- A reader left on "ORDER BY block_number DESC LIMIT 1" against blocks does
-- not error -- it silently returns the last block that happened to carry an
-- event, which on the eight chains that are 100% empty is arbitrarily stale.
-- See the README breaking changelog.

-- Drop the empty blocks already sitting in the table. 202,040 of the 7,850,676
-- rows have num_events = 0, and every one of them is a row that cannot have a
-- child in any of the 43 cascading tables.
--
-- This runs after 00121, which is what makes it affordable: the cascade
-- lookups these deletions fire are index scans rather than sequential scans of
-- ve33_pool_fees_accounted and ve33_pool_emissions_accrued. In the other order
-- it would be 202,040 x 3 seq scans of ~100 MB tables.
--
-- The delete notification is disabled around it. 00064 emits a pg_notify per
-- deleted row on both 'blocks_delete' and 'blocks', and those are queued until
-- commit, so leaving it on would hand every listener 404,080 messages in one
-- burst for rows that carried no events and that no listener has any reason to
-- hear about. Only this trigger is disabled, so the FK cascades still run.
ALTER TABLE blocks
    DISABLE TRIGGER blocks_delete_notification;

DELETE
FROM blocks
WHERE num_events = 0;

ALTER TABLE blocks
    ENABLE TRIGGER blocks_delete_notification;

-- Read the head from indexer_cursor, falling back to blocks for a chain that
-- has not produced a block since the migration.
CREATE OR REPLACE FUNCTION public.get_chain_head_time(p_chain_id BIGINT)
    RETURNS TIMESTAMPTZ
    LANGUAGE sql
    STABLE
AS
$$
SELECT COALESCE(
               (SELECT ic.head_block_time FROM indexer_cursor ic WHERE ic.chain_id = p_chain_id),
               (SELECT b.block_time
                FROM blocks b
                WHERE b.chain_id = p_chain_id
                ORDER BY b.block_number DESC
                LIMIT 1)
       );
$$;

-- compute_pending_reward_periods used MAX(block_time) over blocks per chain,
-- which is a full index scan of that chain's blocks and which stops advancing
-- on an all-empty chain once empty blocks are no longer written.
CREATE OR REPLACE FUNCTION incentives.compute_pending_reward_periods()
    RETURNS INTEGER
    LANGUAGE plpgsql
AS
$function$
DECLARE
    v_period RECORD;
    v_rows   INTEGER;
    v_total  INTEGER := 0;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext('compute_pending_reward_periods')::bigint) THEN
        RAISE NOTICE 'compute_pending_reward_periods already running; skipping.';
        RETURN 0;
    END IF;

    FOR v_period IN
        SELECT crp.id       AS reward_period_id,
               c.slug       AS campaign_slug,
               c.chain_id   AS chain_id,
               crp.end_time AS period_end
        FROM incentives.campaign_reward_periods crp
                 JOIN incentives.campaigns c ON crp.campaign_id = c.id
        WHERE crp.rewards_last_computed_at IS NULL
          AND crp.end_time <= public.get_chain_head_time(c.chain_id)
        ORDER BY crp.end_time, crp.id
        LOOP
            BEGIN
                v_rows := incentives.compute_rewards_for_period_v1(v_period.reward_period_id);
                v_total := v_total + v_rows;
                RAISE NOTICE 'Computed incentive rewards for period % (campaign %, chain %) inserted % rows',
                    v_period.reward_period_id, v_period.campaign_slug, v_period.chain_id, v_rows;
            EXCEPTION
                WHEN OTHERS THEN
                    RAISE WARNING 'Failed to compute rewards for period % (campaign %, chain %): %',
                        v_period.reward_period_id, v_period.campaign_slug, v_period.chain_id, SQLERRM;
            END;
        END LOOP;

    RETURN v_total;
END;
$function$;

-- The empty-block sweep has nothing left to sweep. Unschedule it and drop it,
-- along with the index that existed only to support it.
DO
$$
    DECLARE
        has_pg_cron BOOLEAN;
        job_id      INT;
    BEGIN
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
        INTO has_pg_cron;

        IF NOT has_pg_cron THEN
            RAISE NOTICE 'pg_cron not installed; skipping empty block sweep unschedule.';
            RETURN;
        END IF;

        SELECT jobid
        INTO job_id
        FROM cron.job
        WHERE command LIKE '%delete_old_empty_blocks%';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;
    END;
$$;

DROP FUNCTION IF EXISTS public.delete_old_empty_blocks();

DROP INDEX IF EXISTS blocks_num_events_block_time_idx;

-- get_oracle_twap_tick ends its TWAP window at the chain head. Reading that
-- from blocks would end the window at the last block that happened to carry
-- an event once empty blocks are no longer written, quietly shortening every
-- TWAP on a quiet chain. Only the chain_bounds CTE changes; the rest is
-- 00042's definition unchanged.
CREATE OR REPLACE FUNCTION get_oracle_twap_tick(
    p_chain_id int8,
    p_oracle_extension NUMERIC,
    p_oracle_token NUMERIC,
    p_token NUMERIC,
    p_twap_duration_seconds int8
) RETURNS int4
AS
$$
DECLARE
    v_result int4;
BEGIN
    IF p_token = p_oracle_token THEN
        RETURN 0;
    END IF;

    WITH chain_bounds AS (SELECT EXTRACT(EPOCH FROM public.get_chain_head_time(p_chain_id))::int8 AS end_timestamp),
         bounds AS (SELECT end_timestamp,
                           end_timestamp - p_twap_duration_seconds AS start_timestamp
                    FROM chain_bounds),
         pair_snapshots AS (
             -- canonicalize tick so it always represents token/oracle
             SELECT snapshot_block_timestamp,
                    snapshot_tick_cumulative,
                    event_id,
                    pk.pool_key_id,
                    1 AS tick_sign
             FROM oracle_snapshots os
                      JOIN pool_keys pk ON pk.chain_id = os.chain_id
                 AND pk.token0 = os.token0
                 AND pk.token1 = os.token1
                 AND pk.pool_extension = os.emitter
             WHERE os.chain_id = p_chain_id
               AND os.token0 = p_oracle_token
               AND os.token1 = p_token
               AND os.emitter = p_oracle_extension
             UNION ALL
             SELECT snapshot_block_timestamp,
                    -snapshot_tick_cumulative AS snapshot_tick_cumulative,
                    event_id,
                    pk.pool_key_id,
                    -1                        AS tick_sign
             FROM oracle_snapshots os
                      JOIN pool_keys pk ON pk.chain_id = os.chain_id
                 AND pk.token0 = os.token0
                 AND pk.token1 = os.token1
                 AND pk.pool_extension = os.emitter
             WHERE os.chain_id = p_chain_id
               AND os.token0 = p_token
               AND os.token1 = p_oracle_token
               AND os.emitter = p_oracle_extension),
         last_snapshot AS (SELECT *
                           FROM pair_snapshots
                           ORDER BY event_id DESC
                           LIMIT 1),
         start_snapshot AS (SELECT ps.*
                            FROM pair_snapshots ps
                                     JOIN last_snapshot ls ON ps.pool_key_id = ls.pool_key_id
                                     JOIN bounds b ON TRUE
                            WHERE ps.snapshot_block_timestamp <= b.start_timestamp
                            ORDER BY ps.snapshot_block_timestamp DESC
                            LIMIT 1),
         end_tick AS (SELECT get_pool_tick_at_timestamp(ls.pool_key_id, b.end_timestamp) AS tick
                      FROM last_snapshot ls
                               JOIN bounds b ON TRUE),
         start_tick AS (SELECT get_pool_tick_at_timestamp(ss.pool_key_id, b.start_timestamp) AS tick
                        FROM start_snapshot ss
                                 JOIN bounds b ON TRUE)
    SELECT ((
                (
                    ls.snapshot_tick_cumulative
                        + ((et.tick * ls.tick_sign)::int4 * GREATEST(b.end_timestamp - ls.snapshot_block_timestamp, 0))
                    )
                    - (
                    ss.snapshot_tick_cumulative
                        +
                    ((st.tick * ss.tick_sign)::int4 * GREATEST(b.start_timestamp - ss.snapshot_block_timestamp, 0))
                    )
                )
        / NULLIF(b.end_timestamp - b.start_timestamp, 0))
    INTO v_result
    FROM bounds b
             JOIN last_snapshot ls ON TRUE
             JOIN start_snapshot ss ON TRUE
             JOIN end_tick et ON TRUE
             JOIN start_tick st ON TRUE
    WHERE et.tick IS NOT NULL
      AND st.tick IS NOT NULL;

    RETURN v_result;
END;
$$
    LANGUAGE plpgsql;


-- Move the 'blocks' notification to the head, so listeners still hear about
-- every block.
--
-- 00064 emits on 'blocks' from a row trigger on blocks. quoter-service LISTENs
-- on that channel and re-syncs when it fires. With empty blocks no longer
-- written it would stop hearing about them, and on a quiet chain its cached
-- head -- including base_fee_per_gas, which it uses to price gas into quotes --
-- would sit at the last block that happened to carry an event.
--
-- The head column update happens exactly once per block, empty or not, so
-- notifying from there restores precisely the old cadence. 'blocks_insert'
-- keeps its original meaning: a block that carried events.
CREATE OR REPLACE FUNCTION notify_blocks_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    payload TEXT := JSON_BUILD_OBJECT('chain_id', new.chain_id, 'block_number', new.block_number)::TEXT;
BEGIN
    PERFORM pg_notify('blocks_insert', payload);
    RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION notify_indexer_cursor_head()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    payload TEXT := JSON_BUILD_OBJECT('chain_id', new.chain_id, 'block_number', new.head_block_number)::TEXT;
BEGIN
    PERFORM pg_notify('blocks', payload);
    RETURN NULL;
END;
$$;

CREATE TRIGGER indexer_cursor_head_notification
    AFTER INSERT OR UPDATE OF head_block_number
    ON indexer_cursor
    FOR EACH ROW
    WHEN (new.head_block_number IS NOT NULL)
EXECUTE FUNCTION notify_indexer_cursor_head();
