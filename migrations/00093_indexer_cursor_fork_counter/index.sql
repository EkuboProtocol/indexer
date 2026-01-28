ALTER TABLE indexer_cursor
    ADD COLUMN fork_counter int8 NOT NULL DEFAULT 0;

ALTER TABLE blocks
    ADD COLUMN fork_counter int8 NOT NULL DEFAULT 0;

ALTER TABLE blocks
    ALTER COLUMN fork_counter DROP DEFAULT;

DROP TRIGGER IF EXISTS blocks_set_fork_counter ON blocks;
DROP FUNCTION IF EXISTS blocks_set_fork_counter;

CREATE FUNCTION blocks_set_fork_counter()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
BEGIN
    IF new.fork_counter IS NULL THEN
        SELECT ic.fork_counter
        INTO STRICT new.fork_counter
        FROM indexer_cursor ic
        WHERE ic.chain_id = new.chain_id;
    END IF;

    RETURN new;
END;
$$;

CREATE TRIGGER blocks_set_fork_counter
    BEFORE INSERT
    ON blocks
    FOR EACH ROW
EXECUTE FUNCTION blocks_set_fork_counter();

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
    FROM (SELECT DISTINCT chain_id FROM deleted_rows) d
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
