DO
$$
    DECLARE
        v_chain_id CONSTANT int8        := 1;
        v_slug     CONSTANT VARCHAR(20) := 'ekubo_launch_v3';
        v_campaign_id       BIGINT;
        v_eth      CONSTANT NUMERIC     := 0::NUMERIC;
        v_usdc     CONSTANT NUMERIC     := 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48::NUMERIC;
        v_wbtc     CONSTANT NUMERIC     := 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599::NUMERIC;
        v_usdt     CONSTANT NUMERIC     := 0xdac17f958d2ee523a2206206994597c13d831ec7::NUMERIC;
        v_xaut     CONSTANT NUMERIC     := 0x68749665ff8d2d112fa859aa293f07a622782f38::NUMERIC;
        v_eurc     CONSTANT NUMERIC     := 0x1abaea1f7c830bd89acc67ec4af516284b1bc33c::NUMERIC;
        v_wsteth   CONSTANT NUMERIC     := 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0::NUMERIC;
        v_ekubo    CONSTANT NUMERIC     := 0x04c46e830bb56ce22735d5d8fc9cb90309317d0f::NUMERIC;
        v_cbbtc    CONSTANT NUMERIC     := 0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf::NUMERIC;
        v_tbtc     CONSTANT NUMERIC     := 0x18084fba666a33d37592fa2633fd49a74dd93a88::NUMERIC;
        v_usde     CONSTANT NUMERIC     := 0x4c9edd5852cd905f086c759e8383e09bff1e68b3::NUMERIC;
        v_gho      CONSTANT NUMERIC     := 0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f::NUMERIC;
        v_crvusd   CONSTANT NUMERIC     := 0xf939e0a03fb07f59a73314e73794be0e57ac1b4e::NUMERIC;
        v_pair              RECORD;
    BEGIN
        SELECT id
        INTO STRICT v_campaign_id
        FROM incentives.campaigns
        WHERE chain_id = v_chain_id
          AND slug = v_slug;

        FOR v_pair IN
            SELECT *
            FROM (VALUES (v_eth, v_usdc, 0.075),
                         (v_eth, v_wbtc, 0.03),
                         (v_wbtc, v_usdt, 0.05),
                         (v_xaut, v_usdt, 0.05),
                         (v_eurc, v_usdc, 0.005),
                         (v_eth, v_wsteth, 0.002),
                         (v_eth, v_ekubo, 0.15),
                         (v_wbtc, v_cbbtc, 0.001),
                         (v_tbtc, v_wbtc, 0.0015),
                         (v_usdc, v_usdt, 0.001),
                         (v_usde, v_usdc, 0.0015),
                         (v_gho, v_usdc, 0.0015),
                         (v_usdc, v_crvusd, 0.0015)) AS pair(token0, token1, realized_volatility)
            LOOP
                UPDATE incentives.campaign_reward_periods crp
                SET realized_volatility = v_pair.realized_volatility
                WHERE crp.campaign_id = v_campaign_id
                  AND crp.token0 = v_pair.token0
                  AND crp.token1 = v_pair.token1;
            END LOOP;
    END;
$$;
