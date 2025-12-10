CREATE OR REPLACE FUNCTION nft_token_salt(
    transform jsonb,
    token_id NUMERIC
)
    RETURNS NUMERIC
    LANGUAGE sql
    IMMUTABLE
AS
$$
SELECT CASE
           WHEN transform IS NULL THEN token_id
           WHEN transform ? 'bit_mod' THEN MOD(token_id, POW(2::NUMERIC, (transform ->> 'bit_mod')::int))
           ELSE token_id
           END
$$;
