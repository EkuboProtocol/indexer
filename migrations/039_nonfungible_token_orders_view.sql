CREATE VIEW nonfungible_token_orders_view AS
SELECT n.*,
       oc.pool_key_id,
       oc.start_time,
       oc.end_time,
       oc.sale_rate0,
       oc.sale_rate1
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN order_current_sale_rate oc
              ON oc.locker = COALESCE(m.locker, n.nft_address) AND oc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = oc.pool_key_id AND pk.chain_id = n.chain_id;
