DO
$$
DECLARE
    v_chain_id                CONSTANT int8        := 1;
    v_slug                    CONSTANT VARCHAR(20) := 'eth_usdc_q2_26';
    v_name                    CONSTANT TEXT        := 'Ethereum USDC Incentives Q2 2026';
    v_start                   CONSTANT timestamptz := '2026-04-15 00:00:00+00'::timestamptz;
    v_days                    CONSTANT INTEGER     := 91;
    v_interval                CONSTANT INTERVAL    := '1 day';
    v_end                     CONSTANT timestamptz := v_start + (INTERVAL '1 day' * v_days);
    v_default_fee_denominator CONSTANT NUMERIC     := pow(2::NUMERIC, 64);
    v_core_address            CONSTANT NUMERIC     := 0x00000000000014aA86C5d3c41765bb24e11bd701;
    v_usdc                    CONSTANT NUMERIC     := 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48::NUMERIC;
    v_usdt                    CONSTANT NUMERIC     := 0xdac17f958d2ee523a2206206994597c13d831ec7::NUMERIC;
    v_wbtc                    CONSTANT NUMERIC     := 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599::NUMERIC;
    v_eth                     CONSTANT NUMERIC     := 0::NUMERIC;
    v_mev_capture             CONSTANT NUMERIC     := 0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be::NUMERIC;
    v_oracle                  CONSTANT NUMERIC     := 0x517E506700271AEa091b02f42756F5E174Af5230::NUMERIC;
    v_twamm                   CONSTANT NUMERIC     := 0xd4F1060cB9c1A13e1d2d20379b8aa2cF7541eD9b::NUMERIC;
    v_positions               CONSTANT NUMERIC     := 0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D::NUMERIC;
BEGIN
    PERFORM incentives.create_campaign(
            v_chain_id,
            v_name,
            v_slug,
            v_start,
            v_end,
            v_interval,
            v_usdc,
            ARRAY [
                ROW (v_eth, v_usdc, 550e6 * v_days, 0)::incentives.token_pair_budget,
                ROW (v_eth, v_wbtc, 150e6 * v_days, 0)::incentives.token_pair_budget,
                ROW (v_wbtc, v_usdt, 150e6 * v_days, 0)::incentives.token_pair_budget,
                ROW (v_eth, v_usdt, 150e6 * v_days, 0)::incentives.token_pair_budget
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
