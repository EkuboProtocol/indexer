/**
 * Compiles one canonical Filter into resource-specific matching rules.
 *
 * Each rule owns the matching semantics for one filter collection. Matches
 * are written to BlockSelection, which handles related resources and output
 * construction.
 */
import type {
  ContractChange,
  ContractChangeFilter,
  Event,
  EventFilter,
  Filter,
  MessageToL1,
  MessageToL1Filter,
  NonceUpdateFilter,
  StorageDiffFilter,
  Transaction,
  TransactionFilter,
  TransactionStatusFilter,
} from "@apibara/starknet";
import type { StarknetRpcBlock } from "./block";
import type { BlockProduction } from "./block-mapper";
import { BlockSelection } from "./block-selection";
import { normalizeFelt } from "./felt";

interface FilterRule {
  apply(block: StarknetRpcBlock, selection: BlockSelection): void;
}

/**
 * Compiles one top-level filter into resource-specific matching rules.
 * Matching rules write their resources and rule IDs into a
 * BlockSelection, which owns deduplication and output construction.
 *
 * Each item in a filter collection becomes one rule object. A rule owns both
 * its matching constraints and its include-related-resource behavior. Mapping
 * a block creates a fresh selection, applies every rule, then asks the
 * selection to produce the sparse result under the original header policy.
 *
 * ```text
 * Filter
 *   ├─ transactions[] ..... TransactionRule[] ..... ┐
 *   ├─ events[] ........... EventRule[] ........... ┤
 *   ├─ messages[] ......... MessageRule[] ......... ┤
 *   ├─ storageDiffs[] ..... StorageDiffRule[] ..... ┤
 *   ├─ contractChanges[] .. ContractChangeRule[] .. ┤
 *   └─ nonceUpdates[] ..... NonceUpdateRule[] ..... ┘
 *                                                    │
 *                                                    ▼
 *                                          apply(block, selection)
 *                                                    │
 *                                                    ▼
 *                                             BlockSelection
 *                                  one resource + all selecting IDs
 * ```
 */
export class CompiledFilter {
  readonly #header: Filter["header"];
  readonly #rules: readonly FilterRule[];

  constructor(filter: Filter) {
    this.#header = filter.header;
    this.#rules = [
      ...(filter.transactions ?? []).map((item) => new TransactionRule(item)),
      ...(filter.events ?? []).map((item) => new EventRule(item)),
      ...(filter.messages ?? []).map((item) => new MessageRule(item)),
      ...(filter.storageDiffs ?? []).map((item) => new StorageDiffRule(item)),
      ...(filter.contractChanges ?? []).map(
        (item) => new ContractChangeRule(item),
      ),
      ...(filter.nonceUpdates ?? []).map((item) => new NonceUpdateRule(item)),
    ];
  }

  map(
    block: StarknetRpcBlock,
    production: BlockProduction,
  ): StarknetRpcBlock | null {
    const selection = new BlockSelection(block);
    for (const rule of this.#rules) rule.apply(block, selection);
    return selection.toBlock(this.#header, production);
  }
}

class TransactionRule implements FilterRule {
  readonly #filter: TransactionFilter;
  readonly #status: StatusMatcher;

  constructor(filter: TransactionFilter) {
    this.#filter = filter;
    this.#status = new StatusMatcher(filter.transactionStatus);
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    for (const transaction of block.transactions) {
      if (!this.#matches(transaction)) continue;
      const index = transaction.meta.transactionIndex;
      const filterId = this.#filter.id;
      selection.selectTransaction(transaction, filterId);
      if (this.#filter.includeReceipt) {
        selection.selectReceiptForTransaction(index, filterId);
      }
      if (this.#filter.includeEvents) {
        selection.selectEventsFromTransaction(index, filterId);
      }
      if (this.#filter.includeMessages) {
        selection.selectMessagesFromTransaction(index, filterId);
      }
      if (this.#filter.includeTrace) {
        selection.selectTraceForTransaction(index, filterId);
      }
    }
  }

  #matches(transaction: Transaction): boolean {
    return (
      this.#status.matches(transaction.meta.transactionStatus) &&
      (this.#filter.transactionType === undefined ||
        this.#filter.transactionType._tag === transaction.transaction._tag)
    );
  }
}

class EventRule implements FilterRule {
  readonly #filter: EventFilter;
  readonly #address: FeltMatcher;
  readonly #keys: EventKeysMatcher;
  readonly #status: StatusMatcher;

  constructor(filter: EventFilter) {
    this.#filter = filter;
    this.#address = new FeltMatcher(filter.address);
    this.#keys = new EventKeysMatcher(
      filter.keys ?? [],
      filter.strict === true,
    );
    this.#status = new StatusMatcher(filter.transactionStatus);
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    for (const event of block.events) {
      if (!this.#matches(event)) continue;
      const transactionIndex = event.transactionIndex;
      const filterId = this.#filter.id;
      selection.selectEvent(event, filterId);
      if (this.#filter.includeTransaction) {
        selection.selectTransactionByIndex(transactionIndex, filterId);
      }
      if (this.#filter.includeReceipt) {
        selection.selectReceiptForTransaction(transactionIndex, filterId);
      }
      if (this.#filter.includeMessages) {
        selection.selectMessagesFromTransaction(transactionIndex, filterId);
      }
      if (this.#filter.includeSiblings) {
        selection.selectEventsFromTransaction(transactionIndex, filterId);
      }
      if (this.#filter.includeTransactionTrace) {
        selection.selectTraceForTransaction(transactionIndex, filterId);
      }
    }
  }

  #matches(event: Event): boolean {
    return (
      this.#address.matches(event.address) &&
      this.#status.matches(event.transactionStatus) &&
      this.#keys.matches(event.keys)
    );
  }
}

class MessageRule implements FilterRule {
  readonly #filter: MessageToL1Filter;
  readonly #fromAddress: FeltMatcher;
  readonly #toAddress: FeltMatcher;
  readonly #status: StatusMatcher;

  constructor(filter: MessageToL1Filter) {
    this.#filter = filter;
    this.#fromAddress = new FeltMatcher(filter.fromAddress);
    this.#toAddress = new FeltMatcher(filter.toAddress);
    this.#status = new StatusMatcher(filter.transactionStatus);
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    for (const message of block.messages) {
      if (!this.#matches(message)) continue;
      const transactionIndex = message.transactionIndex;
      const filterId = this.#filter.id;
      selection.selectMessage(message, filterId);
      if (this.#filter.includeTransaction) {
        selection.selectTransactionByIndex(transactionIndex, filterId);
      }
      if (this.#filter.includeReceipt) {
        selection.selectReceiptForTransaction(transactionIndex, filterId);
      }
      if (this.#filter.includeEvents) {
        selection.selectEventsFromTransaction(transactionIndex, filterId);
      }
      if (this.#filter.includeTransactionTrace) {
        selection.selectTraceForTransaction(transactionIndex, filterId);
      }
    }
  }

  #matches(message: MessageToL1): boolean {
    return (
      this.#fromAddress.matches(message.fromAddress) &&
      this.#toAddress.matches(message.toAddress) &&
      this.#status.matches(message.transactionStatus)
    );
  }
}

class StorageDiffRule implements FilterRule {
  readonly #filter: StorageDiffFilter;
  readonly #address: FeltMatcher;

  constructor(filter: StorageDiffFilter) {
    this.#filter = filter;
    this.#address = new FeltMatcher(filter.contractAddress);
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    block.storageDiffs.forEach((storageDiff, index) => {
      if (this.#address.matches(storageDiff.contractAddress)) {
        selection.selectStorageDiff(index, storageDiff, this.#filter.id);
      }
    });
  }
}

class ContractChangeRule implements FilterRule {
  readonly #filter: ContractChangeFilter;

  constructor(filter: ContractChangeFilter) {
    this.#filter = filter;
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    block.contractChanges.forEach((contractChange, index) => {
      if (this.#matches(contractChange)) {
        selection.selectContractChange(index, contractChange, this.#filter.id);
      }
    });
  }

  #matches(contractChange: ContractChange): boolean {
    return (
      this.#filter.change === undefined ||
      this.#filter.change._tag === contractChange.change._tag
    );
  }
}

class NonceUpdateRule implements FilterRule {
  readonly #filter: NonceUpdateFilter;
  readonly #address: FeltMatcher;

  constructor(filter: NonceUpdateFilter) {
    this.#filter = filter;
    this.#address = new FeltMatcher(filter.contractAddress);
  }

  apply(block: StarknetRpcBlock, selection: BlockSelection): void {
    block.nonceUpdates.forEach((nonceUpdate, index) => {
      if (this.#address.matches(nonceUpdate.contractAddress)) {
        selection.selectNonceUpdate(index, nonceUpdate, this.#filter.id);
      }
    });
  }
}

/**
 * Matches a required field element against an optional normalized constraint.
 */
class FeltMatcher {
  readonly #expected: string | undefined;

  constructor(expected: string | undefined) {
    this.#expected =
      expected === undefined ? undefined : normalizeFelt(expected);
  }

  matches(actual: string): boolean {
    return (
      this.#expected === undefined || normalizeFelt(actual) === this.#expected
    );
  }
}

/** Applies strict or prefix event-key matching with null wildcards. */
class EventKeysMatcher {
  readonly #keys: readonly (string | null)[];
  readonly #strict: boolean;

  constructor(keys: readonly (string | null)[], strict: boolean) {
    this.#keys = keys.map((key) => (key === null ? null : normalizeFelt(key)));
    this.#strict = strict;
  }

  matches(actual: readonly string[]): boolean {
    if (this.#strict && actual.length !== this.#keys.length) return false;
    if (actual.length < this.#keys.length) return false;
    return this.#keys.every(
      (expected, index) =>
        expected === null || normalizeFelt(actual[index]) === expected,
    );
  }
}

/** Implements the canonical default-to-succeeded transaction status rule. */
class StatusMatcher {
  readonly #expected: TransactionStatusFilter;

  constructor(expected: TransactionStatusFilter | undefined) {
    this.#expected = expected ?? "succeeded";
  }

  matches(actual: string): boolean {
    return this.#expected === "all" || actual === this.#expected;
  }
}
