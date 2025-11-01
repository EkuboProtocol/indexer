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
    PRIMARY KEY (chain_id, event_id)
);
CREATE INDEX ON staker_staked (delegate, from_address);
CREATE INDEX ON staker_staked (from_address, delegate);

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
    PRIMARY KEY (chain_id, event_id)
);
CREATE INDEX ON staker_withdrawn (delegate, from_address);
CREATE INDEX ON staker_withdrawn (from_address, delegate);

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
    UNIQUE (chain_id, version)
);
CREATE UNIQUE INDEX idx_governor_reconfigured_chain_id_version ON governor_reconfigured (chain_id, version);

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
    UNIQUE (chain_id, proposal_id)
);
CREATE UNIQUE INDEX idx_governor_proposed_chain_id_id ON governor_proposed (chain_id, proposal_id);

CREATE TRIGGER no_updates_governor_proposed
	BEFORE UPDATE ON governor_proposed
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
CREATE TABLE governor_proposed_calls (
    chain_id int8 NOT NULL,
    proposal_id numeric NOT NULL,
    index int2 NOT NULL,
    to_address numeric NOT NULL,
    selector numeric NOT NULL,
    calldata numeric [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, INDEX),
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, proposal_id)
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
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, proposal_id),
    UNIQUE (chain_id, proposal_id)
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
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, proposal_id)
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
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, proposal_id),
    UNIQUE (chain_id, proposal_id)
);
CREATE UNIQUE INDEX idx_governor_executed_chain_id_id ON governor_executed (chain_id, proposal_id);

CREATE TRIGGER no_updates_governor_executed
	BEFORE UPDATE ON governor_executed
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
CREATE TABLE governor_executed_results (
    chain_id int8 NOT NULL,
    proposal_id numeric NOT NULL,
    index int2 NOT NULL,
    results numeric [] NOT NULL,
    PRIMARY KEY (chain_id, proposal_id, INDEX),
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_executed (chain_id, proposal_id)
);
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
    FOREIGN KEY (chain_id, proposal_id) REFERENCES governor_proposed (chain_id, proposal_id)
);

CREATE TRIGGER no_updates_governor_proposal_described
	BEFORE UPDATE ON governor_proposal_described
	FOR EACH ROW
	EXECUTE FUNCTION block_updates();
CREATE OR REPLACE VIEW proposal_delegate_voting_weights_view AS (
        WITH proposal_times AS (
            SELECT gp.proposal_id AS proposal_id,
                b.block_time AS proposal_time,
                b.block_time + gr.voting_start_delay * INTERVAL '1 second' AS vote_start,
                gr.voting_start_delay AS window_secs
            FROM governor_proposed gp
                JOIN blocks b ON b.chain_id = gp.chain_id AND b.block_number = gp.block_number
                JOIN governor_reconfigured gr ON gp.config_version = gr.version
        )
        SELECT pt.proposal_id,
            ev.delegate,
            -- integral(stake * dt)/window_secs
            floor(ev.weighted_time_sum / pt.window_secs) AS voting_weight
        FROM proposal_times pt
            JOIN LATERAL (
                WITH events AS (
                    -- all stake/unstake deltas inside window
                    SELECT s.delegate,
                        bl.block_time as "time",
                        s.amount AS delta
                    FROM staker_staked s
                        JOIN blocks bl ON bl.chain_id = s.chain_id AND bl.block_number = s.block_number
                    WHERE bl.block_time BETWEEN pt.proposal_time AND pt.vote_start
                    UNION ALL
                    SELECT w.delegate,
                        bl.block_time as "time",
                        - w.amount AS delta
                    FROM staker_withdrawn w
                        JOIN blocks bl ON bl.chain_id = w.chain_id AND bl.block_number = w.block_number
                    WHERE bl.block_time BETWEEN pt.proposal_time AND pt.vote_start
                    UNION ALL
                    -- “bootstrap” each delegate's stake at proposal_time
                    SELECT s2.delegate,
                        pt.proposal_time AS "time",
                        sum(s2.amount) AS delta
                    FROM staker_staked s2
                        JOIN blocks bl2 ON bl2.chain_id = s2.chain_id AND bl2.block_number = s2.block_number
                    WHERE bl2.block_time < pt.proposal_time
                    GROUP BY s2.delegate
                    UNION ALL
                    SELECT w2.delegate,
                        pt.proposal_time AS "time",
                        - sum(w2.amount) AS delta
                    FROM staker_withdrawn w2
                        JOIN blocks bl3 ON bl3.chain_id = w2.chain_id AND bl3.block_number = w2.block_number
                    WHERE bl3.block_time < pt.proposal_time
                    GROUP BY w2.delegate
                    UNION ALL
                    -- sentinel at vote_start to cap last interval
                    SELECT d.delegate,
                        pt.vote_start AS "time",
                        0::numeric AS delta
                    FROM (
                            SELECT delegate
                            FROM staker_staked
                            UNION
                            SELECT delegate
                            FROM staker_withdrawn
                        ) d
                ),
                -- running total = current stake for each delegate at each event‐time
                stake_running AS (
                    SELECT delegate,
                        "time",
                        sum(delta) OVER (
                            PARTITION BY delegate
                            ORDER BY "time" ROWS UNBOUNDED PRECEDING
                        ) AS stake_amount
                    FROM events
                ),
                -- break into intervals [time, next_time) with constant stake_amount
                intervals AS (
                    SELECT delegate,
                        "time" AS start_time,
                        lead("time") OVER (
                            PARTITION BY delegate
                            ORDER BY "time"
                        ) AS end_time,
                        stake_amount
                    FROM stake_running
                ) -- integrate stake_amount * duration
                SELECT delegate,
                    sum(
                        stake_amount * extract(
                            EPOCH
                            FROM (end_time - start_time)
                        )
                    ) AS weighted_time_sum
                FROM intervals
                WHERE end_time IS NOT NULL
                GROUP BY delegate
            ) ev ON TRUE
        ORDER BY pt.proposal_id,
            ev.delegate
    );
CREATE MATERIALIZED VIEW proposal_delegate_voting_weights_materialized AS (
    SELECT proposal_id,
        delegate,
        voting_weight
    FROM proposal_delegate_voting_weights_view
);
CREATE UNIQUE INDEX idx_proposal_delegate_voting_weights_unique ON proposal_delegate_voting_weights_materialized (proposal_id, delegate);
