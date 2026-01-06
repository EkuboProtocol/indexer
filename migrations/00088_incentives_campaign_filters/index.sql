ALTER TABLE incentives.campaigns
    ADD COLUMN IF NOT EXISTS core_address    NUMERIC,
    ADD COLUMN IF NOT EXISTS allowed_lockers NUMERIC[];

WITH candidate_core_addresses AS (SELECT c.id  AS campaign_id,
                                         pk.core_address,
                                         ROW_NUMBER() OVER (
                                             PARTITION BY c.id
                                             ORDER BY COUNT(*) DESC, pk.core_address
                                             ) AS rn
                                  FROM incentives.campaigns c
                                           JOIN incentives.campaign_reward_periods crp ON crp.campaign_id = c.id
                                           JOIN pool_keys pk
                                                ON pk.chain_id = c.chain_id
                                                    AND pk.token0 = crp.token0
                                                    AND pk.token1 = crp.token1
                                                    AND pk.pool_extension = ANY (c.allowed_extensions)
                                  GROUP BY c.id, pk.core_address)
UPDATE incentives.campaigns c
SET core_address = cca.core_address
FROM candidate_core_addresses cca
WHERE cca.rn = 1
  AND cca.campaign_id = c.id;

ALTER TABLE incentives.campaigns
    ALTER COLUMN core_address SET NOT NULL;

ALTER TABLE incentives.campaigns
    DROP COLUMN IF EXISTS excluded_locker_salts;

CREATE OR REPLACE FUNCTION incentives.create_campaign(p_chain_id int8, p_name TEXT, p_slug VARCHAR(20),
                                                      p_start_time timestamptz, p_end_time timestamptz,
                                                      p_interval INTERVAL, p_reward_token NUMERIC,
                                                      p_pairs incentives.token_pair_budget[],
                                                      p_default_fee_denominator NUMERIC, p_core_address NUMERIC,
                                                      p_allowed_extensions NUMERIC[] DEFAULT '{0}',
                                                      p_percent_step DOUBLE PRECISION DEFAULT NULL,
                                                      p_max_coverage DOUBLE PRECISION DEFAULT NULL,
                                                      p_allowed_lockers NUMERIC[] DEFAULT NULL)
    RETURNS BIGINT
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_campaign_id  BIGINT;
    v_total_budget NUMERIC := 0;
    v_periods      INTEGER;
    v_pair         incentives.token_pair_budget;
    v_per_period   NUMERIC;
    v_start        timestamptz;
    v_end          timestamptz;
BEGIN
    -- sum all pair-budgets
    FOREACH v_pair IN ARRAY p_pairs
        LOOP
            v_total_budget := v_total_budget + v_pair.budget;
        END LOOP;
    -- insert campaign
    INSERT INTO incentives.campaigns (chain_id, name, slug, start_time, end_time, reward_token, allowed_extensions,
                                      default_fee_denominator, core_address, allowed_lockers)
    VALUES (p_chain_id, p_name, p_slug, p_start_time, p_end_time, p_reward_token, p_allowed_extensions,
            p_default_fee_denominator, p_core_address, p_allowed_lockers)
    RETURNING id INTO v_campaign_id;
    -- compute number of full intervals
    v_periods := CEIL(EXTRACT(EPOCH FROM (p_end_time - p_start_time)) / EXTRACT(EPOCH FROM p_interval))::INT;
    -- for each pair, split its budget evenly over intervals & tokens
    FOREACH v_pair IN ARRAY p_pairs
        LOOP
            v_per_period := v_pair.budget / v_periods;
            v_start := p_start_time;
            FOR _ IN 1..v_periods
                LOOP
                    v_end := LEAST(v_start + p_interval, p_end_time);
                    INSERT INTO incentives.campaign_reward_periods (campaign_id, token0, token1, start_time, end_time,
                                                                    realized_volatility, token0_reward_amount,
                                                                    token1_reward_amount, percent_step, max_coverage)
                    VALUES (v_campaign_id, v_pair.token0, v_pair.token1, v_start, v_end, v_pair.realized_volatility,
                            FLOOR(v_per_period / 2), FLOOR(v_per_period / 2), p_percent_step, p_max_coverage);
                    v_start := v_start + p_interval;
                END LOOP;
        END LOOP;
    RETURN v_campaign_id;
END;
$$;

CREATE OR REPLACE FUNCTION incentives.compute_rewards_for_period_v1(p_reward_period_id BIGINT)
    RETURNS INTEGER
    LANGUAGE plpgsql
AS
$$
DECLARE
    v_rows INTEGER := 0;
BEGIN
    -- only possible if the reward period exists
    PERFORM 1 FROM incentives.campaign_reward_periods WHERE id = p_reward_period_id;
    IF NOT found THEN
        RAISE EXCEPTION 'Campaign reward period % not found', p_reward_period_id;
    END IF;

    -- prevent concurrent computations for the same reward period
    PERFORM PG_ADVISORY_XACT_LOCK(hashtext('compute_rewards_for_period-' || p_reward_period_id));

    -- first clear all the data for this period
    DELETE FROM incentives.computed_rewards WHERE campaign_reward_period_id = p_reward_period_id;

    WITH period_info AS (SELECT c.chain_id,
                                crp.id,
                                crp.start_time,
                                crp.end_time,
                                crp.token0,
                                crp.token1,
                                crp.token0_reward_amount,
                                crp.token1_reward_amount,
                                c.allowed_extensions,
                                c.core_address,
                                c.allowed_lockers,
                                COALESCE(crp.fee_denominator, c.default_fee_denominator)            AS fee_denominator,
                                COALESCE(crp.max_coverage, c.default_max_coverage)                  AS max_coverage,
                                COALESCE(crp.percent_step, c.default_percent_step)                  AS percent_step,
                                ROUND(LOG(EXP(realized_volatility)) / LOG(1.000001))::INT           AS volatility_in_ticks,
                                GREATEST((crp.end_time - crp.start_time)::INTERVAL / 30, '1 hours') AS price_interval
                         FROM incentives.campaign_reward_periods crp
                                  JOIN incentives.campaigns c ON crp.campaign_id = c.id
                         WHERE crp.id = p_reward_period_id),
         min_block_number AS (SELECT b.block_number
                              FROM blocks b,
                                   period_info p
                              WHERE b.chain_id = p.chain_id
                                AND b.block_time >= p.start_time
                              ORDER BY b.block_number
                              LIMIT 1),
         min_event_id AS (SELECT compute_event_id(block_number, 0, 0) AS id
                          FROM min_block_number),
         max_block_number AS (SELECT b.block_number
                              FROM blocks b,
                                   period_info p
                              WHERE p.chain_id = b.chain_id
                                AND b.block_time < p.end_time
                              ORDER BY b.block_number DESC
                              LIMIT 1),
         max_event_id AS (SELECT compute_event_id(block_number, 65535, 65535) AS id
                          FROM max_block_number),
         stddev_multiple_weights AS (SELECT ROW_NUMBER() OVER (ORDER BY multiple)                row_no,
                                            GREATEST(CEIL(volatility_in_ticks * multiple), 1) AS tick_weight,
                                            (incentives.percent_within_std(multiple) - COALESCE(
                                                            LAG(incentives.percent_within_std(multiple))
                                                            OVER (ORDER BY multiple), 0))     AS weight
                                     FROM period_info pi,
                                          UNNEST(incentives.linear_percent_std_multiples(pi.percent_step,
                                                                                         pi.max_coverage)) AS multiple),
         relevant_pool_keys AS (SELECT pk.pool_key_id,
                                       int4(LOG(1::NUMERIC +
                                                (pk.fee / COALESCE(p.fee_denominator, pk.fee_denominator))) /
                                            LOG(1.000001::NUMERIC)) AS mid_distance_in_ticks
                                FROM pool_keys pk
                                         JOIN period_info p ON p.chain_id = pk.chain_id
                                    AND p.token0 = pk.token0
                                    AND p.token1 = pk.token1
                                    AND pk.pool_extension = ANY (p.allowed_extensions)
                                    AND pk.core_address = p.core_address),
         seed_tick AS (SELECT s.tick_after AS tick
                       FROM swaps s
                                JOIN blocks b ON b.chain_id = s.chain_id AND b.block_number = s.block_number
                                JOIN relevant_pool_keys rpkh ON s.pool_key_id = rpkh.pool_key_id,
                            period_info p
                       WHERE b.block_time < p.start_time
                       ORDER BY b.block_time DESC
                       LIMIT 1),
         time_bins AS (SELECT GENERATE_SERIES(
                                      date_bin(p.price_interval, p.start_time, '2000-01-01'::timestamptz),
                                      date_bin(p.price_interval, p.end_time, '2000-01-01'::timestamptz),
                                      p.price_interval
                              ) AS period_start
                       FROM period_info p),
         bin_medians AS (SELECT date_bin(p.price_interval, b.block_time, '2000-01-01'::timestamptz)    AS period_start,
                                ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.tick_after))::int4 AS tick
                         FROM swaps s
                                  JOIN blocks b ON b.chain_id = s.chain_id AND b.block_number = s.block_number
                                  JOIN relevant_pool_keys rpkh ON s.pool_key_id = rpkh.pool_key_id
                                  JOIN period_info p ON TRUE
                         WHERE s.event_id BETWEEN (SELECT id FROM min_event_id) AND (SELECT id FROM max_event_id)
                           AND s.liquidity_after != 0
                         GROUP BY 1),
         interval_pair_prices_without_next_start AS (SELECT tb.period_start,
                                                            COALESCE((SELECT bm.tick
                                                                      FROM bin_medians bm
                                                                      WHERE bm.period_start < tb.period_start
                                                                      ORDER BY bm.period_start DESC
                                                                      LIMIT 1), st.tick) AS tick
                                                     FROM time_bins tb,
                                                          seed_tick st),
         interval_pair_prices AS (SELECT ipp.*,
                                         LEAD(period_start)
                                         OVER (PARTITION BY weights.row_no ORDER BY period_start)     AS next_period_start,
                                         weight,
                                         INT4RANGE(CEIL(ipp.tick - tick_weight)::INT, ipp.tick::INT)  AS stddev_range_lower,
                                         INT4RANGE(ipp.tick::INT, FLOOR(ipp.tick + tick_weight)::INT) AS stddev_range_upper
                                  FROM interval_pair_prices_without_next_start ipp,
                                       period_info,
                                       stddev_multiple_weights weights),
         positions_created_before_start AS (SELECT MAX(event_id)           AS event_id,
                                                   pu.pool_key_id,
                                                   pu.locker,
                                                   pu.salt,
                                                   pu.lower_bound,
                                                   pu.upper_bound,
                                                   SUM(pu.liquidity_delta) AS liquidity_delta
                                            FROM position_updates pu
                                                     JOIN relevant_pool_keys rpkh ON pu.pool_key_id = rpkh.pool_key_id,
                                                 period_info p
                                            WHERE event_id < (SELECT id FROM min_event_id)
                                              AND (p.allowed_lockers IS NULL OR pu.locker = ANY (p.allowed_lockers))
                                            GROUP BY pu.pool_key_id, pu.locker, pu.salt, pu.lower_bound,
                                                     pu.upper_bound),
         positions_created_before_start_with_nonzero_liquidity AS (SELECT *
                                                                   FROM positions_created_before_start
                                                                   WHERE liquidity_delta != 0),
         all_position_updates_in_period AS (SELECT pu.event_id  AS update_event_id,
                                                   pu.pool_key_id,
                                                   pu.locker,
                                                   pu.salt,
                                                   pu.lower_bound,
                                                   pu.upper_bound,
                                                   pu.liquidity_delta,
                                                   p.start_time AS update_time
                                            FROM positions_created_before_start_with_nonzero_liquidity pu,
                                                 period_info p
                                            UNION ALL
                                            SELECT pu.event_id     AS update_event_id,
                                                   pu.pool_key_id,
                                                   pu.locker,
                                                   pu.salt,
                                                   pu.lower_bound,
                                                   pu.upper_bound,
                                                   pu.liquidity_delta,
                                                   pu_b.block_time AS update_time
                                            FROM position_updates pu
                                                     JOIN blocks pu_b
                                                          ON pu_b.chain_id = pu.chain_id AND pu_b.block_number = pu.block_number
                                                     JOIN period_info p ON TRUE
                                            WHERE pu.event_id BETWEEN (SELECT id FROM min_event_id) AND (SELECT id FROM max_event_id)
                                              AND (p.allowed_lockers IS NULL OR pu.locker = ANY (p.allowed_lockers))),
         position_states_during_period AS (SELECT pool_key_id,
                                                  locker,
                                                  salt,
                                                  lower_bound,
                                                  upper_bound,
                                                  SUM(liquidity_delta)
                                                  OVER (PARTITION BY pool_key_id, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS liquidity,
                                                  update_event_id,
                                                  LEAD(update_event_id)
                                                  OVER (PARTITION BY pool_key_id, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_event_id,
                                                  update_time,
                                                  LEAD(update_time)
                                                  OVER (PARTITION BY pool_key_id, locker, salt, lower_bound, upper_bound ORDER BY update_event_id) AS next_update_time
                                           FROM all_position_updates_in_period),
         position_states_during_period_with_intersections AS (SELECT psdp.pool_key_id,
                                                                     locker,
                                                                     salt,
                                                                     psdp.liquidity,
                                                                     CASE
                                                                         WHEN lower_bound < ipp.tick THEN
                                                                             stddev_range_lower * INT4RANGE(
                                                                                     lower_bound -
                                                                                     rpkh.mid_distance_in_ticks,
                                                                                     LEAST(upper_bound, ipp.tick) -
                                                                                     rpkh.mid_distance_in_ticks)
                                                                         ELSE
                                                                             INT4RANGE(ipp.tick, ipp.tick)
                                                                         END            AS tick_range_intersection_lower,
                                                                     CASE
                                                                         WHEN upper_bound > ipp.tick THEN
                                                                             stddev_range_upper * INT4RANGE(
                                                                                     GREATEST(ipp.tick, lower_bound) +
                                                                                     rpkh.mid_distance_in_ticks,
                                                                                     upper_bound +
                                                                                     rpkh.mid_distance_in_ticks)
                                                                         ELSE
                                                                             INT4RANGE(ipp.tick, ipp.tick)
                                                                         END            AS tick_range_intersection_upper,
                                                                     weight,
                                                                     ipp.tick,
                                                                     ROUND(GREATEST(EXTRACT(EPOCH FROM (LEAST(
                                                                                                                COALESCE(psdp.next_update_time, (p.end_time)),
                                                                                                                COALESCE(ipp.next_period_start, (p.end_time))) -
                                                                                                        GREATEST(psdp.update_time, ipp.period_start))),
                                                                                    0)) AS row_seconds
                                                              FROM position_states_during_period psdp
                                                                       JOIN relevant_pool_keys rpkh ON psdp.pool_key_id = rpkh.pool_key_id,
                                                                   interval_pair_prices ipp,
                                                                   period_info p),
         position_depth_per_time AS (SELECT pool_key_id,
                                            locker,
                                            salt,
                                            CASE
                                                WHEN ISEMPTY(tick_range_intersection_lower) THEN 0
                                                ELSE FLOOR(liquidity *
                                                           (POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_lower)) -
                                                            POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_lower))))
                                                END AS amount1_lower,
                                            CASE
                                                WHEN ISEMPTY(tick_range_intersection_upper) THEN 0
                                                ELSE FLOOR(liquidity * ((1::NUMERIC /
                                                                         POWER(1.0000005::NUMERIC, LOWER(tick_range_intersection_upper))) -
                                                                        (1::NUMERIC /
                                                                         POWER(1.0000005::NUMERIC, UPPER(tick_range_intersection_upper)))))
                                                END AS amount0_upper,
                                            row_seconds,
                                            weight
                                     FROM position_states_during_period_with_intersections
                                     WHERE row_seconds > 0),
         position_depth_seconds AS (SELECT pool_key_id,
                                           locker,
                                           salt,
                                           SUM(amount0_upper * row_seconds * weight) AS market_depth_score_lower,
                                           SUM(amount1_lower * row_seconds * weight) AS market_depth_score_upper
                                    FROM position_depth_per_time
                                    GROUP BY pool_key_id, locker, salt),
         position_pair_score_seconds AS (SELECT locker,
                                                salt,
                                                SUM(market_depth_score_lower) AS total_score_lower,
                                                SUM(market_depth_score_upper) AS total_score_upper
                                         FROM position_depth_seconds
                                                  JOIN pool_keys ON pool_keys.pool_key_id = position_depth_seconds.pool_key_id
                                         GROUP BY locker, salt),
         total_score_seconds AS (SELECT SUM(total_score_lower) AS total_lower,
                                        SUM(total_score_upper) AS total_upper
                                 FROM position_pair_score_seconds),
         position_rewards AS (SELECT locker,
                                     salt,
                                     FLOOR(((ppds.total_score_lower / GREATEST(tdspp.total_lower, 1)) *
                                            pi.token0_reward_amount +
                                            (ppds.total_score_upper / GREATEST(tdspp.total_upper, 1)) *
                                            pi.token1_reward_amount)) AS reward_amount
                              FROM position_pair_score_seconds ppds,
                                   total_score_seconds tdspp,
                                   period_info pi)
    INSERT
    INTO incentives.computed_rewards (campaign_reward_period_id, locker, salt, reward_amount)
    SELECT p.id, locker, salt, reward_amount
    FROM position_rewards pr,
         period_info p
    WHERE reward_amount > 0;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    UPDATE incentives.campaign_reward_periods
    SET rewards_last_computed_at = CURRENT_TIMESTAMP
    WHERE id = p_reward_period_id;

    RETURN v_rows;
END;
$$;

DROP MATERIALIZED VIEW IF EXISTS incentives.campaign_rewards_overview_materialized;
DROP VIEW IF EXISTS incentives.campaign_rewards_overview;

CREATE VIEW incentives.campaign_rewards_overview AS
WITH campaign_info AS (SELECT crp.campaign_id,
                              c.chain_id,
                              GREATEST(
                                      c.start_time + INTERVAL '24 hours',
                                      LEAST(CURRENT_TIMESTAMP + INTERVAL '24 hours', MAX(crp.end_time))
                              ) AS latest_end_time,
                              c.start_time
                       FROM incentives.campaign_reward_periods crp
                                JOIN incentives.campaigns c ON crp.campaign_id = c.id
                       GROUP BY c.chain_id,
                                crp.campaign_id,
                                c.start_time),
     rewards_by_token AS (SELECT crp.campaign_id,
                                 ci.chain_id,
                                 crp.token0,
                                 crp.token1,
                                 SUM(
                                         CASE
                                             WHEN crp.rewards_last_computed_at IS NULL THEN 0
                                             ELSE token0_reward_amount + token1_reward_amount
                                             END
                                 )                                                AS distributed,
                                 SUM(
                                         CASE
                                             WHEN crp.end_time <= ci.latest_end_time
                                                 AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                                                 THEN token0_reward_amount
                                             ELSE 0
                                             END
                                 )                                                AS daily_rewards_token0,
                                 SUM(
                                         CASE
                                             WHEN crp.end_time <= ci.latest_end_time
                                                 AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                                                 THEN token1_reward_amount
                                             ELSE 0
                                             END
                                 )                                                AS daily_rewards_token1,
                                 SUM(
                                         CASE
                                             WHEN crp.end_time <= ci.latest_end_time
                                                 AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                                                 THEN token0_reward_amount + token1_reward_amount
                                             ELSE 0
                                             END
                                 )                                                AS daily_rewards,
                                 SUM(token0_reward_amount + token1_reward_amount) AS scheduled,
                                 AVG(
                                         CASE
                                             WHEN crp.end_time <= ci.latest_end_time
                                                 AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                                                 THEN crp.realized_volatility
                                             END
                                 )                                                AS realized_volatility
                          FROM incentives.campaign_reward_periods crp
                                   JOIN campaign_info ci ON crp.campaign_id = ci.campaign_id
                          GROUP BY crp.campaign_id,
                                   ci.chain_id,
                                   crp.token0,
                                   crp.token1),
     depth_per_campaign_pair AS (SELECT rbt.campaign_id,
                                        rbt.chain_id,
                                        rbt.token0,
                                        rbt.token1,
                                        MAX(depth_percent) AS depth_percent,
                                        SUM(pd.depth0)     AS depth0,
                                        SUM(pd.depth1)     AS depth1
                                 FROM rewards_by_token rbt
                                          LEFT JOIN LATERAL (
                                     SELECT MAX(depth_percent) AS depth_percent,
                                            MAX(depth0)        AS depth0,
                                            MAX(depth1)        AS depth1
                                     FROM pool_market_depth_materialized pmd
                                              JOIN pool_keys pk ON pmd.pool_key_id = pk.pool_key_id
                                              JOIN incentives.campaigns c ON rbt.campaign_id = c.id
                                     WHERE pmd.depth_percent <= rbt.realized_volatility * 2
                                       AND pk.chain_id = c.chain_id
                                       AND pk.token0 = rbt.token0
                                       AND pk.token1 = rbt.token1
                                       AND pk.pool_extension = ANY (c.allowed_extensions)
                                       AND pk.core_address = c.core_address
                                     GROUP BY pk.pool_key_id
                                     ) AS pd ON TRUE
                                 GROUP BY rbt.campaign_id,
                                          rbt.chain_id,
                                          rbt.token0,
                                          rbt.token1),
     campaign_rewards AS (SELECT rbt.campaign_id,
                                 rbt.chain_id,
                                 JSONB_AGG(
                                         JSONB_BUILD_OBJECT(
                                                 'token0',
                                                 rbt.token0::TEXT,
                                                 'token1',
                                                 rbt.token1::TEXT,
                                                 'distributed',
                                                 rbt.distributed::TEXT,
                                                 'scheduled',
                                                 rbt.scheduled::TEXT,
                                                 'daily_rewards',
                                                 rbt.daily_rewards::TEXT,
                                                 'daily_rewards_token0',
                                                 rbt.daily_rewards_token0::TEXT,
                                                 'daily_rewards_token1',
                                                 rbt.daily_rewards_token1::TEXT,
                                                 'realized_volatility',
                                                 rbt.realized_volatility::NUMERIC,
                                                 'depth_percent',
                                                 dpcp.depth_percent,
                                                 'depth0',
                                                 dpcp.depth0::TEXT,
                                                 'depth1',
                                                 dpcp.depth1::TEXT
                                         )
                                 ) AS rewards
                          FROM rewards_by_token rbt
                                   JOIN incentives.campaigns c ON rbt.campaign_id = c.id
                                   LEFT JOIN depth_per_campaign_pair dpcp ON rbt.campaign_id = dpcp.campaign_id
                              AND rbt.token0 = dpcp.token0
                              AND rbt.token1 = dpcp.token1
                          GROUP BY rbt.campaign_id,
                                   rbt.chain_id)
SELECT c.chain_id,
       c.core_address,
       c.slug,
       c.start_time,
       c.end_time,
       c.name,
       c.reward_token,
       CASE
           WHEN CURRENT_TIMESTAMP < c.start_time THEN c.start_time + c.distribution_cadence + INTERVAL '12 hours'
           WHEN c.end_time IS NULL
               OR CURRENT_TIMESTAMP < c.end_time THEN date_bin(
                                                              c.distribution_cadence,
                                                              CURRENT_TIMESTAMP + c.distribution_cadence -
                                                              INTERVAL '12 hours',
                                                              c.start_time
                                                      ) + INTERVAL '12 hours'
           END                                      AS next_drop_time,
       (SELECT JSONB_AGG(ae::TEXT)
        FROM UNNEST(c.allowed_extensions) AS t(ae)) AS allowed_extensions,
       CASE
           WHEN c.allowed_lockers IS NULL THEN NULL
           ELSE (SELECT JSONB_AGG(al::TEXT)
                 FROM UNNEST(c.allowed_lockers) AS t(al))
           END                                      AS allowed_lockers,
       campaign_rewards.rewards
FROM incentives.campaigns c
         JOIN campaign_rewards ON campaign_rewards.campaign_id = c.id;

CREATE MATERIALIZED VIEW incentives.campaign_rewards_overview_materialized AS
SELECT *
FROM incentives.campaign_rewards_overview;

CREATE UNIQUE INDEX ON incentives.campaign_rewards_overview_materialized (slug);

DO
$$
    DECLARE
        has_pg_cron BOOLEAN;
        job_id      INT;
    BEGIN
        SELECT EXISTS (SELECT 1
                       FROM pg_extension
                       WHERE extname = 'pg_cron')
        INTO has_pg_cron;

        IF NOT has_pg_cron THEN
            RAISE NOTICE 'pg_cron not installed; skipping campaign rewards overview refresh job.';
            RETURN;
        END IF;

        SELECT jobid
        INTO job_id
        FROM cron.job
        WHERE jobname = 'refresh_campaign_rewards_overview_materialized';

        IF job_id IS NOT NULL THEN
            PERFORM cron.unschedule(job_id);
        END IF;

        PERFORM cron.schedule(
                'refresh_campaign_rewards_overview_materialized',
                '*/5 * * * *',
                'REFRESH MATERIALIZED VIEW CONCURRENTLY incentives.campaign_rewards_overview_materialized'
                );
    END;
$$;

DROP MATERIALIZED VIEW IF EXISTS incentives.computed_rewards_by_position_materialized;

CREATE MATERIALIZED VIEW incentives.computed_rewards_by_position_materialized AS
SELECT c.id                  AS campaign_id,
       c.core_address,
       cr.locker,
       cr.salt,
       SUM(cr.reward_amount) AS total_reward_amount,
       SUM(
               CASE
                   WHEN gdrp.drop_id IS NULL THEN cr.reward_amount
                   ELSE 0
                   END
       )                     AS pending_reward_amount
FROM incentives.campaign_reward_periods crp
         JOIN incentives.campaigns c ON c.id = crp.campaign_id
         JOIN incentives.computed_rewards cr ON cr.campaign_reward_period_id = crp.id
         LEFT JOIN incentives.generated_drop_reward_periods gdrp
                   ON gdrp.campaign_reward_period_id = crp.id
GROUP BY c.id, c.core_address, cr.locker, cr.salt;

CREATE UNIQUE INDEX ON incentives.computed_rewards_by_position_materialized (campaign_id, locker, salt);
