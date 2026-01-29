DROP TRIGGER IF EXISTS blocks_delete_bump_fork_counter ON blocks;
DROP FUNCTION IF EXISTS bump_fork_counter_on_blocks_delete;

CREATE FUNCTION bump_fork_counter_on_blocks_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    UPDATE indexer_cursor ic
    SET fork_counter = fork_counter + 1,
        last_updated = NOW()
    FROM (
        SELECT DISTINCT chain_id
        FROM deleted_rows
        WHERE num_events > 0
    ) d
    WHERE ic.chain_id = d.chain_id;

    RETURN NULL;
END;
$$;

CREATE TRIGGER blocks_delete_bump_fork_counter
    AFTER DELETE
    ON blocks
    REFERENCING old TABLE AS deleted_rows
    FOR EACH STATEMENT
EXECUTE FUNCTION bump_fork_counter_on_blocks_delete();
