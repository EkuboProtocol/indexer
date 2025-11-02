CREATE TABLE nonfungible_token_transfers (
	chain_id int8 NOT NULL,
	block_number int8 NOT NULL,
	transaction_index int4 NOT NULL,
	event_index int4 NOT NULL,
	transaction_hash numeric NOT NULL,
	emitter numeric NOT NULL,
	event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
	token_id numeric NOT NULL,
	from_address numeric NOT NULL,
	to_address numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE INDEX ON nonfungible_token_transfers (chain_id, emitter, token_id, event_id DESC);

CREATE TRIGGER no_updates_nonfungible_token_transfers
	BEFORE UPDATE ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE nonfungible_token_owners (
	chain_id int8 NOT NULL,
	nft_address numeric NOT NULL,
	token_id numeric NOT NULL,
	last_transfer_event_id int8 NOT NULL,
	current_owner numeric NOT NULL,
	previous_owner numeric NOT NULL,
	PRIMARY KEY (chain_id, nft_address, token_id)
);

CREATE OR REPLACE FUNCTION nft_owner_apply_transfer()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO nonfungible_token_owners (
        chain_id, nft_address, token_id,
        current_owner, previous_owner, last_transfer_event_id
    ) VALUES (
        NEW.chain_id, NEW.emitter, NEW.token_id,
        NEW.to_address, NEW.from_address, NEW.event_id
    )
    ON CONFLICT (chain_id, nft_address, token_id)
    DO UPDATE
    SET
        previous_owner = nonfungible_token_owners.current_owner,
        current_owner = EXCLUDED.current_owner,
        last_transfer_event_id = EXCLUDED.last_transfer_event_id
    WHERE EXCLUDED.last_transfer_event_id > nonfungible_token_owners.last_transfer_event_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Undo transfer (only if deleted event was the head)
CREATE OR REPLACE FUNCTION nft_owner_rollback_transfer()
RETURNS TRIGGER AS $$
DECLARE
    v_last record;
BEGIN
    -- If this delete removes the head event, clear and recalc
    UPDATE nonfungible_token_owners o
    SET last_transfer_event_id = 0
    WHERE o.chain_id = OLD.chain_id
      AND o.nft_address = OLD.emitter
      AND o.token_id = OLD.token_id
      AND o.last_transfer_event_id = OLD.event_id;

    IF FOUND THEN
        -- Find the new latest event
        SELECT
            t.event_id,
            t.to_address AS current_owner,
            t.from_address AS previous_owner
        INTO v_last
        FROM nonfungible_token_transfers t
        WHERE t.chain_id = OLD.chain_id
          AND t.emitter = OLD.emitter
          AND t.token_id = OLD.token_id
        ORDER BY t.event_id DESC
        LIMIT 1;

        IF v_last IS NULL THEN
            -- No transfers remain → NFT no longer exists in state
            DELETE FROM nonfungible_token_owners
            WHERE chain_id = OLD.chain_id
              AND nft_address = OLD.emitter
              AND token_id = OLD.token_id;
        ELSE
            -- Restore state to last existing transfer
            UPDATE nonfungible_token_owners
            SET
                current_owner = v_last.current_owner,
                previous_owner = v_last.previous_owner,
                last_transfer_event_id = v_last.event_id
            WHERE chain_id = OLD.chain_id
              AND nft_address = OLD.emitter
              AND token_id = OLD.token_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;


-- Ownership forward index trigger
CREATE TRIGGER trg_nft_owner_apply
	AFTER INSERT ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION nft_owner_apply_transfer();

-- Ownership rewind trigger
CREATE TRIGGER trg_nft_owner_revert
	AFTER DELETE ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION nft_owner_rollback_transfer();
