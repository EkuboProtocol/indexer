CREATE TABLE staker_staked (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    from_address numeric NOT NULL,
    amount numeric NOT NULL,
    delegate numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);
CREATE INDEX ON staker_staked (chain_id, emitter, delegate, from_address);
CREATE INDEX ON staker_staked (chain_id, emitter, from_address, delegate);

CREATE TRIGGER no_updates_staker_staked
	BEFORE UPDATE ON staker_staked
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
    
CREATE TABLE staker_withdrawn (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    from_address numeric NOT NULL,
    amount numeric NOT NULL,
    recipient numeric NOT NULL,
    delegate numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);
CREATE INDEX ON staker_withdrawn (chain_id, emitter, delegate, from_address);
CREATE INDEX ON staker_withdrawn (chain_id, emitter, from_address, delegate);

CREATE TRIGGER no_updates_staker_withdrawn
	BEFORE UPDATE ON staker_withdrawn
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE governor_reconfigured (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    version bigint NOT NULL,
    voting_start_delay bigint NOT NULL,
    voting_period bigint NOT NULL,
    voting_weight_smoothing_duration bigint NOT NULL,
    quorum numeric NOT NULL,
    proposal_creation_threshold numeric NOT NULL,
    execution_delay bigint NOT NULL,
    execution_window bigint NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_governor_reconfigured_chain_id_version ON governor_reconfigured (chain_id, emitter, version);

CREATE TRIGGER no_updates_governor_reconfigured
	BEFORE UPDATE ON governor_reconfigured
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
CREATE TABLE governor_proposed (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    proposal_id numeric NOT NULL,
    proposer numeric NOT NULL,
    config_version bigint NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE,
    UNIQUE(chain_id, emitter, proposal_id)
);
CREATE UNIQUE INDEX idx_governor_proposed_chain_id_id ON governor_proposed (chain_id, emitter, proposal_id);

CREATE TRIGGER no_updates_governor_proposed
	BEFORE UPDATE ON governor_proposed
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
CREATE TABLE governor_proposed_calls (
    chain_id int8 NOT NULL,
    emitter numeric NOT NULL,
    proposal_id numeric NOT NULL,
    index int2 NOT NULL,
    to_address numeric NOT NULL,
    selector numeric NOT NULL,
    calldata numeric [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, INDEX),
    FOREIGN KEY (chain_id, emitter, proposal_id) REFERENCES governor_proposed (chain_id, emitter, proposal_id) ON DELETE CASCADE
);
CREATE TABLE governor_canceled (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    proposal_id numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
    UNIQUE (chain_id, emitter, proposal_id)
);
CREATE UNIQUE INDEX idx_governor_canceled_chain_id_id ON governor_canceled (chain_id, proposal_id);

CREATE TRIGGER no_updates_governor_canceled
	BEFORE UPDATE ON governor_canceled
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE governor_voted (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    proposal_id numeric NOT NULL,
    voter numeric NOT NULL,
    weight numeric NOT NULL,
    yea boolean NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_governor_voted
	BEFORE UPDATE ON governor_voted
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE governor_executed (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    proposal_id numeric NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE,
    UNIQUE (chain_id, emitter, proposal_id)
);

CREATE TRIGGER no_updates_governor_executed
	BEFORE UPDATE ON governor_executed
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();

CREATE TABLE governor_executed_results (
    chain_id int8 NOT NULL,
    emitter numeric NOT NULL,
    proposal_id numeric NOT NULL,
    index int2 NOT NULL,
    results numeric [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, INDEX),
    FOREIGN KEY (chain_id, emitter, proposal_id) REFERENCES governor_executed (chain_id, emitter, proposal_id) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_governor_executed_results
	BEFORE UPDATE ON governor_executed_results
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
    
CREATE TABLE governor_proposal_described (
    chain_id int8 NOT NULL,
    block_number int8 NOT NULL,
    transaction_index int4 NOT NULL,
    event_index int4 NOT NULL,
    transaction_hash numeric NOT NULL,
    emitter numeric NOT NULL,
    event_id int8 GENERATED ALWAYS AS (compute_event_id(block_number, transaction_index, event_index)) STORED,
    proposal_id numeric NOT NULL,
    description text NOT NULL,
    PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_governor_proposal_described
	BEFORE UPDATE ON governor_proposal_described
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
