CREATE INDEX ON twamm_proceeds_withdrawals (
    pool_key_id,
    locker,
    salt,
    start_time,
    end_time,
    is_selling_token1,
    event_id DESC
);
