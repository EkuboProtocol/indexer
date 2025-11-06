-- manually updated table containing a list of all the tokens
CREATE TABLE erc20_tokens (
	chain_id INT8 NOT NULL,
    token_address NUMERIC NOT NULL,
    token_symbol VARCHAR NOT NULL,
    token_name VARCHAR NOT NULL,
    token_decimals int2 NOT NULL,
    visibility_priority int2 NOT NULL, -- the higher the value, the more priority this token has for being seen
    sort_order int2 NOT NULL, -- the higher the value, the more numerator-like the token is
    -- extra metadata that is not necessarily populated
    logo_url TEXT,
    total_supply NUMERIC,
    PRIMARY KEY (chain_id, token_address)
);

CREATE TABLE erc20_tokens_bridge_relationships (
    source_chain_id INT8 NOT NULL,
    source_token_address NUMERIC NOT NULL,
    -- the address on the source chain that holds all the bridged tokens
    -- if NULL, it means the token is not "bridged," rather it is minted natively on both chains
    source_bridge_address NUMERIC,
    dest_chain_id INT8 NOT NULL,
    dest_token_address NUMERIC NOT NULL,
    FOREIGN KEY (source_chain_id, source_token_address) REFERENCES erc20_tokens (chain_id, token_address),
    FOREIGN KEY (dest_chain_id, dest_token_address) REFERENCES erc20_tokens (chain_id, token_address),
    UNIQUE (source_chain_id, source_token_address, source_bridge_address)
);

CREATE INDEX ON erc20_tokens_bridge_relationships (dest_chain_id, dest_token_address);