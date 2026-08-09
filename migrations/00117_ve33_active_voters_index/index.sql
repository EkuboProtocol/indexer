CREATE INDEX ve33_pool_vote_states_active_by_extension
    ON ve33_pool_vote_states (chain_id, emitter)
    INCLUDE (owner, event_id, weight)
    WHERE weight > 0;
