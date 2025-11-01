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

CREATE TRIGGER no_updates_nonfungible_token_transfers
	BEFORE UPDATE ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE nonfungible_token_owners (
	chain_id int8 NOT NULL,
	nft_address numeric NOT NULL,
	token_id numeric NOT NULL,
	current_owner numeric NOT NULL,
	previous_owner numeric NOT NULL,
	PRIMARY KEY (chain_id, nft_address, token_id)
);

CREATE OR REPLACE FUNCTION nft_owner_apply_transfer ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_nft_address numeric := NEW.emitter;
BEGIN
	-- Generic UPSERT (no mint/burn branches)
	INSERT INTO nonfungible_token_owners (chain_id, nft_address, token_id, current_owner, previous_owner)
		VALUES (NEW.chain_id, v_nft_address, NEW.token_id, NEW.to_address, NEW.from_address)
	ON CONFLICT (chain_id, nft_address, token_id)
		DO UPDATE SET
			previous_owner = nonfungible_token_owners.current_owner, current_owner = EXCLUDED.current_owner;
	RETURN NEW;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION nft_owner_rollback_transfer ()
	RETURNS TRIGGER
	AS $$
DECLARE
	v_nft_address numeric := OLD.emitter;
	v_last record;
BEGIN
	-- get latest remaining transfer for this token
	SELECT
		t.to_address,
		t.from_address INTO v_last
	FROM
		nonfungible_token_transfers t
	WHERE
		t.chain_id = OLD.chain_id
		AND t.token_id = OLD.token_id
		AND t.emitter = v_nft_address
	ORDER BY
		t.event_id DESC
	LIMIT 1;
	-- if no transfers remain, token never existed → remove owner row
	IF v_last IS NULL THEN
		DELETE FROM nonfungible_token_owners
		WHERE chain_id = OLD.chain_id
			AND nft_address = v_nft_address
			AND token_id = OLD.token_id;
		RETURN OLD;
	END IF;
	-- otherwise set state to the latest surviving transfer
	UPDATE
		nonfungible_token_owners
	SET
		current_owner = v_last.to_address,
		previous_owner = v_last.from_address
	WHERE
		chain_id = OLD.chain_id
		AND nft_address = v_nft_address
		AND token_id = OLD.token_id;
	RETURN OLD;
END;
$$
LANGUAGE plpgsql;

-- Forward ownership updates
CREATE TRIGGER trg_nft_owner_apply
	AFTER INSERT ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION nft_owner_apply_transfer ();

-- Reverse ownership updates
CREATE TRIGGER trg_nft_owner_revert
	AFTER DELETE ON nonfungible_token_transfers
	FOR EACH ROW
	EXECUTE FUNCTION nft_owner_rollback_transfer ();
