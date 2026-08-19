/**
 * Maps block-with-receipts responses into canonical headers, transactions,
 * receipts, events, and messages with stable block-global indices.
 */
import type {
  BlockHeader,
  Event,
  MessageToL1,
  Transaction,
} from "@apibara/starknet";
import type { StarknetRpcTransactionReceipt } from "../block";
import type { RpcBlock, RpcBlockWithReceipts } from "../rpc-types";
import { ReceiptMapper } from "./receipt-mapper";
import { RpcValueMapper } from "./rpc-value";
import { TransactionMapper } from "./transaction-mapper";

export type MappedReceiptBlock = {
  header: BlockHeader;
  transactions: Transaction[];
  receipts: StarknetRpcTransactionReceipt[];
  events: Event[];
  messages: MessageToL1[];
};

export class ReceiptBlockMapper {
  readonly #value = new RpcValueMapper();
  readonly #transactions = new TransactionMapper();
  readonly #receipts = new ReceiptMapper();

  map(block: RpcBlockWithReceipts): MappedReceiptBlock {
    const transactions: Transaction[] = [];
    const receipts: StarknetRpcTransactionReceipt[] = [];
    const events: Event[] = [];
    const messages: MessageToL1[] = [];
    let eventIndex = 0;
    let messageIndex = 0;

    block.transactions.forEach((pair, transactionIndex) => {
      const status = this.#receipts.status(pair.receipt);
      const transactionHash = this.#value.felt(
        this.#value.string(pair.transaction.transaction_hash) ??
          pair.receipt.transaction_hash,
      );
      transactions.push(
        this.#transactions.map(
          pair.transaction,
          transactionIndex,
          transactionHash,
          status,
        ),
      );
      receipts.push(
        this.#receipts.map(
          pair.transaction,
          pair.receipt,
          transactionIndex,
          transactionHash,
        ),
      );

      for (const [indexInTransaction, value] of this.#value
        .array(pair.receipt.events)
        .entries()) {
        const event = this.#value.object(value, "event");
        events.push({
          filterIds: [],
          address: this.#value.felt(
            this.#value.string(event.from_address) ?? "0x0",
          ),
          keys: this.#value.feltArray(event.keys),
          data: this.#value.feltArray(event.data),
          eventIndex: eventIndex++,
          transactionIndex,
          transactionHash,
          transactionStatus: status,
          eventIndexInTransaction: indexInTransaction,
        });
      }
      for (const [indexInTransaction, value] of this.#value
        .array(pair.receipt.messages_sent)
        .entries()) {
        const message = this.#value.object(value, "message");
        messages.push({
          filterIds: [],
          fromAddress: this.#value.felt(
            this.#value.string(message.from_address) ?? "0x0",
          ),
          toAddress: this.#value.felt(
            this.#value.string(message.to_address) ?? "0x0",
          ),
          payload: this.#value.feltArray(message.payload),
          messageIndex: messageIndex++,
          transactionIndex,
          transactionHash,
          transactionStatus: status,
          messageIndexInTransaction: indexInTransaction,
        });
      }
    });

    return {
      header: this.mapHeader(block),
      transactions,
      receipts,
      events,
      messages,
    };
  }

  mapHeader(block: RpcBlock): BlockHeader {
    return {
      blockHash: this.#value.optionalFelt(block.block_hash),
      // pre_confirmed (pending) blocks omit parent_hash; it is not meaningful
      // for an ephemeral block, so fall back to 0x0 like sequencer_address.
      parentBlockHash: this.#value.felt(block.parent_hash ?? "0x0"),
      blockNumber: BigInt(
        this.#value.requiredNumber(block.block_number, "block_number"),
      ),
      sequencerAddress: this.#value.felt(block.sequencer_address ?? "0x0"),
      newRoot: this.#value.optionalFelt(block.new_root),
      timestamp: new Date(
        this.#value.requiredNumber(block.timestamp, "timestamp") * 1_000,
      ),
      starknetVersion: block.starknet_version ?? "",
      l1GasPrice: this.#resourcePrice(block.l1_gas_price),
      l1DataGasPrice: this.#resourcePrice(block.l1_data_gas_price),
      l1DataAvailabilityMode: block.l1_da_mode === "BLOB" ? "blob" : "calldata",
      l2GasPrice: block.l2_gas_price
        ? this.#resourcePrice(block.l2_gas_price)
        : undefined,
    };
  }

  #resourcePrice(value: unknown): {
    priceInFri?: `0x${string}`;
    priceInWei?: `0x${string}`;
  } {
    if (!this.#value.isObject(value)) return {};
    return {
      priceInFri: this.#value.optionalFelt(
        this.#value.string(value.price_in_fri),
      ),
      priceInWei: this.#value.optionalFelt(
        this.#value.string(value.price_in_wei),
      ),
    };
  }
}
