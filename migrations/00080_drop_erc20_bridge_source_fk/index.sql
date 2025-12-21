-- Drop foreign keys
ALTER TABLE erc20_tokens_bridge_relationships
    DROP CONSTRAINT IF EXISTS erc20_tokens_bridge_relations_source_chain_id_source_token_fkey,
    DROP CONSTRAINT IF EXISTS erc20_tokens_bridge_relations_dest_chain_id_dest_token_add_fkey;
