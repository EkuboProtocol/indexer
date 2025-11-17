-- stores a mapping between an NFT for which position transfers are emitted, and a locker on the core contract which uses the token ID as a salt
-- this is needed for figuring out which positions are associated with which token IDs
-- this is primarily used on starknet where the positions contract and nft contract are not the same
CREATE TABLE nft_locker_mappings (
    chain_id int8 NOT NULL,
    nft_address numeric NOT NULL,
    locker numeric NOT NULL,
    PRIMARY KEY (chain_id, nft_address)
);

INSERT INTO nft_locker_mappings (chain_id, nft_address, locker) VALUES
    -- starknet mainnet positions contract to the nft
    (0x534e5f4d41494e, 0x07b696af58c967c1b14c9dde0ace001720635a660a8e90c565ea459345318b30, 0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067),
    -- starknet sepolia positions contract to the nft
    (0x534e5f4d41494f, 0x04afc78d6fec3b122fc1f60276f074e557749df1a77a93416451be72c435120f, 0x06a2aee84bb0ed5dded4384ddd0e40e9c1372b818668375ab8e3ec08807417e5);
