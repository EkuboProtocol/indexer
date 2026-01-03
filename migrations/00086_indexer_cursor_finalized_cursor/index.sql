ALTER TABLE indexer_cursor
    ADD COLUMN finalized_order_key  int8,
    ADD COLUMN finalized_unique_key NUMERIC;

CREATE OR REPLACE FUNCTION reset_indexer_cursor(p_chain_id int8, p_block_number int8)
    RETURNS VOID
    LANGUAGE plpgsql
AS
$$
BEGIN
    UPDATE indexer_cursor
    SET order_key    = p_block_number,
        unique_key   = (SELECT block_hash
                        FROM blocks b
                        WHERE b.chain_id = p_chain_id
                          AND b.block_number = p_block_number),
        last_updated = NOW()
    WHERE chain_id = p_chain_id;

    DELETE
    FROM swaps
    WHERE chain_id = p_chain_id
      AND block_number > p_block_number;

    DELETE
    FROM pool_balance_change
    WHERE chain_id = p_chain_id
      AND block_number > p_block_number;

    DELETE
    FROM position_updates
    WHERE chain_id = p_chain_id
      AND block_number > p_block_number;

    DELETE
    FROM blocks
    WHERE chain_id = p_chain_id
      AND block_number > p_block_number;
END;
$$;
