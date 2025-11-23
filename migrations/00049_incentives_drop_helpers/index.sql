-- Helper objects for incentives drops
CREATE OR REPLACE VIEW incentives.campaign_drop_cadences AS
WITH campaign_info AS (SELECT c.id,
                              c.slug,
                              c.chain_id,
                              c.minimum_allocation,
                              c.start_time,
                              c.end_time,
                              c.distribution_cadence,
                              GREATEST(
                                      0,
                                      FLOOR(
                                              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.start_time)) /
                                              NULLIF(EXTRACT(EPOCH FROM c.distribution_cadence), 0)
                                      )
                              )::INT AS num_distributions
                       FROM incentives.campaigns c),
     cadences AS (SELECT ci.id                                    AS campaign_id,
                         GENERATE_SERIES(0, ci.num_distributions) AS cadence_id,
                         ci.start_time,
                         ci.end_time,
                         ci.distribution_cadence
                  FROM campaign_info ci),
     cadence_windows AS (SELECT c.campaign_id,
                                c.cadence_id,
                                CASE
                                    WHEN c.cadence_id = 0 THEN COALESCE((SELECT MIN(crp2.start_time)
                                                                         FROM incentives.campaign_reward_periods crp2
                                                                         WHERE crp2.campaign_id = c.campaign_id),
                                                                        c.start_time)
                                    ELSE c.start_time + c.distribution_cadence * c.cadence_id
                                    END AS cadence_start,
                                CASE
                                    WHEN c.end_time IS NULL
                                        THEN c.start_time + c.distribution_cadence * (c.cadence_id + 1)
                                    ELSE LEAST(c.start_time + c.distribution_cadence * (c.cadence_id + 1), c.end_time)
                                    END AS cadence_end
                         FROM cadences c),
     cadence_periods AS (SELECT crp.campaign_id,
                                cw.cadence_id,
                                ARRAY_AGG(crp.id ORDER BY crp.start_time)                           AS period_ids,
                                BOOL_AND(crp.rewards_last_computed_at IS NOT NULL)                  AS has_been_computed,
                                BOOL_AND(crp.id IN (SELECT campaign_reward_period_id
                                                    FROM incentives.generated_drop_reward_periods)) AS has_been_dropped,
                                MIN(crp.start_time)                                                 AS first_start_time,
                                MAX(crp.end_time)                                                   AS last_end_time
                         FROM incentives.campaign_reward_periods crp
                                  JOIN cadence_windows cw ON crp.campaign_id = cw.campaign_id
                             AND crp.start_time >= cw.cadence_start
                             AND crp.end_time >= cw.cadence_start
                             AND (cw.cadence_end IS NULL OR crp.start_time <= cw.cadence_end)
                             AND (cw.cadence_end IS NULL OR crp.end_time <= cw.cadence_end)
                         GROUP BY crp.campaign_id, cw.cadence_id)
SELECT ci.id AS campaign_id,
       ci.chain_id,
       ci.slug,
       ci.minimum_allocation,
       cp.period_ids,
       cp.first_start_time,
       cp.last_end_time,
       has_been_computed,
       has_been_dropped
FROM cadence_periods cp
         JOIN cadence_windows cw ON cp.campaign_id = cw.campaign_id AND cp.cadence_id = cw.cadence_id
         JOIN campaign_info ci ON ci.id = cp.campaign_id
WHERE cp.first_start_time IS NOT DISTINCT FROM cw.cadence_start
  AND cp.last_end_time IS NOT DISTINCT FROM cw.cadence_end;

CREATE OR REPLACE VIEW incentives.pending_drop_cadences AS
SELECT campaign_id,
       chain_id,
       slug,
       minimum_allocation,
       period_ids,
       first_start_time,
       last_end_time
FROM incentives.campaign_drop_cadences
WHERE has_been_computed
  AND NOT has_been_dropped;

CREATE OR REPLACE VIEW incentives.pending_reward_periods AS
WITH latest_blocks AS (SELECT chain_id,
                              MAX(block_time) AS latest_block_time
                       FROM blocks
                       GROUP BY chain_id)
SELECT crp.id AS reward_period_id,
       crp.campaign_id,
       c.slug,
       c.chain_id,
       crp.token0,
       crp.token1,
       crp.start_time,
       crp.end_time,
       c.reward_token
FROM incentives.campaign_reward_periods crp
         JOIN incentives.campaigns c ON c.id = crp.campaign_id
         JOIN latest_blocks lb ON lb.chain_id = c.chain_id
WHERE crp.rewards_last_computed_at IS NULL
  AND lb.latest_block_time > crp.end_time;

CREATE OR REPLACE FUNCTION incentives.drop_allocations(
    p_reward_period_ids BIGINT[]
)
    RETURNS TABLE
            (
                recipient NUMERIC,
                amount    NUMERIC
            )
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_chain_id             int8;
    v_distinct_chain_count INT;
BEGIN
    IF ARRAY_LENGTH(p_reward_period_ids, 1) = 0 THEN
        RAISE EXCEPTION 'At least one reward period id is required';
    END IF;

    SELECT MIN(c.chain_id),
           COUNT(DISTINCT c.chain_id)
    INTO v_chain_id, v_distinct_chain_count
    FROM incentives.campaign_reward_periods crp
             JOIN incentives.campaigns c ON c.id = crp.campaign_id
    WHERE crp.id = ANY (p_reward_period_ids);

    IF v_distinct_chain_count IS NULL THEN
        RAISE EXCEPTION 'Reward periods % not found', p_reward_period_ids;
    END IF;

    RETURN QUERY
        WITH reward_periods AS (SELECT crp.id, crp.end_time
                                FROM incentives.campaign_reward_periods crp
                                WHERE crp.id = ANY (p_reward_period_ids)),
             rewards_by_locker_salt AS (SELECT locker,
                                               salt,
                                               SUM(reward_amount) AS total
                                        FROM incentives.computed_rewards
                                        WHERE campaign_reward_period_id IN (SELECT id FROM reward_periods)
                                        GROUP BY locker, salt),
             last_period_end AS (SELECT MAX(end_time) AS last_end_time
                                 FROM reward_periods),
             ranked_transfers AS (SELECT ntt.emitter                                                              AS nft_address,
                                         COALESCE(nlm.locker, ntt.emitter)                                        AS locker,
                                         ntt.token_id,
                                         ntt.to_address,
                                         ROW_NUMBER()
                                         OVER (PARTITION BY ntt.emitter, ntt.token_id ORDER BY ntt.event_id DESC) AS row_no
                                  FROM nonfungible_token_transfers ntt
                                           JOIN blocks b USING (chain_id, block_number)
                                           LEFT JOIN nft_locker_mappings nlm
                                                     ON nlm.chain_id = ntt.chain_id AND nlm.nft_address = ntt.emitter,
                                       last_period_end lpe
                                  WHERE ntt.chain_id = v_chain_id
                                    AND ntt.to_address != 0
                                    AND b.block_time < lpe.last_end_time),
             token_owners AS (SELECT nft_address, locker, token_id, to_address AS owner
                              FROM ranked_transfers
                              WHERE row_no = 1)
        SELECT COALESCE(t_o.owner, rbls.locker) AS recipient,
               FLOOR(SUM(rbls.total))           AS amount
        FROM rewards_by_locker_salt rbls
                 LEFT JOIN token_owners t_o ON t_o.token_id = rbls.salt AND rbls.locker = t_o.locker
        GROUP BY 1
        ORDER BY 2 DESC;
END;
$$;
