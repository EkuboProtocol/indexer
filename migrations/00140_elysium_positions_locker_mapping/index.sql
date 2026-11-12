-- Elysium (chain 99901) runs only the recompiled Positions contract, with the
-- same bytecode as every other chain in 00128. Without this row the views fall
-- back to the full token id as the salt and no position minted there joins.
INSERT INTO nft_locker_mappings (chain_id,
                                 nft_address,
                                 locker,
                                 token_id_transform)
VALUES (99901,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        0xA2971E0C37cFdb13aE8440A0C94Ef1A1af39e326,
        JSONB_BUILD_OBJECT('bit_mod', 192))
ON CONFLICT (chain_id, nft_address) DO UPDATE SET locker             = excluded.locker,
                                                  token_id_transform = excluded.token_id_transform;
