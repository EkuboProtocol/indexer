CREATE TABLE limit_order_placed (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	tick int4 NOT NULL,
	liquidity numeric NOT NULL,
	amount numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX idx_limit_order_placed_owner_salt ON limit_order_placed USING btree (chain_id, OWNER, salt);

CREATE INDEX idx_limit_order_placed_salt_event_id_desc ON limit_order_placed (chain_id, salt, event_id DESC) INCLUDE (token0, token1, tick, liquidity, amount);

CREATE TABLE limit_order_closed (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	pool_key_id int8 NOT NULL REFERENCES pool_keys (pool_key_id),
	owner NUMERIC NOT NULL,
	salt numeric NOT NULL,
	token0 numeric NOT NULL,
	token1 numeric NOT NULL,
	tick int4 NOT NULL,
	amount0 numeric NOT NULL,
	amount1 numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE INDEX idx_limit_order_closed_owner_salt ON limit_order_closed USING btree (chain_id, OWNER, salt);

CREATE INDEX idx_limit_order_closed_salt_event_id_desc ON limit_order_closed (chain_id, salt, event_id DESC) INCLUDE (amount0, amount1);

CREATE VIEW limit_order_pool_states_view AS (
	WITH last_limit_order_placed AS (
		SELECT
			pool_key_id,
			max(event_id) AS event_id
		FROM
			limit_order_placed
		GROUP BY
			pool_key_id),
		last_limit_order_closed AS (
			SELECT
				pool_key_id,
				max(event_id) AS event_id
			FROM
				limit_order_closed
			GROUP BY
				pool_key_id
)
			SELECT
				coalesce(llop.pool_key_id, lloc.pool_key_id) AS pool_key_id,
				GREATEST (GREATEST (llop.event_id, coalesce(lloc.event_id, 0)), psm.last_event_id) AS last_event_id
			FROM
				last_limit_order_placed llop
				JOIN pool_states psm ON llop.pool_key_id = psm.pool_key_id
				LEFT JOIN last_limit_order_closed lloc ON llop.pool_key_id = lloc.pool_key_id);

CREATE MATERIALIZED VIEW limit_order_pool_states_materialized AS (
	SELECT
		pool_key_id,
		last_event_id
	FROM
		limit_order_pool_states_view);

CREATE UNIQUE INDEX idx_limit_order_pool_states_materialized_pool_key_id ON limit_order_pool_states_materialized USING btree (pool_key_id);
