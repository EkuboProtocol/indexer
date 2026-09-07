-- Switching to solc 0.8.33 moved the Positions contract's CREATE2 address, and
-- the indexer now watches both generations on every chain. The salt a position
-- is stored under is the low 192 bits of its token id, which the views derive
-- through nft_token_salt(token_id_transform, token_id); without a row here the
-- transform is NULL, the full token id is used as the salt, and every position
-- minted through the recompiled contract silently fails to join.
--
-- One row per chain the recompiled contract is deployed on, which is every
-- supported chain except Robinhood, checked with eth_getCode. Same bytecode as
-- the first generation, so the same bit_mod 192, and the locker is the contract
-- itself exactly as for the address it replaces.
INSERT INTO nft_locker_mappings (chain_id,
                                 nft_address,
                                 locker,
                                 token_id_transform)
VALUES (1,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (10,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (56,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (100,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (130,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (137,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (143,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (480,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (4326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (8453,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (42161,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192)),
       (57073,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192))
ON CONFLICT (chain_id, nft_address) DO UPDATE SET locker             = excluded.locker,
                                                  token_id_transform = excluded.token_id_transform;
