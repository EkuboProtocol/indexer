CREATE TABLE position_current_liquidity (
    chain_id int8 NOT NULL,
    core_address numeric NOT NULL,
    locker numeric NOT NULL,
    salt numeric NOT NULL,
    lower_bound int4 NOT NULL,
    upper_bound int4 NOT NULL,
    liquidity numeric NOT NULL,
    PRIMARY KEY (chain_id, core_address, locker, salt, lower_bound, upper_bound)
);

CREATE FUNCTION position_current_liquidity_on_insert()
RETURNS trigger AS $$
DECLARE
    v_core_address numeric;
BEGIN
    SELECT core_address
    INTO STRICT v_core_address
    FROM pool_keys
    WHERE pool_key_id = NEW.pool_key_id;

    INSERT INTO position_current_liquidity (
        chain_id,
        core_address,
        locker,
        salt,
        lower_bound,
        upper_bound,
        liquidity
    ) VALUES (
        NEW.chain_id,
        v_core_address,
        NEW.locker,
        NEW.salt,
        NEW.lower_bound,
        NEW.upper_bound,
        NEW.liquidity_delta
    )
    ON CONFLICT (chain_id, core_address, locker, salt, lower_bound, upper_bound)
    DO UPDATE SET
        liquidity = position_current_liquidity.liquidity + EXCLUDED.liquidity;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION position_current_liquidity_on_delete()
RETURNS trigger AS $$
DECLARE
    v_core_address numeric;
BEGIN
    SELECT core_address
    INTO STRICT v_core_address
    FROM pool_keys
    WHERE pool_key_id = OLD.pool_key_id;

    -- it is assumed to exist
    UPDATE position_current_liquidity
    SET liquidity = liquidity - OLD.liquidity_delta
    WHERE chain_id = OLD.chain_id
      AND core_address = v_core_address
      AND locker = OLD.locker
      AND salt = OLD.salt
      AND lower_bound = OLD.lower_bound
      AND upper_bound = OLD.upper_bound;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to update position_current_liquidity on delete';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

INSERT INTO position_current_liquidity (
    chain_id,
    core_address,
    locker,
    salt,
    lower_bound,
    upper_bound,
    liquidity
)
SELECT
    pu.chain_id,
    pk.core_address,
    pu.locker,
    pu.salt,
    pu.lower_bound,
    pu.upper_bound,
    SUM(pu.liquidity_delta) AS liquidity
FROM position_updates pu
JOIN pool_keys pk ON pk.pool_key_id = pu.pool_key_id
GROUP BY
    pu.chain_id,
    pk.core_address,
    pu.locker,
    pu.salt,
    pu.lower_bound,
    pu.upper_bound;

CREATE TRIGGER position_current_liquidity_after_insert
    AFTER INSERT ON position_updates
    FOR EACH ROW EXECUTE FUNCTION position_current_liquidity_on_insert();

CREATE TRIGGER position_current_liquidity_after_delete
    AFTER DELETE ON position_updates
    FOR EACH ROW EXECUTE FUNCTION position_current_liquidity_on_delete();
