CREATE TABLE token_registrations (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	address numeric NOT NULL,
	name numeric NOT NULL,
	symbol numeric NOT NULL,
	decimals int NOT NULL,
	total_supply numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE TABLE token_registrations_v3 (
	chain_id int8 NOT NULL,
	event_id int8 NOT NULL,
	address numeric NOT NULL,
	name varchar NOT NULL,
	symbol varchar NOT NULL,
	decimals int NOT NULL,
	total_supply numeric NOT NULL,
	PRIMARY KEY (chain_id, event_id),
	FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, event_id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION parse_starknet_short_string (numeric_value numeric)
	RETURNS varchar
	AS $$
DECLARE
	result_text text := '';
	byte_value integer;
	ascii_char text;
	n numeric := numeric_value;
BEGIN
	IF n < 0 THEN
		RETURN NULL;
	END IF;
	IF n % 1 != 0 THEN
		RETURN NULL;
	END IF;
	IF n = 0 THEN
		RETURN '';
	END IF;
	WHILE n > 0 LOOP
		byte_value := mod(n, 256)::integer;
		ascii_char := chr(byte_value);
		result_text := ascii_char || result_text;
		-- Prepend to maintain correct order
		n := floor(n / 256);
	END LOOP;
	RETURN result_text;
END;
$$
LANGUAGE plpgsql;

CREATE VIEW latest_token_registrations_view AS (
	WITH all_token_registrations AS (
		SELECT
			chain_id,
			event_id,
			address,
			parse_starknet_short_string (name) AS name,
			parse_starknet_short_string (symbol) AS symbol,
			decimals,
			total_supply
		FROM
			token_registrations tr
		UNION ALL
		SELECT
			chain_id,
			event_id,
			address,
			name,
			symbol,
			decimals,
			total_supply
		FROM
			token_registrations_v3 tr_v3),
		validated_registrations AS (
			SELECT
				*
			FROM
				all_token_registrations
			WHERE
				length(symbol) > 1
				AND length(symbol) < 10
				AND REGEXP_LIKE (symbol, '^[\\x00-\\x7F]*$', 'i')
				AND length(name) < 128
				AND REGEXP_LIKE (name, '^[\\x00-\\x7F]*$', 'i')),
			event_ids_per_address AS (
				SELECT
					chain_id,
					address,
					min(event_id) AS first_registration_id,
					max(event_id) AS last_registration_id
				FROM
					validated_registrations vr
				GROUP BY
					chain_id,
					address),
				first_registration_of_each_symbol AS (
					SELECT
						chain_id,
						lower(symbol) AS lower_symbol,
						min(event_id) first_id
					FROM
						validated_registrations
					GROUP BY
						chain_id,
						lower_symbol
)
					SELECT
						iba.chain_id,
						iba.address,
						vr.name,
						vr.symbol,
						vr.decimals,
						vr.total_supply
					FROM
						event_ids_per_address AS iba
						JOIN validated_registrations AS vr ON iba.chain_id = vr.chain_id
							AND iba.address = vr.address
							AND iba.last_registration_id = vr.event_id
						JOIN first_registration_of_each_symbol fr ON fr.chain_id = vr.chain_id
							AND fr.lower_symbol = lower(vr.symbol)
							AND iba.first_registration_id = fr.first_id);

CREATE MATERIALIZED VIEW latest_token_registrations AS (
	SELECT
		chain_id,
		address,
		name,
		symbol,
		decimals,
		total_supply
	FROM
		latest_token_registrations_view);

CREATE UNIQUE INDEX idx_latest_token_registrations_by_address ON latest_token_registrations USING btree (chain_id, address);
