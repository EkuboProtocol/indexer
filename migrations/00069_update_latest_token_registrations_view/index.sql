DROP MATERIALIZED VIEW IF EXISTS latest_token_registrations_materialized;
DROP VIEW IF EXISTS latest_token_registrations_view;

CREATE VIEW latest_token_registrations_view AS (
  WITH all_token_registrations AS (
    SELECT
      chain_id,
      event_id,
      address,
      parse_starknet_short_string(name) AS name,
      parse_starknet_short_string(symbol) AS symbol,
      decimals,
      total_supply
    FROM
      token_registrations
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
      token_registrations_v3
  ),
  validated_registrations AS (
    SELECT
      *
    FROM
      all_token_registrations
    WHERE
      REGEXP_LIKE(symbol, '^[[:print:]]{1,9}$', 'i')
      AND REGEXP_LIKE(name, '^[[:print:]]{1,127}$', 'i')
  ),
  event_ids_per_address AS (
    SELECT
      chain_id,
      address,
      min(event_id) AS first_registration_event_id,
      max(event_id) AS last_registration_event_id
    FROM
      validated_registrations
    GROUP BY
      chain_id,
      address
  ),
  latest_registrations AS (
    SELECT
      eia.chain_id,
      eia.address,
      vr.name,
      vr.symbol,
      vr.decimals,
      vr.total_supply,
      row_number() OVER (
        PARTITION BY eia.chain_id, lower(vr.symbol)
        ORDER BY eia.first_registration_event_id
      ) - 1 AS symbol_registration_index
    FROM
      event_ids_per_address AS eia
      JOIN validated_registrations AS vr ON eia.chain_id = vr.chain_id
        AND eia.address = vr.address
        AND eia.last_registration_event_id = vr.event_id
  )
  SELECT
    lr.chain_id,
    lr.address,
    lr.name,
    lr.symbol,
    lr.decimals,
    lr.total_supply,
    lr.symbol_registration_index
  FROM
    latest_registrations lr
);
