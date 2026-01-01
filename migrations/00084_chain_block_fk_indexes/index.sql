CREATE INDEX IF NOT EXISTS idx_pool_initializations_chain_block ON pool_initializations (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_position_updates_chain_block ON position_updates (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_protocol_fees_paid_chain_block ON protocol_fees_paid (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_position_fees_collected_chain_block ON position_fees_collected (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_fees_accumulated_chain_block ON fees_accumulated (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_protocol_fees_withdrawn_chain_block ON protocol_fees_withdrawn (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_extension_registrations_chain_block ON extension_registrations (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_nonfungible_token_transfers_chain_block ON nonfungible_token_transfers (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_twamm_virtual_order_exec_chain_block ON twamm_virtual_order_executions (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_twamm_order_updates_chain_block ON twamm_order_updates (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_twamm_proceeds_withdrawals_chain_block ON twamm_proceeds_withdrawals (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_oracle_snapshots_chain_block ON oracle_snapshots (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_staker_staked_chain_block ON staker_staked (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_staker_withdrawn_chain_block ON staker_withdrawn (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_governor_reconfigured_chain_block ON governor_reconfigured (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_governor_proposed_chain_block ON governor_proposed (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_governor_executed_chain_block ON governor_executed (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_governor_voted_chain_block ON governor_voted (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_governor_proposal_described_chain_block ON governor_proposal_described (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_limit_order_placed_chain_block ON limit_order_placed (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_limit_order_closed_chain_block ON limit_order_closed (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_spline_liquidity_updated_chain_block ON spline_liquidity_updated (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_incentives_funded_chain_block ON incentives_funded (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_incentives_refunded_chain_block ON incentives_refunded (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_token_wrapper_deployed_chain_block ON token_wrapper_deployed (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_token_registrations_chain_block ON token_registrations (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_token_registrations_v3_chain_block ON token_registrations_v3 (chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_position_fees_withheld_chain_block ON position_fees_withheld (chain_id, block_number);
