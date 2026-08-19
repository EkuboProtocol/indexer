/**
 * Accumulates the resources selected while one filter is applied to a block.
 *
 * The class centralizes related-resource lookups, stable ordering, and
 * construction of one sparse block. Each resource is keyed by its stable block
 * index, so overlapping rules retain one copy while accumulating the IDs of
 * every rule that selected it.
 */
import type {
  ContractChange,
  Event,
  HeaderFilter,
  MessageToL1,
  NonceUpdate,
  StorageDiff,
  Transaction,
  TransactionTrace,
} from "@apibara/starknet";
import type { StarknetRpcBlock, StarknetRpcTransactionReceipt } from "./block";
import type { BlockProduction } from "./block-mapper";

/**
 * Accumulates one CompiledFilter's sparse block result.
 *
 * Resource-specific selection methods can select the same item repeatedly.
 * SelectedItems keeps one item per stable block index and records every nested
 * rule ID that selected it.
 */
export class BlockSelection {
  readonly #block: StarknetRpcBlock;
  readonly #transactions = new SelectedItems<Transaction>();
  readonly #receipts = new SelectedItems<StarknetRpcTransactionReceipt>();
  readonly #events = new SelectedItems<Event>();
  readonly #messages = new SelectedItems<MessageToL1>();
  readonly #traces = new SelectedItems<TransactionTrace>();
  readonly #storageDiffs = new SelectedItems<StorageDiff>();
  readonly #contractChanges = new SelectedItems<ContractChange>();
  readonly #nonceUpdates = new SelectedItems<NonceUpdate>();

  constructor(block: StarknetRpcBlock) {
    this.#block = block;
  }

  selectTransaction(
    transaction: Transaction,
    filterId: number | undefined,
  ): void {
    this.#transactions.select(
      transaction.meta.transactionIndex,
      transaction,
      filterId,
    );
  }

  selectEvent(event: Event, filterId: number | undefined): void {
    this.#events.select(event.eventIndex, event, filterId);
  }

  selectMessage(message: MessageToL1, filterId: number | undefined): void {
    this.#messages.select(message.messageIndex, message, filterId);
  }

  selectStorageDiff(
    index: number,
    storageDiff: StorageDiff,
    filterId: number | undefined,
  ): void {
    this.#storageDiffs.select(index, storageDiff, filterId);
  }

  selectContractChange(
    index: number,
    contractChange: ContractChange,
    filterId: number | undefined,
  ): void {
    this.#contractChanges.select(index, contractChange, filterId);
  }

  selectNonceUpdate(
    index: number,
    nonceUpdate: NonceUpdate,
    filterId: number | undefined,
  ): void {
    this.#nonceUpdates.select(index, nonceUpdate, filterId);
  }

  selectTransactionByIndex(
    transactionIndex: number,
    filterId: number | undefined,
  ): void {
    const transaction = this.#block.transactions.find(
      (item) => item.meta.transactionIndex === transactionIndex,
    );
    if (transaction) this.selectTransaction(transaction, filterId);
  }

  selectReceiptForTransaction(
    transactionIndex: number,
    filterId: number | undefined,
  ): void {
    const receipt = this.#block.receipts.find(
      (item) => item.meta.transactionIndex === transactionIndex,
    );
    if (receipt) this.#receipts.select(transactionIndex, receipt, filterId);
  }

  selectEventsFromTransaction(
    transactionIndex: number,
    filterId: number | undefined,
  ): void {
    for (const event of this.#block.events) {
      if (event.transactionIndex === transactionIndex) {
        this.selectEvent(event, filterId);
      }
    }
  }

  selectMessagesFromTransaction(
    transactionIndex: number,
    filterId: number | undefined,
  ): void {
    for (const message of this.#block.messages) {
      if (message.transactionIndex === transactionIndex) {
        this.selectMessage(message, filterId);
      }
    }
  }

  selectTraceForTransaction(
    transactionIndex: number,
    filterId: number | undefined,
  ): void {
    const trace = this.#block.traces.find(
      (item) => item.transactionIndex === transactionIndex,
    );
    if (trace) this.#traces.select(transactionIndex, trace, filterId);
  }

  toBlock(
    header: HeaderFilter | undefined,
    production: BlockProduction,
  ): StarknetRpcBlock | null {
    const includeEmptyHeader =
      header === "always" ||
      (header === "on_data_or_on_new_block" && production === "live");
    if (!this.#hasData() && !includeEmptyHeader) return null;
    return {
      header: this.#block.header,
      transactions: this.#transactions.values,
      receipts: this.#receipts.values,
      events: this.#events.values,
      messages: this.#messages.values,
      traces: this.#traces.values,
      storageDiffs: this.#storageDiffs.values,
      contractChanges: this.#contractChanges.values,
      nonceUpdates: this.#nonceUpdates.values,
    };
  }

  #hasData(): boolean {
    return (
      this.#transactions.size +
        this.#receipts.size +
        this.#events.size +
        this.#messages.size +
        this.#traces.size +
        this.#storageDiffs.size +
        this.#contractChanges.size +
        this.#nonceUpdates.size >
      0
    );
  }
}

/**
 * Stores one copy of each selected block resource and records every nested
 * filter-rule ID that selected it. Re-selecting a resource with the same ID is
 * idempotent; selecting it with another ID appends that ID to `filterIds`.
 */
class SelectedItems<T extends { readonly filterIds: readonly number[] }> {
  readonly #items = new Map<number, T>();

  get size(): number {
    return this.#items.size;
  }

  get values(): T[] {
    return [...this.#items.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value);
  }

  select(key: number, value: T, filterId: number | undefined): void {
    const id = filterId ?? 0;
    const existing = this.#items.get(key);
    const filterIds = existing?.filterIds ?? value.filterIds;
    this.#items.set(key, {
      ...(existing ?? value),
      filterIds: filterIds.includes(id) ? [...filterIds] : [...filterIds, id],
    });
  }
}
