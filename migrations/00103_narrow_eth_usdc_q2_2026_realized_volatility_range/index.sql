DO
$$
DECLARE
    v_slug        CONSTANT VARCHAR(20) := 'eth_usdc_q2_26';
    v_campaign_id BIGINT;
BEGIN
    SELECT id
    INTO STRICT v_campaign_id
    FROM incentives.campaigns
    WHERE slug = v_slug;

    UPDATE incentives.campaign_reward_periods crp
    SET realized_volatility = crp.realized_volatility / 2
    WHERE crp.campaign_id = v_campaign_id
      AND crp.end_time > CURRENT_TIMESTAMP
      AND crp.rewards_last_computed_at IS NULL;
END;
$$;
