CREATE TABLE pool_tvl (
    pool_key_id int8 NOT NULL PRIMARY KEY REFERENCES pool_keys (id),
    balance0 NUMERIC NOT NULL,
    balance1 NUMERIC NOT NULL
);
CREATE OR REPLACE FUNCTION apply_pool_tvl_delta(
        p_pool_key_id bigint,
        p_delta0 NUMERIC,
        p_delta1 NUMERIC
    ) RETURNS void AS $$ BEGIN IF p_delta0 = 0
    AND p_delta1 = 0 THEN RETURN;
END IF;
INSERT INTO pool_tvl (pool_key_id, balance0, balance1)
VALUES (p_pool_key_id, p_delta0, p_delta1) ON CONFLICT (pool_key_id) DO
UPDATE
SET balance0 = pool_tvl.balance0 + EXCLUDED.balance0,
    balance1 = pool_tvl.balance1 + EXCLUDED.balance1;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION maintain_pool_tvl() RETURNS TRIGGER AS $$ BEGIN IF TG_OP = 'INSERT' THEN PERFORM apply_pool_tvl_delta(NEW.pool_key_id, NEW.delta0, NEW.delta1);
ELSIF TG_OP = 'UPDATE' THEN IF NEW.pool_key_id = OLD.pool_key_id THEN PERFORM apply_pool_tvl_delta(
    NEW.pool_key_id,
    NEW.delta0 - OLD.delta0,
    NEW.delta1 - OLD.delta1
);
ELSE PERFORM apply_pool_tvl_delta(OLD.pool_key_id, - OLD.delta0, - OLD.delta1);
PERFORM apply_pool_tvl_delta(NEW.pool_key_id, NEW.delta0, NEW.delta1);
END IF;
ELSIF TG_OP = 'DELETE' THEN PERFORM apply_pool_tvl_delta(OLD.pool_key_id, - OLD.delta0, - OLD.delta1);
END IF;
RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER maintain_pool_tvl
AFTER
INSERT
    OR
UPDATE
    OR DELETE ON pool_balance_change FOR EACH ROW EXECUTE FUNCTION maintain_pool_tvl();