CREATE OR REPLACE VIEW incentives.campaign_rewards_overview AS
WITH campaign_info AS (
    SELECT
        crp.campaign_id,
        c.chain_id,
        GREATEST(
            c.start_time + INTERVAL '24 hours',
            LEAST(CURRENT_TIMESTAMP + INTERVAL '24 hours', MAX(crp.end_time))
        ) AS latest_end_time,
        c.start_time
    FROM
        incentives.campaign_reward_periods crp
        JOIN incentives.campaigns c ON crp.campaign_id = c.id
    GROUP BY
        c.chain_id,
        crp.campaign_id,
        c.start_time
),
rewards_by_token AS (
    SELECT
        crp.campaign_id,
        ci.chain_id,
        crp.token0,
        crp.token1,
        SUM(
            CASE
                WHEN crp.rewards_last_computed_at IS NULL THEN 0
                ELSE token0_reward_amount + token1_reward_amount
            END
        ) AS distributed,
        SUM(
            CASE
                WHEN crp.end_time <= ci.latest_end_time
                    AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                    THEN token0_reward_amount
                ELSE 0
            END
        ) AS daily_rewards_token0,
        SUM(
            CASE
                WHEN crp.end_time <= ci.latest_end_time
                    AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                    THEN token1_reward_amount
                ELSE 0
            END
        ) AS daily_rewards_token1,
        SUM(
            CASE
                WHEN crp.end_time <= ci.latest_end_time
                    AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                    THEN token0_reward_amount + token1_reward_amount
                ELSE 0
            END
        ) AS daily_rewards,
        SUM(token0_reward_amount + token1_reward_amount) AS scheduled,
        AVG(
            CASE
                WHEN crp.end_time <= ci.latest_end_time
                    AND crp.end_time > (ci.latest_end_time - INTERVAL '24 hours')
                    THEN crp.realized_volatility
            END
        ) AS realized_volatility
    FROM
        incentives.campaign_reward_periods crp
        JOIN campaign_info ci ON crp.campaign_id = ci.campaign_id
    GROUP BY
        crp.campaign_id,
        ci.chain_id,
        crp.token0,
        crp.token1
),
depth_per_campaign_pair AS (
    SELECT
        rbt.campaign_id,
        rbt.chain_id,
        rbt.token0,
        rbt.token1,
        MAX(depth_percent) AS depth_percent,
        SUM(pd.depth0) AS depth0,
        SUM(pd.depth1) AS depth1
    FROM
        rewards_by_token rbt
        LEFT JOIN LATERAL (
            SELECT
                MAX(depth_percent) AS depth_percent,
                MAX(depth0) AS depth0,
                MAX(depth1) AS depth1
            FROM
                pool_market_depth_materialized pmd
                JOIN pool_keys pk ON pmd.pool_key_id = pk.pool_key_id
                JOIN incentives.campaigns c ON rbt.campaign_id = c.id
            WHERE
                pmd.depth_percent <= rbt.realized_volatility * 2
                AND pk.chain_id = c.chain_id
                AND pk.token0 = rbt.token0
                AND pk.token1 = rbt.token1
                AND pk.pool_extension = ANY (c.allowed_extensions)
            GROUP BY
                pk.pool_key_id
        ) AS pd ON TRUE
    GROUP BY
        rbt.campaign_id,
        rbt.chain_id,
        rbt.token0,
        rbt.token1
),
campaign_rewards AS (
    SELECT
        rbt.campaign_id,
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
    FROM
        rewards_by_token rbt
        JOIN incentives.campaigns c ON rbt.campaign_id = c.id
        LEFT JOIN depth_per_campaign_pair dpcp ON rbt.campaign_id = dpcp.campaign_id
            AND rbt.token0 = dpcp.token0
            AND rbt.token1 = dpcp.token1
    GROUP BY
        rbt.campaign_id,
        rbt.chain_id
)
SELECT
    c.chain_id,
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
                CURRENT_TIMESTAMP + c.distribution_cadence - INTERVAL '12 hours',
                c.start_time
            ) + INTERVAL '12 hours'
    END AS next_drop_time,
    (
        SELECT
            JSONB_AGG(ae::TEXT)
        FROM
            UNNEST(c.allowed_extensions) AS t(ae)
    ) AS allowed_extensions,
    campaign_rewards.rewards
FROM
    incentives.campaigns c
    JOIN campaign_rewards ON campaign_rewards.campaign_id = c.id;
