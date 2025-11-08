CREATE VIEW nonfungible_token_positions_view AS
WITH resolved_lockers AS (SELECT n.chain_id,
                                 n.nft_address,
                                 n.token_id,
                                 n.current_owner,
                                 n.previous_owner,
                                 n.last_transfer_event_id,
                                 COALESCE(m.locker, n.nft_address) AS locker
                          FROM nonfungible_token_owners n
                                   LEFT JOIN nft_locker_mappings m ON m.chain_id = n.chain_id
                              AND m.nft_address = n.nft_address)
SELECT rl.chain_id,
       rl.nft_address,
       rl.token_id,
       rl.current_owner,
       rl.previous_owner,
       rl.last_transfer_event_id,
       pc.core_address,
       pc.lower_bound,
       pc.upper_bound,
       pc.liquidity
FROM resolved_lockers rl
         JOIN position_current_liquidity pc ON pc.chain_id = rl.chain_id
    AND pc.locker = rl.locker
    AND pc.salt = rl.token_id;