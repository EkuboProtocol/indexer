import type { EventFilter, Filter, TransactionFilter } from "@apibara/starknet";
import { BlockMapper } from "./block-mapper";
import { FetchPlan } from "./fetch-plan";

/**
 * Entry point for planning shared RPC acquisition and compiling per-filter
 * block projection.
 *
 * ```text
 * Filter[] ── add() ──▶ FilterSet
 *                         │
 *                         ├─ createFetchPlan() ─▶ FetchPlan ─▶ RPC ─▶ Mapper ─┐
 *                         │                                                   │
 *                         └─ createBlockMapper() ─▶ BlockMapper ◀── block ────┘
 *                                                      │
 *                                                      ▼
 *                                           CompiledFilter per filter
 *                                                      │ rules select
 *                                                      ▼
 *                                               BlockSelection
 *                                                      │ deduplicate
 *                                                      ▼
 *                                          (block | null)[] by filter
 * ```
 *
 * FetchPlan combines acquisition requirements across filters.
 * StarknetRpcMapper converts fetched transport objects into a complete block.
 * BlockMapper retains each filter's delivery policy and preserves their
 * original order.
 */
export class FilterSet {
  readonly #filters: OwnedFilter[] = [];

  add(filter: Filter): this {
    this.#filters.push(new OwnedFilter(filter, this.#filters.length));
    return this;
  }

  createFetchPlan(): FetchPlan {
    return new FetchPlan(this.#snapshots());
  }

  createBlockMapper(): BlockMapper {
    return new BlockMapper(this.#snapshots());
  }

  #snapshots(): readonly Filter[] {
    return this.#filters.map((filter) => filter.snapshot);
  }
}

/**
 * Owns and validates one canonical filter.
 *
 * The wrapper takes ownership of a structured snapshot, so later mutations to
 * a caller's JavaScript object cannot change plans or mappers created by the
 * set. The clone belongs at this ownership boundary instead of in each product.
 */
class OwnedFilter {
  readonly snapshot: Filter;

  constructor(value: Filter, position: number) {
    this.snapshot = structuredClone(value);
    try {
      this.#validate();
    } catch (error) {
      if (!(error instanceof FilterValidationError)) throw error;
      throw new Error(
        `Filter at position ${position} is invalid: ${error.message}`,
        { cause: error },
      );
    }
  }

  #validate(): void {
    const filter = this.snapshot;
    const collections = [
      filter.transactions,
      filter.events,
      filter.messages,
      filter.storageDiffs,
      filter.contractChanges,
      filter.nonceUpdates,
    ];
    if (!filter.header && collections.every((items) => !items?.length)) {
      throw new FilterValidationError("Filter has no header or data filters");
    }
    if (filter.header === "unknown") {
      throw new FilterValidationError("Unknown header mode");
    }

    for (const event of filter.events ?? []) {
      this.#validateEvent(event);
    }
    for (const transaction of filter.transactions ?? []) {
      this.#validateTransaction(transaction);
    }
    for (const message of filter.messages ?? []) {
      if (message.fromAddress && !isAddress(message.fromAddress)) {
        throw new FilterValidationError("Invalid message fromAddress");
      }
      if (message.toAddress && !isAddress(message.toAddress)) {
        throw new FilterValidationError("Invalid message toAddress");
      }
    }
    for (const state of [
      ...(filter.storageDiffs ?? []),
      ...(filter.nonceUpdates ?? []),
    ]) {
      if (state.contractAddress && !isAddress(state.contractAddress)) {
        throw new FilterValidationError("Invalid state contractAddress");
      }
    }
  }

  #validateEvent(filter: EventFilter): void {
    if (filter.address && !isAddress(filter.address)) {
      throw new FilterValidationError("Invalid event address");
    }
    for (const key of filter.keys ?? []) {
      if (key !== null && !isEventKey(key)) {
        throw new FilterValidationError("Invalid event key");
      }
    }
    if (filter.transactionStatus === "unknown") {
      throw new FilterValidationError("Unknown event transaction status");
    }
  }

  #validateTransaction(filter: TransactionFilter): void {
    if (filter.transactionStatus === "unknown") {
      throw new FilterValidationError("Unknown transaction status");
    }
  }
}

/** Distinguishes invalid user filters from unexpected implementation errors. */
class FilterValidationError extends Error {}

const HEX_FIELD_ELEMENT = /^0x[0-9a-fA-F]{1,64}$/;

function isAddress(value: string): boolean {
  return HEX_FIELD_ELEMENT.test(value);
}

function isEventKey(value: string): boolean {
  return HEX_FIELD_ELEMENT.test(value);
}
