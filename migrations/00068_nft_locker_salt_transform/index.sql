ALTER TABLE nft_locker_mappings
    ADD COLUMN token_id_transform jsonb,
    ADD CONSTRAINT token_id_transform_ck
        CHECK (token_id_transform IS NULL
            OR (JSONB_TYPEOF(token_id_transform) = 'object'
                AND token_id_transform ? 'bit_mod'
                AND (token_id_transform ->> 'bit_mod') ~ '^[0-9]+$'
                AND (token_id_transform ->> 'bit_mod')::int < 256));

DROP VIEW IF EXISTS nonfungible_token_orders_view;
DROP VIEW IF EXISTS nonfungible_token_positions_view;

CREATE OR REPLACE VIEW nonfungible_token_positions_view AS
SELECT n.*,
       pc.pool_key_id,
       pc.locker,
       pc.salt,
       pc.lower_bound,
       pc.upper_bound,
       pc.liquidity
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN position_current_liquidity pc
              ON pc.locker = COALESCE(m.locker, n.nft_address)
                  AND pc.salt = nft_token_salt(m.token_id_transform, n.token_id)
         JOIN pool_keys pk
              ON pk.pool_key_id = pc.pool_key_id AND pk.chain_id = n.chain_id;

CREATE OR REPLACE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.locker,
       oc.salt,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1,
       oc.total_proceeds_withdrawn0,
       oc.total_proceeds_withdrawn1,
       oc.is_selling_token1,
       oc.amount0_sold_last,
       oc.amount1_sold_last,
       oc.amount_sold_last_block_time,
       CASE
           WHEN oc.is_selling_token1 THEN pk.token1
           ELSE pk.token0
           END AS sell_token,
       CASE
           WHEN oc.is_selling_token1 THEN pk.token0
           ELSE pk.token1
           END AS buy_token,
       CASE
           WHEN oc.is_selling_token1 THEN oc.sale_rate1
           ELSE oc.sale_rate0
           END AS sale_rate,
       CASE
           WHEN oc.is_selling_token1 THEN oc.total_proceeds_withdrawn0
           ELSE oc.total_proceeds_withdrawn1
           END AS total_proceeds_withdrawn,
       CASE
           WHEN oc.is_selling_token1 THEN
               FLOOR((EXTRACT(EPOCH FROM LEAST(latest_block.block_time, end_time) -
                                         GREATEST(amount_sold_last_block_time, start_time)) *
                      sale_rate1) / pow(2::NUMERIC, 32)) +
               oc.amount1_sold_last
           ELSE FLOOR((EXTRACT(EPOCH FROM LEAST(latest_block.block_time, end_time) -
                                          GREATEST(amount_sold_last_block_time, start_time)) *
                       sale_rate0) / pow(2::NUMERIC, 32)) + oc.amount0_sold_last
           END AS amount_sold
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN LATERAL (SELECT block_time
                       FROM blocks b
                       WHERE b.chain_id = n.chain_id
                       ORDER BY block_number DESC
                       LIMIT 1) AS latest_block ON TRUE
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address)
                  AND oc.salt = nft_token_salt(m.token_id_transform, n.token_id)
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;

DO
$$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'incentives') THEN
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
            $func$
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
                         ranked_transfers AS (SELECT rt.nft_address,
                                                     rt.locker,
                                                     rt.salt,
                                                     rt.to_address,
                                                     ROW_NUMBER()
                                                     OVER (PARTITION BY rt.locker, rt.salt ORDER BY rt.event_id DESC) AS row_no
                                              FROM (SELECT ntt.emitter                       AS nft_address,
                                                           COALESCE(nlm.locker, ntt.emitter) AS locker,
                                                           nft_token_salt(nlm.token_id_transform, ntt.token_id) AS salt,
                                                           ntt.event_id,
                                                           ntt.to_address
                                                    FROM nonfungible_token_transfers ntt
                                                             JOIN blocks b USING (chain_id, block_number)
                                                             LEFT JOIN nft_locker_mappings nlm
                                                                       ON nlm.chain_id = ntt.chain_id AND nlm.nft_address = ntt.emitter,
                                                         last_period_end lpe
                                                    WHERE ntt.chain_id = v_chain_id
                                                      AND ntt.to_address != 0
                                                      AND b.block_time < lpe.last_end_time) rt),
                         token_owners AS (SELECT nft_address, locker, salt, to_address AS owner
                                          FROM ranked_transfers
                                          WHERE row_no = 1)
                    SELECT COALESCE(t_o.owner, rbls.locker) AS recipient,
                           FLOOR(SUM(rbls.total))           AS amount
                    FROM rewards_by_locker_salt rbls
                             LEFT JOIN token_owners t_o ON t_o.salt = rbls.salt AND rbls.locker = t_o.locker
                    GROUP BY 1
                    ORDER BY 2 DESC;
            END;
            $func$;
        END IF;
    END;
$$;

INSERT INTO nft_locker_mappings (chain_id,
                                 nft_address,
                                 locker,
                                 token_id_transform)
VALUES (11155111,
        0x07e63c3df9991950fcc2da4376d25a0104b56e2c,
        0x07e63c3df9991950fcc2da4376d25a0104b56e2c,
        JSONB_BUILD_OBJECT('bit_mod', 192))
ON CONFLICT (chain_id, nft_address) DO UPDATE SET locker              = excluded.locker,
                                                  token_id_transform = excluded.token_id_transform;
