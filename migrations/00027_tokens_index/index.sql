-- this allows us to return the paginated tokens by chain id, visibility priority and then sorted by token address
CREATE INDEX ON erc20_tokens (chain_id, visibility_priority DESC, token_address);