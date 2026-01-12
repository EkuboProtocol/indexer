UPDATE incentives.campaigns
SET end_time = '2026-01-14T00:00:00Z'::timestamptz
WHERE slug = 'liquity_bold_usdc';

DO
$$
    DECLARE
        v_chain_id                CONSTANT int8        := 1;
        v_slug                    CONSTANT VARCHAR(20) := 'ekubo_launch_v3';
        v_name                    CONSTANT TEXT        := 'Ekubo V3 Incentives';
        v_start                   CONSTANT timestamptz := TO_TIMESTAMP(1768348800); -- 2026-01-14 00:00:00 UTC
        v_days                    CONSTANT INTEGER     := 91;
        v_interval                CONSTANT INTERVAL    := '4 hours';
        v_end                     CONSTANT timestamptz := v_start + (INTERVAL '1 days' * v_days);
        v_default_fee_denominator CONSTANT NUMERIC     := pow(2::NUMERIC, 64);
        v_core_address            CONSTANT NUMERIC     := 0x00000000000014aA86C5d3c41765bb24e11bd701;
        v_reward_token            CONSTANT NUMERIC     := 0x7c5097b11b7bc856f603fb60287833cf9a829fe3::NUMERIC;
        v_eth                     CONSTANT NUMERIC     = 0::NUMERIC;
        v_usdc                    CONSTANT NUMERIC     = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48::NUMERIC;
        v_wbtc                    CONSTANT NUMERIC     = 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599::NUMERIC;
        v_usdt                    CONSTANT NUMERIC     = 0xdac17f958d2ee523a2206206994597c13d831ec7::NUMERIC;
        v_xaut                    CONSTANT NUMERIC     = 0x68749665ff8d2d112fa859aa293f07a622782f38::NUMERIC;
        v_eurc                    CONSTANT NUMERIC     = 0x1abaea1f7c830bd89acc67ec4af516284b1bc33c::NUMERIC;
        v_wsteth                  CONSTANT NUMERIC     = 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0::NUMERIC;
        v_ekubo                   CONSTANT NUMERIC     = 0x04c46e830bb56ce22735d5d8fc9cb90309317d0f::NUMERIC;
        v_cbbtc                   CONSTANT NUMERIC     = 0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf::NUMERIC;
        v_tbtc                    CONSTANT NUMERIC     = 0x18084fba666a33d37592fa2633fd49a74dd93a88::NUMERIC;
        v_usde                    CONSTANT NUMERIC     = 0x4c9edd5852cd905f086c759e8383e09bff1e68b3::NUMERIC;
        v_gho                     CONSTANT NUMERIC     = 0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f::NUMERIC;
        v_crvusd                  CONSTANT NUMERIC     = 0xf939e0a03fb07f59a73314e73794be0e57ac1b4e::NUMERIC;
        v_mev_capture             CONSTANT NUMERIC     = 0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be::NUMERIC;
        v_oracle                  CONSTANT NUMERIC     = 0x517E506700271AEa091b02f42756F5E174Af5230::NUMERIC;
        v_twamm                   CONSTANT NUMERIC     = 0xd4F1060cB9c1A13e1d2d20379b8aa2cF7541eD9b::NUMERIC;
        v_positions               CONSTANT NUMERIC     = 0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D::NUMERIC;
    BEGIN
        PERFORM incentives.create_campaign(
                v_chain_id,
                v_name,
                v_slug,
                v_start,
                v_end,
                v_interval,
                v_reward_token,
                ARRAY [
                    ROW (v_eth, v_usdc, 60e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_wbtc, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_wbtc, v_usdt, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_xaut, v_usdt, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_eurc, v_usdc, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_wsteth, 20e18 * v_days, 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_ekubo, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_wbtc, v_cbbtc, 20e18 * v_days, 0)::incentives.token_pair_budget,
                    ROW (v_tbtc, v_wbtc, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_usdc, v_usdt, 60e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_usde, v_usdc, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_gho, v_usdc, 20e18 * v_days , 0)::incentives.token_pair_budget,
                    ROW (v_usdc, v_crvusd, 20e18 * v_days , 0)::incentives.token_pair_budget
                    ],
                v_default_fee_denominator,
                v_core_address,
                ARRAY [0x0, v_mev_capture, v_oracle, v_twamm]::NUMERIC[],
                NULL::DOUBLE PRECISION,
                NULL::DOUBLE PRECISION,
                ARRAY [v_positions]::NUMERIC[]
                );
    END;
$$;
