
CREATE VIEW proposal_delegate_voting_weights_view AS (
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
                        JOIN blocks bl USING (chain_id, block_number)
                    WHERE bl.block_time BETWEEN pt.proposal_time AND pt.vote_start
                    UNION ALL
                    SELECT w.delegate,
                        bl.block_time as "time",
                        - w.amount AS delta
                    FROM staker_withdrawn w
                        JOIN blocks bl USING (chain_id, block_number)
                    WHERE bl.block_time BETWEEN pt.proposal_time AND pt.vote_start
                    UNION ALL
                    -- “bootstrap” each delegate's stake at proposal_time
                    SELECT s2.delegate,
                        pt.proposal_time AS "time",
                        sum(s2.amount) AS delta
                    FROM staker_staked s2
                        JOIN blocks bl2 USING (chain_id, block_number)
                    WHERE bl2.block_time < pt.proposal_time
                    GROUP BY s2.delegate
                    UNION ALL
                    SELECT w2.delegate,
                        pt.proposal_time AS "time",
                        - sum(w2.amount) AS delta
                    FROM staker_withdrawn w2
                        JOIN blocks bl3 USING (chain_id, block_number)
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

SELECT
	cron.schedule ('refresh_proposal_delegate_voting_weights', '0 * * * *', $$
		SELECT
			safe_refresh_mv ('proposal_delegate_voting_weights_materialized');

$$);
