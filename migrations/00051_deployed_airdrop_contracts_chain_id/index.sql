ALTER TABLE incentives.deployed_airdrop_contracts
    ADD COLUMN chain_id int8;

-- Existing deployed contracts are only on Starknet mainnet (SN_MAIN)
UPDATE incentives.deployed_airdrop_contracts
SET chain_id = 23448594291968334
WHERE chain_id IS NULL;

ALTER TABLE incentives.deployed_airdrop_contracts
    ALTER COLUMN chain_id SET NOT NULL,
    DROP CONSTRAINT deployed_airdrop_contracts_pkey,
    ADD CONSTRAINT deployed_airdrop_contracts_pkey PRIMARY KEY (chain_id, address);
