CREATE TABLE pool_tvl (
	pool_key_id int8 NOT NULL PRIMARY KEY REFERENCES pool_keys (pool_key_id),
	balance0 numeric NOT NULL,
	balance1 numeric NOT NULL
);

CREATE OR REPLACE FUNCTION apply_pool_tvl_delta (p_pool_key_id bigint, p_delta0 numeric, p_delta1 numeric)
	RETURNS void
	AS $$
BEGIN
	IF p_delta0 = 0 AND p_delta1 = 0 THEN
		RETURN;
	END IF;
	INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
		VALUES (p_pool_key_id, p_delta0, p_delta1)
	ON CONFLICT (pool_key_id)
		DO UPDATE SET
			balance0 = pool_tvl.balance0 + EXCLUDED.balance0, balance1 = pool_tvl.balance1 + EXCLUDED.balance1;
END;
$$
LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION maintain_pool_tvl ()
	RETURNS TRIGGER
	AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM
			apply_pool_tvl_delta (NEW.pool_key_id, NEW.delta0, NEW.delta1);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM
			apply_pool_tvl_delta (OLD.pool_key_id, - OLD.delta0, - OLD.delta1);
	END IF;
	RETURN NULL;
END;
$$
LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_position_updates
	AFTER INSERT OR DELETE ON position_updates
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_pool_tvl ();

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_position_fees_collected
	AFTER INSERT OR DELETE ON position_fees_collected
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_pool_tvl ();

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_fees_accumulated
	AFTER INSERT OR DELETE ON fees_accumulated
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_pool_tvl ();

CREATE CONSTRAINT TRIGGER maintain_pool_tvl_from_swaps
	AFTER INSERT OR DELETE ON swaps
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION maintain_pool_tvl ();
