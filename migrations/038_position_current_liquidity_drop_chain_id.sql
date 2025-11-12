DROP VIEW IF EXISTS nonfungible_token_orders_view;
DROP VIEW IF EXISTS nonfungible_token_positions_view;

DROP TRIGGER IF EXISTS position_current_liquidity_after_insert ON position_updates;
DROP TRIGGER IF EXISTS position_current_liquidity_after_delete ON position_updates;

DROP FUNCTION IF EXISTS position_current_liquidity_on_insert();
DROP FUNCTION IF EXISTS position_current_liquidity_on_delete();

DROP TABLE IF EXISTS position_current_liquidity;

CREATE TABLE position_current_liquidity
(
    pool_key_id int8    NOT NULL REFERENCES pool_keys (pool_key_id),
    locker      NUMERIC NOT NULL,
    salt        NUMERIC NOT NULL,
    lower_bound int4    NOT NULL,
    upper_bound int4    NOT NULL,
    liquidity   NUMERIC NOT NULL,
    PRIMARY KEY (pool_key_id, locker, salt, lower_bound, upper_bound)
);

CREATE FUNCTION position_current_liquidity_on_insert()
    RETURNS TRIGGER AS
$$
BEGIN
    INSERT INTO position_current_liquidity (pool_key_id,
                                            locker,
                                            salt,
                                            lower_bound,
                                            upper_bound,
                                            liquidity)
    VALUES (new.pool_key_id,
            new.locker,
            new.salt,
            new.lower_bound,
            new.upper_bound,
            new.liquidity_delta)
    ON CONFLICT (pool_key_id, locker, salt, lower_bound, upper_bound)
        DO UPDATE SET liquidity = position_current_liquidity.liquidity + excluded.liquidity;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION position_current_liquidity_on_delete()
    RETURNS TRIGGER AS
$$
BEGIN
    UPDATE position_current_liquidity
    SET liquidity = liquidity - old.liquidity_delta
    WHERE pool_key_id = old.pool_key_id
      AND locker = old.locker
      AND salt = old.salt
      AND lower_bound = old.lower_bound
      AND upper_bound = old.upper_bound;

    IF NOT found THEN
        RAISE EXCEPTION 'failed to update position_current_liquidity on delete';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

INSERT INTO position_current_liquidity (pool_key_id,
                                        locker,
                                        salt,
                                        lower_bound,
                                        upper_bound,
                                        liquidity)
SELECT pool_key_id,
       locker,
       salt,
       lower_bound,
       upper_bound,
       SUM(liquidity_delta) AS liquidity
FROM position_updates
GROUP BY pool_key_id,
         locker,
         salt,
         lower_bound,
         upper_bound;

CREATE TRIGGER position_current_liquidity_after_insert
    AFTER INSERT
    ON position_updates
    FOR EACH ROW
EXECUTE FUNCTION position_current_liquidity_on_insert();

CREATE TRIGGER position_current_liquidity_after_delete
    AFTER DELETE
    ON position_updates
    FOR EACH ROW
EXECUTE FUNCTION position_current_liquidity_on_delete();

CREATE VIEW nonfungible_token_positions_view AS
SELECT n.*,
       pc.pool_key_id,
       pc.lower_bound,
       pc.upper_bound,
       pc.liquidity
FROM nonfungible_token_owners n
         LEFT JOIN nft_locker_mappings m
                   ON m.chain_id = n.chain_id AND m.nft_address = n.nft_address
         JOIN position_current_liquidity pc
              ON pc.locker = COALESCE(m.locker, n.nft_address) AND pc.salt = n.token_id
         JOIN pool_keys pk
              ON pk.pool_key_id = pc.pool_key_id AND pk.chain_id = n.chain_id;
