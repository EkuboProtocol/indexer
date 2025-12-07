-- Recompute pool config for pools on the specified core without the concentrated offset since it's not used in V1.
UPDATE pool_keys
SET pool_config = pool_extension * POWER(2::NUMERIC, 96)
    + fee * POWER(2::NUMERIC, 32)
    + tick_spacing::NUMERIC
WHERE core_address = 0xe0e0e08a6a4b9dc7bd67bcb7aade5cf48157d444;
