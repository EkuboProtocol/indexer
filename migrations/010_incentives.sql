CREATE TABLE incentives_funded (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  owner NUMERIC NOT NULL,
  token NUMERIC NOT NULL,
  root NUMERIC NOT NULL,
  amount_next NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE TABLE incentives_refunded (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  owner NUMERIC NOT NULL,
  token NUMERIC NOT NULL,
  root NUMERIC NOT NULL,
  refund_amount NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);
CREATE TABLE token_wrapper_deployed (
  chain_id int8 NOT NULL,
  event_id int8 NOT NULL,
  token_wrapper NUMERIC NOT NULL,
  underlying_token NUMERIC NOT NULL,
  unlock_time NUMERIC NOT NULL,
  PRIMARY KEY (chain_id, event_id),
  FOREIGN KEY (chain_id, event_id) REFERENCES event_keys (chain_id, sort_id) ON DELETE CASCADE
);