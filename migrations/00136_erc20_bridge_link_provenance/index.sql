ALTER TABLE erc20_tokens_bridge_relationships
    ADD COLUMN relationship TEXT
        CONSTRAINT erc20_tokens_bridge_relationships_relationship_kind
        CHECK (
            relationship IN (
                'canonical_bridge',
                'native_issuer',
                'interoperability',
                'unknown'
            )
        ),
    ADD COLUMN bridge_name TEXT,
    ADD COLUMN source_name TEXT,
    ADD COLUMN source_url TEXT,
    ADD COLUMN inferred_reverse BOOLEAN;

COMMENT ON COLUMN erc20_tokens_bridge_relationships.relationship IS
    'How the destination token relates to the source token: canonical_bridge, native_issuer, interoperability or unknown; NULL until the token list sync writes it';
COMMENT ON COLUMN erc20_tokens_bridge_relationships.bridge_name IS
    'Bridge, issuer or interoperability protocol behind the link, when known';
COMMENT ON COLUMN erc20_tokens_bridge_relationships.source_name IS
    'Name of the source the default-tokens build took the link from';
COMMENT ON COLUMN erc20_tokens_bridge_relationships.source_url IS
    'Location of the source the default-tokens build took the link from';
COMMENT ON COLUMN erc20_tokens_bridge_relationships.inferred_reverse IS
    'TRUE when the build mirrored a one-way link from its source rather than reading this direction from it';
