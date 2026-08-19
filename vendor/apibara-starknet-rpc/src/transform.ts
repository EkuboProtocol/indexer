/**
 * Public RPC-to-domain mapping facade.
 *
 * JSON-RPC transport objects deliberately remain separate from the canonical
 * Starknet block model. This object coordinates focused mappers for receipt
 * blocks, state updates, and traces so callers have one explicit conversion
 * boundary without a collection of unrelated standalone functions.
 */
import type {
  BlockHeader,
  Event,
  MessageToL1,
  Transaction,
  TransactionTrace,
} from "@apibara/starknet";
import type { StarknetRpcBlock } from "./block";
import type {
  RpcBlock,
  RpcBlockWithReceipts,
  RpcStateUpdate,
} from "./rpc-types";
import {
  type MappedReceiptBlock,
  ReceiptBlockMapper,
} from "./transform/receipt-block-mapper";
import { StateUpdateMapper } from "./transform/state-update-mapper";
import { TraceMapper } from "./transform/trace-mapper";

export type { MappedReceiptBlock };

/**
 * Coordinates the focused RPC-to-domain mappers used before BlockMapper
 * projects a complete block for each filter.
 */
export class StarknetRpcMapper {
  readonly #receiptBlocks = new ReceiptBlockMapper();
  readonly #stateUpdates = new StateUpdateMapper();
  readonly #traces = new TraceMapper();

  mapReceiptBlock(block: RpcBlockWithReceipts): MappedReceiptBlock {
    return this.#receiptBlocks.map(block);
  }

  mapHeader(block: RpcBlock): BlockHeader {
    return this.#receiptBlocks.mapHeader(block);
  }

  mapStateUpdate(
    update: RpcStateUpdate,
  ): Pick<
    StarknetRpcBlock,
    "storageDiffs" | "contractChanges" | "nonceUpdates"
  > {
    return this.#stateUpdates.map(update);
  }

  mapTraces(
    values: readonly unknown[],
    transactions: readonly Transaction[],
    events: readonly Event[],
    messages: readonly MessageToL1[],
  ): TransactionTrace[] {
    return this.#traces.map(values, transactions, events, messages);
  }
}
