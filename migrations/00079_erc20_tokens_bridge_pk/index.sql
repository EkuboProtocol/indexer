TRUNCATE TABLE erc20_tokens_bridge_relationships;

ALTER TABLE erc20_tokens_bridge_relationships
    DROP CONSTRAINT IF EXISTS erc20_tokens_bridge_relationships_pkey,
    DROP CONSTRAINT IF EXISTS erc20_tokens_bridge_relationships_source_chain_id_source_token_address_source_bridge_address_key,
    ADD CONSTRAINT erc20_tokens_bridge_relationships_pkey PRIMARY KEY (source_chain_id, source_token_address, dest_chain_id);
