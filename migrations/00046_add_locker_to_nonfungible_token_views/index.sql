DROP VIEW IF EXISTS nonfungible_token_orders_view;
DROP VIEW IF EXISTS nonfungible_token_positions_view;

CREATE OR REPLACE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.locker,
       oc.salt,
       oc.start_time,
       oc.end_time,
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
           WHEN oc.is_selling_token1 THEN oc.total_proceeds_withdrawn1
           ELSE oc.total_proceeds_withdrawn0
           END AS total_proceeds_withdrawn
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;

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
              ON pc.locker = COALESCE(m.locker, n.nft_address) AND pc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = pc.pool_key_id AND pk.chain_id = n.chain_id;
