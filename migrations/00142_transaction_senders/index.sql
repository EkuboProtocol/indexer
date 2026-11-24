-- The account that sent each transaction with an indexed event: the EVM
-- transaction's `from`, and on Starknet the INVOKE or DECLARE transaction's
-- sender (an account contract). Event rows keep only their `locker`, the
-- contract that called Core (a router, the Positions contract, an extension),
-- so this is where the wallet behind a swap or position update is recorded.
--
-- One row per transaction instead of a column on swaps and position_updates:
-- a transaction's events share one sender, the event tables refuse updates,
-- and filling a new column would rewrite tens of millions of existing rows.
-- Rows written before the backfill reaches them are simply absent, so readers
-- LEFT JOIN on (chain_id, block_number, transaction_index).
--
-- The sender is the account that submitted the transaction, which is not the
-- user when someone else relays it (an ERC-4337 bundler, a Starknet paymaster
-- calling execute_from_outside). Starknet transactions without a sender field
-- (L1_HANDLER, DEPLOY_ACCOUNT) get no row.
CREATE TABLE transaction_senders
(
    chain_id          INT8    NOT NULL,
    block_number      INT8    NOT NULL,
    transaction_index INT4    NOT NULL,
    sender            NUMERIC NOT NULL,
    PRIMARY KEY (chain_id, block_number, transaction_index),
    FOREIGN KEY (chain_id, block_number) REFERENCES blocks (chain_id, block_number) ON DELETE CASCADE
);

CREATE TRIGGER no_updates_transaction_senders
    BEFORE UPDATE
    ON transaction_senders
    FOR EACH ROW
EXECUTE FUNCTION block_updates();
