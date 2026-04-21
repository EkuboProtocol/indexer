DO
$$
DECLARE
    v_chain_id    CONSTANT int8 := 1;
    v_name        CONSTANT TEXT := 'Ethereum USDC Incentives';
    v_campaign_id BIGINT;
BEGIN
    SELECT id
    INTO STRICT v_campaign_id
    FROM incentives.campaigns
    WHERE chain_id = v_chain_id
      AND name = v_name
    ORDER BY start_time DESC
    LIMIT 1;

    UPDATE incentives.campaign_reward_periods crp
    SET realized_volatility = crp.realized_volatility / 2
    WHERE crp.campaign_id = v_campaign_id
      AND crp.end_time > CURRENT_TIMESTAMP;
END;
$$;
