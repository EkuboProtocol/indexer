CREATE TYPE pool_config_type AS ENUM ('concentrated', 'stableswap');

ALTER TABLE pool_keys
    ADD COLUMN pool_config NUMERIC,
    ADD COLUMN pool_config_type pool_config_type NOT NULL DEFAULT 'concentrated',
    ADD COLUMN stableswap_center_tick INT4,
    ADD COLUMN stableswap_amplification INT2,
    ADD CONSTRAINT pool_keys_stableswap_amplification_bounds
        CHECK (
            stableswap_amplification IS NULL
            OR (stableswap_amplification BETWEEN 0 AND 26)
        ),
    ADD CONSTRAINT pool_keys_tick_spacing_required
        CHECK (
            (
                pool_config_type = 'concentrated'
                AND tick_spacing IS NOT NULL
                AND stableswap_center_tick IS NULL
                AND stableswap_amplification IS NULL
            )
            OR (
                pool_config_type = 'stableswap'
                AND tick_spacing IS NULL
                AND stableswap_center_tick IS NOT NULL
                AND stableswap_amplification IS NOT NULL
            )
        );

UPDATE pool_keys
SET pool_config = pool_extension * power(2::numeric, 96)
                + fee * power(2::numeric, 32)
                + tick_spacing::numeric
                + power(2::numeric, 31)
WHERE fee_denominator = power(2::numeric, 64);

ALTER TABLE pool_keys
    ALTER COLUMN tick_spacing DROP NOT NULL;
