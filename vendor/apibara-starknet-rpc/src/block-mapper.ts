/**
 * Applies an ordered filter set to complete Starknet blocks.
 *
 * FetchPlan decides which RPC data is required. BlockMapper handles the
 * separate concern of mapping a complete internal block to one sparse result
 * per filter while preserving the original filter order.
 */
import type { Filter } from "@apibara/starknet";
import type { StarknetRpcBlock } from "./block";
import { CompiledFilter } from "./filter-rules";

/**
 * Whether a block is mapped while following the chain tip or while catching up
 * on history. A header filter set to `on_data_or_on_new_block` produces an
 * otherwise empty block only in the former case.
 */
export type BlockProduction = "backfill" | "live";

/**
 * Projects a complete block independently for every top-level filter.
 *
 * A CompiledFilter contains resource-specific rules such as event or
 * transaction rules. Those rules write into one BlockSelection. If multiple
 * rules select the same block resource, the selection stores it once and adds
 * every selecting rule's `id` to the resource's `filterIds`.
 *
 * ```text
 * CompiledFilter
 *   ├─ EventRule(id: 10) ─┐
 *   └─ EventRule(id: 11) ─┴─▶ event #7
 *                                  │
 *                                  ▼
 *              { eventIndex: 7, filterIds: [10, 11] }
 * ```
 *
 * Deduplication is scoped to one top-level filter result. Results are not
 * deduplicated across filters because their array positions must remain aligned
 * with the FilterSet that created this mapper.
 */
export class BlockMapper {
  readonly #filters: readonly CompiledFilter[];

  constructor(filters: readonly Filter[]) {
    this.#filters = filters.map((filter) => new CompiledFilter(filter));
  }

  map(
    block: StarknetRpcBlock,
    production: BlockProduction,
  ): readonly (StarknetRpcBlock | null)[] {
    return this.#filters.map((filter) => filter.map(block, production));
  }
}
