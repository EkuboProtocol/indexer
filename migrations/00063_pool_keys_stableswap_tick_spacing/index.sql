UPDATE pool_keys
SET pool_config_type         = 'stableswap',
    stableswap_center_tick   = 0,
    stableswap_amplification = 0,
    tick_spacing             = NULL
WHERE tick_spacing = 0;

ALTER TABLE pool_keys
    DROP CONSTRAINT pool_keys_tick_spacing_required;

ALTER TABLE pool_keys
    ADD CONSTRAINT pool_keys_tick_spacing_required
        CHECK (
            (
                pool_config_type = 'concentrated'
                    AND tick_spacing IS NOT NULL
                    AND tick_spacing <> 0
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
