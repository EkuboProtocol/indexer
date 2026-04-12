DO
$$
DECLARE
    v_chain_id    CONSTANT int8        := 1;
    v_slug        CONSTANT VARCHAR(20) := 'eth_usdc_q2_26';
    v_campaign_id BIGINT;
    v_eth         CONSTANT NUMERIC     := 0::NUMERIC;
    v_usdc        CONSTANT NUMERIC     := 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48::NUMERIC;
    v_usdt        CONSTANT NUMERIC     := 0xdac17f958d2ee523a2206206994597c13d831ec7::NUMERIC;
    v_wbtc        CONSTANT NUMERIC     := 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599::NUMERIC;
    v_pair        RECORD;
BEGIN
    SELECT id
    INTO STRICT v_campaign_id
    FROM incentives.campaigns
    WHERE chain_id = v_chain_id
      AND slug = v_slug;

    FOR v_pair IN
        SELECT *
        FROM (VALUES (v_eth, v_usdc, 0.075),
                     (v_eth, v_usdt, 0.075),
                     (v_eth, v_wbtc, 0.03),
                     (v_wbtc, v_usdt, 0.05)) AS pair(token0, token1, realized_volatility)
    LOOP
        UPDATE incentives.campaign_reward_periods crp
        SET realized_volatility = v_pair.realized_volatility
        WHERE crp.campaign_id = v_campaign_id
          AND crp.token0 = v_pair.token0
          AND crp.token1 = v_pair.token1;
    END LOOP;
END;
$$;
