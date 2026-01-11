-- Create a campaign distributing 30,940 EKUBO over 91 days with daily pair budgets.
-- Uses the EKUBO reward token for incentives. Migration fails fast if any referenced token is missing on chain_id = 1.

DO
$$
    DECLARE
        v_chain_id                CONSTANT int8        := 1;
        v_slug                    CONSTANT VARCHAR(20) := 'ekubo_launch_v3';
        v_name                    CONSTANT TEXT        := 'Ekubo V3 Incentives';
        v_start                   CONSTANT timestamptz := TO_TIMESTAMP(1768348800); -- 2026-01-14 00:00:00 UTC
        v_days                    CONSTANT INTEGER     := 91;
        v_interval                CONSTANT INTERVAL    := '1 day';
        v_end                     CONSTANT timestamptz := v_start + (INTERVAL '1 days' * v_days);
        v_reward                  CONSTANT NUMERIC     := 709712129419725063431057716743722218468728283107; -- 0x7c5097b11b7bc856f603fb60287833cf9a829fe3
        v_reward_dp               CONSTANT INTEGER     := 18; -- assumed
        v_unit                             NUMERIC;
        v_default_fee_denominator CONSTANT NUMERIC     := pow(2::NUMERIC, 64);
        v_core_address            CONSTANT NUMERIC     := 0x00000000000014aA86C5d3c41765bb24e11bd701;
        v_eth                              NUMERIC;
        v_usdc                             NUMERIC;
        v_wbtc                             NUMERIC;
        v_usdt                             NUMERIC;
        v_xaut                             NUMERIC;
        v_eurc                             NUMERIC;
        v_wsteth                           NUMERIC;
        v_ekubo                            NUMERIC;
        v_cbbtc                            NUMERIC;
        v_tbtc                             NUMERIC;
        v_usde                             NUMERIC;
        v_gho                              NUMERIC;
        v_crvusd                           NUMERIC;
    BEGIN
        IF EXISTS (SELECT 1 FROM incentives.campaigns WHERE slug = v_slug) THEN
            RAISE EXCEPTION 'Campaign with slug % already exists', v_slug;
        END IF;

        SELECT token_address
        INTO STRICT v_eth
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'ETH'
          AND token_address = 0
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_usdc
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'USDC'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_wbtc
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'WBTC'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_usdt
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'USDT'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_xaut
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'XAUt'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_eurc
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'EURC'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_wsteth
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'wstETH'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_ekubo
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'EKUBO'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        v_unit := POWER(10::NUMERIC, v_reward_dp);

        SELECT token_address
        INTO STRICT v_cbbtc
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'cbBTC'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_tbtc
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'tBTC'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_usde
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'USDe'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_gho
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'GHO'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        SELECT token_address
        INTO STRICT v_crvusd
        FROM erc20_tokens
        WHERE chain_id = v_chain_id
          AND token_symbol = 'crvUSD'
        ORDER BY visibility_priority DESC, token_address
        LIMIT 1;

        PERFORM incentives.create_campaign(
                v_chain_id,
                v_name,
                v_slug,
                v_start,
                v_end,
                v_interval,
                v_reward,
                ARRAY [
                    ROW (v_eth, v_usdc, 60 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_wbtc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_wbtc, v_usdt, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_xaut, v_usdt, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_eurc, v_usdc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_wsteth, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_eth, v_ekubo, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_wbtc, v_cbbtc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_tbtc, v_wbtc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_usdc, v_usdt, 60 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_usde, v_usdc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_gho, v_usdc, 20 * v_days * v_unit, 0)::incentives.token_pair_budget,
                    ROW (v_usdc, v_crvusd, 20 * v_days * v_unit, 0)::incentives.token_pair_budget
                    ],
                v_default_fee_denominator,
                v_core_address,
                ARRAY [0x0, 0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be, 0x517E506700271AEa091b02f42756F5E174Af5230, 0xd4F1060cB9c1A13e1d2d20379b8aa2cF7541eD9b]::NUMERIC[],
                NULL::DOUBLE PRECISION,
                NULL::DOUBLE PRECISION,
                ARRAY [0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D]::NUMERIC[]
                );
    END;
$$;
