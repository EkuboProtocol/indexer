LOCK TABLE blocks;

ALTER TABLE blocks
    ADD COLUMN IF NOT EXISTS num_events int4;

-- Temporarily allow updates so we can backfill num_events for existing rows.
ALTER TABLE blocks
    DISABLE TRIGGER no_updates_blocks;

DO
$$
    DECLARE
        v_union TEXT;
    BEGIN
        SELECT STRING_AGG(
                       FORMAT(
                               'SELECT %1$I AS chain_id, %2$I AS block_number, COUNT(*)::int4 AS cnt FROM %3$I.%4$I GROUP BY %1$I, %2$I',
                               fk_columns[1], fk_columns[2], schema_name, table_name
                       ),
                       ' UNION ALL '
               )
        INTO v_union
        FROM (SELECT ns.nspname                                     AS schema_name,
                     rel.relname                                    AS table_name,
                     ARRAY_AGG(att.attname ORDER BY pos.ordinality) AS fk_columns
              FROM pg_constraint con
                       JOIN pg_class rel ON rel.oid = con.conrelid
                       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
                       JOIN LATERAL UNNEST(con.conkey) WITH ORDINALITY AS pos(attnum, ordinality) ON TRUE
                       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = pos.attnum
              WHERE con.contype = 'f'
                AND con.confrelid = 'blocks'::regclass
              GROUP BY ns.nspname, rel.relname) fks;

        IF v_union IS NULL THEN
            RAISE NOTICE 'No foreign keys to blocks found; skipping num_events backfill.';
        ELSE
            EXECUTE FORMAT(
                    'UPDATE blocks b
                     SET num_events = COALESCE(s.total, 0)::int4
                     FROM (
                              SELECT chain_id, block_number, SUM(cnt)::int4 AS total
                              FROM (%s) AS counts
                              GROUP BY chain_id, block_number
                          ) s
                     WHERE b.chain_id = s.chain_id
                       AND b.block_number = s.block_number;',
                    v_union
                    );
        END IF;
    END;
$$;

UPDATE blocks
SET num_events = COALESCE(num_events, 0)
WHERE num_events IS NULL;

ALTER TABLE blocks
    ENABLE TRIGGER no_updates_blocks,
    ALTER COLUMN num_events SET NOT NULL;

CREATE INDEX IF NOT EXISTS blocks_num_events_block_time_idx
    ON blocks (num_events, block_time);

CREATE OR REPLACE FUNCTION delete_old_empty_blocks()
    RETURNS INTEGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_deleted INTEGER;
BEGIN
    IF NOT PG_TRY_ADVISORY_XACT_LOCK(hashtext('delete_old_empty_blocks')::BIGINT) THEN
        RAISE NOTICE 'delete_old_empty_blocks already running; skipping.';
        RETURN 0;
    END IF;

    DELETE
    FROM blocks
    WHERE num_events = 0
      AND block_time < NOW() - INTERVAL '1 day';

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

DO
$$
    DECLARE
        has_pg_cron BOOLEAN;
        job_id      INT;
    BEGIN
        SELECT EXISTS (SELECT 1
                       FROM pg_extension
                       WHERE extname = 'pg_cron')
        INTO has_pg_cron;

        IF NOT has_pg_cron THEN
            RAISE NOTICE 'pg_cron not installed; skipping empty block cleanup scheduling.';
            RETURN;
        END IF;

        SELECT jobid
        INTO job_id
        FROM cron.job
        WHERE jobname = 'delete_old_empty_blocks';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;

        PERFORM cron.schedule(
                'delete_old_empty_blocks',
                '0 * * * *',
                'SELECT delete_old_empty_blocks();'
                );
    END;
$$;
