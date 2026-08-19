/**
 * Builds the network-facing view of a filter set.
 *
 * A fetch plan contains only the information needed to decide which Starknet
 * RPC methods to call. Matching those responses against individual filters is
 * handled independently by BlockMapper.
 */
import type { Filter, HeaderFilter } from "@apibara/starknet";
import { normalizeFelt } from "./felt";

/**
 * Shared RPC acquisition requirements derived from a FilterSet.
 *
 * This object decides which network data must be available. It does not decide
 * which filters receive that data; BlockMapper applies those policies after
 * RPC responses have been converted into a complete block.
 */
export class FetchPlan {
  /**
   * Smallest shared header requirement that covers every filter. Individual
   * delivery policies remain on the filters compiled by BlockMapper.
   */
  readonly headerRequirement: HeaderFilter | undefined;
  /** Whether event data must be fetched. */
  readonly fetchEvents: boolean;
  /** Whether transaction receipts must be fetched. */
  readonly fetchReceipts: boolean;
  /** Whether state updates must be fetched. */
  readonly fetchState: boolean;
  /** Whether transaction traces must be fetched. */
  readonly fetchTraces: boolean;
  /** Normalized contract addresses that can constrain a state request. */
  readonly stateAddresses: readonly string[];

  constructor(filters: readonly Filter[]) {
    const headerRequirement = new HeaderFetchRequirement();
    const stateAddresses = new Set<string>();
    let fetchEvents = false;
    let fetchReceipts = false;
    let fetchState = false;
    let fetchTraces = false;

    for (const filter of filters) {
      headerRequirement.include(filter.header);

      for (const event of filter.events ?? []) {
        fetchEvents = true;
        fetchReceipts = true;
        fetchTraces ||= event.includeTransactionTrace === true;
      }
      for (const transaction of filter.transactions ?? []) {
        fetchReceipts = true;
        fetchTraces ||= transaction.includeTrace === true;
      }
      for (const message of filter.messages ?? []) {
        fetchReceipts = true;
        fetchTraces ||= message.includeTransactionTrace === true;
      }
      for (const storage of filter.storageDiffs ?? []) {
        fetchState = true;
        if (storage.contractAddress !== undefined) {
          stateAddresses.add(normalizeFelt(storage.contractAddress));
        }
      }
      for (const nonce of filter.nonceUpdates ?? []) {
        fetchState = true;
        if (nonce.contractAddress !== undefined) {
          stateAddresses.add(normalizeFelt(nonce.contractAddress));
        }
      }
      fetchState ||= (filter.contractChanges?.length ?? 0) > 0;
    }

    this.headerRequirement = headerRequirement.value;
    this.fetchEvents = fetchEvents;
    this.fetchReceipts = fetchReceipts;
    this.fetchState = fetchState;
    this.fetchTraces = fetchTraces;
    this.stateAddresses = Object.freeze([...stateAddresses]);
    Object.freeze(this);
  }
}

/**
 * Combines per-filter header policies into one acquisition requirement.
 *
 * The policies describe nested sets of headers:
 * `on_data` is contained by `on_data_or_on_new_block`, which is contained by
 * `always`. Selecting the strongest requested policy therefore produces the
 * smallest shared fetch superset without changing any filter's delivery policy.
 */
class HeaderFetchRequirement {
  static readonly #priority: Readonly<
    Record<Exclude<HeaderFilter, "unknown">, number>
  > = {
    on_data: 1,
    on_data_or_on_new_block: 2,
    always: 3,
  };

  #value: HeaderFilter | undefined;

  include(header: HeaderFilter | undefined): void {
    if (header === undefined || header === "unknown") return;
    if (
      this.#value === undefined ||
      this.#value === "unknown" ||
      HeaderFetchRequirement.#priority[header] >
        HeaderFetchRequirement.#priority[this.#value]
    ) {
      this.#value = header;
    }
  }

  get value(): HeaderFilter | undefined {
    return this.#value;
  }
}
