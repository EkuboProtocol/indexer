CREATE OR REPLACE FUNCTION numeric_to_hex(num NUMERIC) RETURNS TEXT
    IMMUTABLE
    LANGUAGE plpgsql
AS
$$
DECLARE
    hex TEXT;
    remainder NUMERIC;
BEGIN
    IF num = 0 THEN
        RETURN '0x0';
    END IF;

    hex := '';
    LOOP
        IF num = 0 THEN
            EXIT;
        END IF;
        remainder := mod(num, 16);
        hex := SUBSTRING('0123456789abcdef' FROM (remainder::INT + 1) FOR 1) || hex;
        num := (num - remainder) / 16;
    END LOOP;

    RETURN '0x' || hex;
END;
$$;

CREATE OR REPLACE FUNCTION calculate_staker_rewards(
    p_start_time timestamptz,
    p_end_time timestamptz,
    p_total_rewards NUMERIC,
    p_staking_share NUMERIC,
    p_delegate_share NUMERIC,
    p_chain_id BIGINT DEFAULT 23448594291968334::BIGINT,
    p_staker_address NUMERIC DEFAULT 1194257563955965460367353409140405763780761879270528111624067674852467116981::NUMERIC,
    p_governor_address NUMERIC DEFAULT 2354502934501836923955011505963489193673442986857363336683304411560511969997::NUMERIC
)
    RETURNS TABLE
            (
                id               BIGINT,
                claimee          TEXT,
                amount           NUMERIC,
                delegate_portion NUMERIC,
                staker_portion   NUMERIC
            )
    LANGUAGE plpgsql
AS
$$
BEGIN
    IF p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'end_time (%) must be after start_time (%)', p_end_time, p_start_time;
    END IF;

    IF p_staking_share < 0 OR p_delegate_share < 0 THEN
        RAISE EXCEPTION 'reward shares must be non-negative';
    END IF;

    IF p_staking_share + p_delegate_share = 0 THEN
        RAISE EXCEPTION 'staking_share + delegate_share must be greater than zero';
    END IF;

    RETURN QUERY
        WITH calculated_parameters AS (
                 SELECT EXTRACT(EPOCH FROM (p_end_time - p_start_time))::NUMERIC AS total_duration_seconds
             ),
             time_points AS (
                 SELECT DISTINCT time
                 FROM (
                          SELECT b.block_time AS time
                          FROM staker_staked s
                                   JOIN blocks b USING (chain_id, block_number)
                          WHERE s.chain_id = p_chain_id
                            AND s.emitter = p_staker_address
                            AND b.block_time BETWEEN p_start_time AND p_end_time

                          UNION ALL

                          SELECT b.block_time AS time
                          FROM staker_withdrawn w
                                   JOIN blocks b USING (chain_id, block_number)
                          WHERE w.chain_id = p_chain_id
                            AND w.emitter = p_staker_address
                            AND b.block_time BETWEEN p_start_time AND p_end_time

                          UNION ALL

                          SELECT p_start_time

                          UNION ALL

                          SELECT p_end_time
                      ) t
             ),
             ordered_time_points AS (
                 SELECT time
                 FROM time_points
                 ORDER BY time
             ),
             intervals AS (
                 SELECT time AS start_time,
                        LEAD(time) OVER (ORDER BY time) AS end_time
                 FROM ordered_time_points
             ),
             raw_stake_changes AS (
                 SELECT b.block_time AS time,
                        s.from_address AS staker,
                        s.amount AS amount_change
                 FROM staker_staked s
                          JOIN blocks b USING (chain_id, block_number)
                 WHERE s.chain_id = p_chain_id
                   AND s.emitter = p_staker_address
                   AND b.block_time <= p_end_time

                 UNION ALL

                 SELECT b.block_time AS time,
                        w.from_address AS staker,
                        -w.amount AS amount_change
                 FROM staker_withdrawn w
                          JOIN blocks b USING (chain_id, block_number)
                 WHERE w.chain_id = p_chain_id
                   AND w.emitter = p_staker_address
                   AND b.block_time <= p_end_time
             ),
             stake_changes AS (
                 SELECT time,
                        staker,
                        SUM(amount_change) AS amount_change
                 FROM raw_stake_changes
                 GROUP BY time, staker
             ),
             stake_events AS (
                 SELECT time,
                        staker,
                        SUM(amount_change) OVER (
                            PARTITION BY staker
                            ORDER BY time
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                            ) AS stake_amount
                 FROM stake_changes
             ),
             stakers AS (
                 SELECT DISTINCT staker
                 FROM stake_events
             ),
             staker_intervals AS (
                 SELECT i.start_time,
                        i.end_time,
                        s.staker,
                        se.stake_amount
                 FROM intervals i
                          JOIN stakers s ON TRUE
                          JOIN LATERAL (
                     SELECT stake_amount
                     FROM stake_events se
                     WHERE se.staker = s.staker
                       AND se.time <= i.start_time
                     ORDER BY se.time DESC
                     LIMIT 1
                     ) se ON TRUE
                 WHERE i.end_time IS NOT NULL
                   AND i.start_time < i.end_time
             ),
             total_stake_per_interval AS (
                 SELECT si.start_time,
                        si.end_time,
                        SUM(si.stake_amount) AS total_stake
                 FROM staker_intervals si
                 GROUP BY si.start_time, si.end_time
             ),
             staker_rewards AS (
                 SELECT si.staker,
                        p_total_rewards * (p_staking_share / (p_staking_share + p_delegate_share))
                            * (
                              EXTRACT(EPOCH FROM (si.end_time - si.start_time))::NUMERIC
                                  / pcp.total_duration_seconds
                              )
                            * (si.stake_amount / tsi.total_stake) AS reward
                 FROM staker_intervals si
                          JOIN total_stake_per_interval tsi
                               ON si.start_time = tsi.start_time
                                   AND si.end_time = tsi.end_time
                          CROSS JOIN calculated_parameters pcp
                 WHERE tsi.total_stake > 0
                   AND si.stake_amount > 0
                   AND EXTRACT(EPOCH FROM (si.end_time - si.start_time)) > 0
             ),
             proposals_in_period AS (
                 SELECT gp.chain_id,
                        gp.emitter,
                        gp.proposal_id
                 FROM governor_proposed gp
                          JOIN blocks b USING (chain_id, block_number)
                 WHERE gp.chain_id = p_chain_id
                   AND gp.emitter = p_governor_address
                   AND b.block_time BETWEEN p_start_time AND p_end_time
             ),
             delegate_total_votes_weight AS (
                 SELECT gv.voter AS delegate,
                        SUM(gv.weight) AS total_weight
                 FROM governor_voted gv
                          JOIN proposals_in_period pip
                               ON gv.chain_id = pip.chain_id
                                   AND gv.emitter = pip.emitter
                                   AND gv.proposal_id = pip.proposal_id
                 WHERE gv.chain_id = p_chain_id
                   AND gv.emitter = p_governor_address
                 GROUP BY gv.voter
             ),
             total_votes_weight_in_period AS (
                 SELECT SUM(total_weight) AS total
                 FROM delegate_total_votes_weight
             ),
             delegate_rewards AS (
                 SELECT dtvw.delegate,
                        dtvw.total_weight * p_total_rewards
                            * (p_delegate_share / (p_staking_share + p_delegate_share))
                            / tvwp.total AS reward
                 FROM delegate_total_votes_weight dtvw
                          CROSS JOIN total_votes_weight_in_period tvwp
                 WHERE tvwp.total > 0
             ),
             total_staker_rewards AS (
                 SELECT staker AS claimee,
                        SUM(reward) AS reward
                 FROM staker_rewards
                 GROUP BY staker
             ),
             all_rewards AS (
                 SELECT delegate AS claimee,
                        reward AS delegate_reward,
                        0::NUMERIC AS staker_reward
                 FROM delegate_rewards

                 UNION ALL

                 SELECT tsr.claimee,
                        0::NUMERIC AS delegate_reward,
                        tsr.reward AS staker_reward
                 FROM total_staker_rewards tsr
             ),
             final_rewards AS (
                 SELECT ar.claimee,
                        SUM(ar.staker_reward) AS total_staker_reward,
                        SUM(ar.delegate_reward) AS total_delegate_reward,
                        SUM(ar.staker_reward) + SUM(ar.delegate_reward) AS total_reward
                 FROM all_rewards ar
                 GROUP BY ar.claimee
             )
        SELECT ROW_NUMBER() OVER (ORDER BY fr.total_reward DESC) - 1 AS id,
               numeric_to_hex(fr.claimee) AS claimee,
               FLOOR(fr.total_reward) AS amount,
               FLOOR(fr.total_delegate_reward) AS delegate_portion,
               FLOOR(fr.total_staker_reward) AS staker_portion
        FROM final_rewards fr
        WHERE fr.total_reward > 0
        ORDER BY fr.total_reward DESC;
END;
$$;
