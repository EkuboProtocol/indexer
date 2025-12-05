-- Ensure blocks mutations emit NOTIFY events that downstream services can consume.

DROP TRIGGER IF EXISTS blocks_insert_notification ON blocks;
DROP TRIGGER IF EXISTS blocks_delete_notification ON blocks;
DROP FUNCTION IF EXISTS notify_blocks_insert CASCADE;
DROP FUNCTION IF EXISTS notify_blocks_delete CASCADE;

CREATE FUNCTION notify_blocks_insert()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    payload TEXT := JSON_BUILD_OBJECT('chain_id', new.chain_id, 'block_number', new.block_number)::TEXT;
BEGIN
    PERFORM pg_notify('blocks_insert', payload);
    PERFORM pg_notify('blocks', payload);
    RETURN new;
END;
$$;

CREATE FUNCTION notify_blocks_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    payload TEXT := JSON_BUILD_OBJECT('chain_id', old.chain_id, 'block_number', old.block_number)::TEXT;
BEGIN
    PERFORM pg_notify('blocks_delete', payload);
    PERFORM pg_notify('blocks', payload);
    RETURN old;
END;
$$;

CREATE TRIGGER blocks_insert_notification
    AFTER INSERT
    ON blocks
    FOR EACH ROW
EXECUTE FUNCTION notify_blocks_insert();

CREATE TRIGGER blocks_delete_notification
    AFTER DELETE
    ON blocks
    FOR EACH ROW
EXECUTE FUNCTION notify_blocks_delete();
