CREATE VIEW nonfungible_token_positions_view AS
SELECT n.*,
       pc.core_address,
       pc.lower_bound,
       pc.upper_bound,
       pc.liquidity
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN position_current_liquidity pc
              ON pc.chain_id = n.chain_id AND pc.locker = COALESCE(m.locker, n.nft_address) AND pc.salt = n.token_id;