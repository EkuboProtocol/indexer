CREATE TABLE pool_tvl (
	pool_key_id int8 NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id),
	balance0 numeric NOT NULL,
	balance1 numeric NOT NULL
);

CREATE FUNCTION apply_pool_tvl_delta (p_pool_key_id bigint, p_delta0 numeric, p_delta1 numeric)
	RETURNS void
	AS $$
BEGIN
	INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
		VALUES (p_pool_key_id, p_delta0, p_delta1)
	ON CONFLICT (pool_key_id)
		DO UPDATE SET
			balance0 = pool_tvl.balance0 + EXCLUDED.balance0, balance1 = pool_tvl.balance1 + EXCLUDED.balance1;
END;
$$
LANGUAGE plpgsql;

CREATE FUNCTION update_pool_tvl_insert ()
	RETURNS TRIGGER
	AS $$
BEGIN
	PERFORM apply_pool_tvl_delta (NEW.pool_key_id, NEW.delta0, NEW.delta1);
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE FUNCTION update_pool_tvl_delete ()
	RETURNS TRIGGER
	AS $$
BEGIN
	apply_pool_tvl_delta (OLD.pool_key_id, -OLD.delta0, -OLD.delta1);
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_balance_changes_insert
	AFTER INSERT ON pool_balance_change
	FOR EACH ROW EXECUTE FUNCTION update_pool_tvl_insert ();

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_balance_changes_delete
	AFTER DELETE ON pool_balance_change
	FOR EACH ROW EXECUTE FUNCTION update_pool_tvl_insert ();