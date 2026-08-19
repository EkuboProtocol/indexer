import type { Bytes } from "@apibara/protocol";
import type { DataFinality } from "@apibara/protocol";
import {
  type BlockInfo,
  type FetchBlockByHashArgs,
  type FetchBlockByHashResult,
  type FetchBlockRangeArgs,
  type FetchBlockRangeManyArgs,
  type FetchBlockRangeManyResult,
  type FetchBlockRangeResult,
  type FetchCursorArgs,
  type FetchCursorRangeArgs,
  type FetchHeaderByHashManyArgs,
  type FetchHeaderByHashManyResult,
  RpcStreamConfig,
  type ValidateFilterResult,
  sleep,
} from "@apibara/protocol/rpc";
import { type Filter, mergeFilter } from "@apibara/starknet";
import { metrics } from "@opentelemetry/api";
import { satisfies } from "semver";
import type { StarknetRpcBlock } from "./block";
import type { BlockMapper, BlockProduction } from "./block-mapper";
import { StarknetJsonRpcClient } from "./client";
import { StarknetEndpointCapabilities } from "./endpoint-capabilities";
import {
  StarknetRpcCapabilityError,
  StarknetRpcError,
  UnsupportedStarknetRpcVersionError,
} from "./errors";
import { normalizeFelt } from "./felt";
import type { FetchPlan } from "./fetch-plan";
import { FilterSet } from "./filter";
import { StarknetRpcCapabilities, parseSpecVersion } from "./rpc-capabilities";
import type {
  RpcBlock,
  RpcBlockWithReceipts,
  RpcEventPage,
  RpcObject,
  RpcStateUpdate,
} from "./rpc-types";
import { StarknetRpcMapper } from "./transform";
import { StarknetWebSocketSignal } from "./websocket";

export type StarknetRpcStreamOptions = {
  url: string;
  wsUrl?: string;
  /** Custom Fetch implementation used by runtime requests and HTTP probes. */
  fetch?: typeof globalThis.fetch;
  /** Additional HTTP headers used by runtime requests and HTTP probes. */
  headers?: HeadersInit;
  compatibility?: "auto" | "0.9" | "0.10.2";
  requestsPerSecond?: number;
  maxConcurrency?: number;
  mergeEventFilters?: "always" | "accepted" | false;
  /** Timeout in milliseconds for HTTP, trace, probe, and WebSocket requests. */
  timeout?: number;
  /** Number of retries after the initial request. */
  retryCount?: number;
  /** Fixed delay between retries in milliseconds. */
  retryDelay?: number;
  pendingDebounceMs?: number;
  pendingPolling?: boolean;
  batch?: boolean;
  /** Maximum accepted block numbers retained in each cache. Set to 0 to disable. */
  cacheSize?: number;
  /** Maximum blocks fetched concurrently in cursor and block-loading windows. */
  blockRangeSize?: number;
  /** Maximum events requested in one starknet_getEvents response page. */
  eventPageSize?: number;
  /** Maximum block span covered by one starknet_getEvents token chain. */
  eventRangeSize?: bigint;
  headRefreshIntervalMs?: number;
  finalizedRefreshIntervalMs?: number;
};

type StarknetCapabilities = {
  rpc: StarknetRpcCapabilities;
  endpoint: StarknetEndpointCapabilities;
};

const meter = metrics.getMeter("@apibara/starknet-rpc");
const candidateCounter = meter.createCounter(
  "apibara.starknet_rpc.candidate_blocks",
);
const fullBlockCounter = meter.createCounter(
  "apibara.starknet_rpc.full_block_loads",
);
const stateCounter = meter.createCounter("apibara.starknet_rpc.state_loads");
const traceCounter = meter.createCounter("apibara.starknet_rpc.traces");
const pageCounter = meter.createCounter("apibara.starknet_rpc.event_pages");
const cacheCounter = meter.createCounter("apibara.starknet_rpc.cache_hits");
const rangeHistogram = meter.createHistogram(
  "apibara.starknet_rpc.event_range_size",
  { unit: "blocks" },
);

const DEFAULT_CACHE_SIZE = 128;
const DEFAULT_BLOCK_RANGE_SIZE = 20;
const DEFAULT_EVENT_PAGE_SIZE = 1_000;

type CachedStateUpdate = {
  addressKey: string;
  update: RpcStateUpdate;
};

export class StarknetRpcStream extends RpcStreamConfig<
  Filter,
  StarknetRpcBlock
> {
  readonly mergeFilter = mergeFilter;
  private client: StarknetJsonRpcClient;
  private capabilitiesPromise?: Promise<StarknetCapabilities>;
  private capabilities?: StarknetCapabilities;
  private readonly headerCache = new Map<bigint, RpcBlock>();
  private readonly receiptCache = new Map<bigint, RpcBlockWithReceipts>();
  private readonly stateCache = new Map<bigint, CachedStateUpdate>();
  private readonly cacheOrder = new Map<bigint, true>();
  private websocketSignal?: StarknetWebSocketSignal;
  private pendingLoaded = false;
  // Highest block number seen from a `latest` cursor fetch. The stream driver
  // refreshes the head before asking for a range, so this is the same head that
  // bounds the range being requested.
  private latestBlockNumber?: bigint;
  private readonly rpcMapper = new StarknetRpcMapper();

  constructor(private readonly options: StarknetRpcStreamOptions) {
    super();
    validateNonNegativeInteger(options.cacheSize, "cacheSize");
    validatePositiveInteger(options.blockRangeSize, "blockRangeSize");
    validatePositiveInteger(options.eventPageSize, "eventPageSize");
    if (options.eventRangeSize !== undefined && options.eventRangeSize <= 0n) {
      throw new Error("eventRangeSize must be greater than zero");
    }
    this.client = this.createClient(false);
  }

  headRefreshIntervalMs(): number {
    return this.options.headRefreshIntervalMs ?? 3_000;
  }

  finalizedRefreshIntervalMs(): number {
    return this.options.finalizedRefreshIntervalMs ?? 30_000;
  }

  pendingRefreshIntervalMs(): number {
    return this.options.pendingDebounceMs ?? 250;
  }

  override async waitForHeadChange(timeoutMs: number): Promise<void> {
    if (this.websocketSignal) {
      await this.websocketSignal.wait("accepted", timeoutMs);
      return;
    }
    await super.waitForHeadChange(timeoutMs);
  }

  validateFilter(filter: Filter): ValidateFilterResult {
    try {
      new FilterSet().add(filter);
      return { valid: true };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return {
        valid: false,
        error:
          cause instanceof Error
            ? cause.message
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }

  async initializeRequest(
    filters: readonly Filter[],
    finality: DataFinality,
  ): Promise<void> {
    const capabilities = await this.getCapabilities();
    const { rpc, endpoint } = capabilities;
    const plan = this.createFilterSet(filters).createFetchPlan();
    const version = parseSpecVersion(rpc.specVersion);
    const supportedBaseline = satisfies(version, "0.9.x");
    // Accept the whole 0.10 line, including release candidates such as
    // 0.10.3-rc.0, rather than pinning to an exact patch release. Per-version
    // feature differences are already derived by StarknetRpcCapabilities.
    const supportedEnhanced = satisfies(version, ">=0.10.0 <0.11.0", {
      includePrerelease: true,
    });
    if (!supportedBaseline && !supportedEnhanced) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    if (this.options.compatibility === "0.10.2" && !supportedEnhanced) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    if (this.options.compatibility === "0.9" && !supportedBaseline) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    const requestsTraces = plan.fetchTraces;
    if (finality === "pending" && requestsTraces) {
      throw new StarknetRpcCapabilityError(
        "pending traces",
        "traceBlockTransactions does not support pre_confirmed blocks",
      );
    }
    if (requestsTraces && !rpc.traces) {
      throw new StarknetRpcCapabilityError(
        "traces",
        "the reported RPC specification does not define starknet_traceBlockTransactions",
      );
    }
    if (finality === "pending") {
      const subscriptions = rpc.subscriptions;
      const compatibleWs =
        endpoint.webSocket &&
        subscriptions.newHeads &&
        (subscriptions.newTransactions ||
          subscriptions.transactionStatus ||
          subscriptions.events);
      if (!compatibleWs && !this.options.pendingPolling) {
        throw new StarknetRpcCapabilityError(
          "pending WebSocket subscriptions",
          "provide a compatible wsUrl or explicitly set pendingPolling: true",
        );
      }
    }
    if (
      this.options.wsUrl &&
      endpoint.webSocket &&
      rpc.subscriptions.newHeads
    ) {
      this.websocketSignal ??= new StarknetWebSocketSignal(
        this.options.wsUrl,
        this.timeout(),
      );
      try {
        await this.websocketSignal.connect(finality === "pending");
      } catch (error) {
        this.websocketSignal = undefined;
        if (finality === "pending" && !this.options.pendingPolling) {
          throw new StarknetRpcCapabilityError(
            "pending WebSocket connection",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    if (
      (plan.fetchReceipts || finality === "pending") &&
      !rpc.blockWithReceipts
    ) {
      throw new StarknetRpcCapabilityError(
        "receipt blocks",
        "the reported RPC specification does not define starknet_getBlockWithReceipts",
      );
    }
    if (plan.fetchState && !rpc.stateUpdates) {
      throw new StarknetRpcCapabilityError(
        "state updates",
        "the reported RPC specification does not define starknet_getStateUpdate",
      );
    }
    if (this.options.batch) {
      if (!endpoint.batch) {
        throw new StarknetRpcCapabilityError(
          "JSON-RPC batch",
          "the capability probe rejected batched requests",
        );
      }
      this.client = this.createClient(true);
    }
  }

  async fetchCursor(args: FetchCursorArgs): Promise<BlockInfo | null> {
    const blockId = cursorArgsToBlockId(args);
    let block: RpcBlock;
    try {
      block = await this.request<RpcBlock>("starknet_getBlockWithTxHashes", [
        blockId,
      ]);
    } catch (error) {
      if (isBlockNotFound(error)) return null;
      throw error;
    }
    const info = this.rememberBlock(block);
    if (args.blockTag === "latest") {
      // A reorg can move the head backwards, so track it rather than keeping
      // the maximum ever seen.
      this.latestBlockNumber = info.blockNumber;
    }
    return info;
  }

  async fetchCursorRange({
    startBlockNumber,
    endBlockNumber,
  }: FetchCursorRangeArgs): Promise<BlockInfo[]> {
    const result: BlockInfo[] = [];
    const rangeSize = BigInt(this.blockRangeSize());
    for (
      let windowStart = startBlockNumber;
      windowStart <= endBlockNumber;
      windowStart += rangeSize
    ) {
      const windowEnd =
        windowStart + rangeSize - 1n < endBlockNumber
          ? windowStart + rangeSize - 1n
          : endBlockNumber;
      const requests: Promise<BlockInfo | null>[] = [];
      for (let number = windowStart; number <= windowEnd; number++) {
        requests.push(this.fetchCursor({ blockNumber: number }));
      }
      const values = await Promise.all(requests);
      for (const value of values) {
        if (!value) throw new Error("Missing block inside canonical range");
        result.push(value);
      }
    }
    return result;
  }

  async fetchBlockRange(
    args: FetchBlockRangeArgs<Filter>,
  ): Promise<FetchBlockRangeResult<StarknetRpcBlock>> {
    const result = await this.fetchBlockRangeMany({
      ...args,
      filters: [args.filter],
    });
    return {
      startBlock: result.startBlock,
      endBlock: result.endBlock,
      data: result.data.map((item) => ({
        cursor: item.cursor,
        endCursor: item.endCursor,
        block: item.blocks[0] ?? null,
      })),
    };
  }

  async fetchBlockRangeMany({
    startBlock,
    maxBlock,
    force,
    clampAllowed,
    filters,
  }: FetchBlockRangeManyArgs<Filter>): Promise<
    FetchBlockRangeManyResult<StarknetRpcBlock>
  > {
    const capabilities = await this.getCapabilities();
    const filterSet = this.createFilterSet(filters);
    const plan = filterSet.createFetchPlan();
    const blockMapper = filterSet.createBlockMapper();
    const traceRequirements = filters.map(
      (filter) => new FilterSet().add(filter).createFetchPlan().fetchTraces,
    );
    let endBlock = maxBlock;
    const receiptEveryBlock = filters.some(
      (filter) =>
        (filter.transactions?.length ?? 0) > 0 ||
        (filter.messages?.length ?? 0) > 0,
    );
    const requiresBlockScan = receiptEveryBlock || plan.fetchState;
    const rangeSize = BigInt(this.blockRangeSize());
    if (requiresBlockScan || plan.headerRequirement === "always") {
      endBlock = min(maxBlock, startBlock + rangeSize - 1n);
    } else if (!plan.fetchEvents && endBlock - startBlock >= rangeSize) {
      endBlock = startBlock + rangeSize - 1n;
    }

    let candidates = new Set<bigint>();
    if (plan.fetchEvents) {
      candidates = await this.discoverEventBlocks(
        startBlock,
        endBlock,
        filters,
        capabilities,
        clampAllowed,
      );
      candidateCounter.add(candidates.size);
      rangeHistogram.record(Number(endBlock - startBlock + 1n));
    }
    const eventCandidates = new Set(candidates);
    if (requiresBlockScan || plan.headerRequirement === "always") {
      for (let number = startBlock; number <= endBlock; number++) {
        candidates.add(number);
      }
    }
    if (
      !plan.fetchEvents &&
      !requiresBlockScan &&
      plan.headerRequirement !== "always"
    ) {
      // Header-only on_data filters cannot match anything.
      candidates.clear();
    }
    if (force && candidates.size === 0) candidates.add(endBlock);

    const data: FetchBlockRangeManyResult<StarknetRpcBlock>["data"] = [];
    const orderedCandidates = [...candidates].sort(compareBigInt);
    for (
      let offset = 0;
      offset < orderedCandidates.length;
      offset += this.blockRangeSize()
    ) {
      const window = orderedCandidates.slice(
        offset,
        offset + this.blockRangeSize(),
      );
      const receiptNumbers = new Set(
        window.filter(
          (number) => receiptEveryBlock || eventCandidates.has(number),
        ),
      );
      await this.prefetchWindow(window, receiptNumbers, plan, capabilities);
      const values = await Promise.all(
        window.map((number) =>
          this.loadAndProjectBlock(
            number,
            plan,
            blockMapper,
            traceRequirements,
            capabilities,
            receiptNumbers.has(number),
          ),
        ),
      );
      for (const value of values) {
        const hash = value.header.blockHash;
        if (!hash) {
          throw new Error("Accepted block is missing block_hash");
        }
        const number = value.header.blockNumber;
        data.push({
          cursor:
            number === 0n
              ? undefined
              : {
                  orderKey: number - 1n,
                  uniqueKey: value.header.parentBlockHash,
                },
          endCursor: { orderKey: number, uniqueKey: hash },
          blocks: value.blocks,
        });
      }
    }
    return { startBlock, endBlock, data };
  }

  async fetchHeaderByHash({
    blockHash,
  }: FetchBlockByHashArgs<Filter>): Promise<
    FetchBlockByHashResult<StarknetRpcBlock>
  > {
    const result = await this.fetchHeaderByHashMany({
      blockHash,
      filters: [{ header: "always" }],
    });
    return {
      blockInfo: result.blockInfo,
      data: {
        cursor: result.data.cursor,
        endCursor: result.data.endCursor,
        block: result.data.blocks[0] ?? null,
      },
    };
  }

  async fetchHeaderByHashMany({
    blockHash,
    filters,
  }: FetchHeaderByHashManyArgs<Filter>): Promise<
    FetchHeaderByHashManyResult<StarknetRpcBlock>
  > {
    const raw = await this.request<RpcBlock>("starknet_getBlockWithTxHashes", [
      { block_hash: blockHash },
    ]);
    const blockInfo = this.rememberBlock(raw);
    const header = this.rpcMapper.mapHeader(raw);
    const empty = emptyBlock(header);
    return {
      blockInfo,
      data: {
        cursor:
          blockInfo.blockNumber === 0n
            ? undefined
            : {
                orderKey: blockInfo.blockNumber - 1n,
                uniqueKey: blockInfo.parentBlockHash,
              },
        endCursor: {
          orderKey: blockInfo.blockNumber,
          uniqueKey: blockInfo.blockHash,
        },
        blocks: filters.map((filter) =>
          filter.header === "always" ||
          filter.header === "on_data_or_on_new_block"
            ? empty
            : null,
        ),
      },
    };
  }

  async fetchPendingBlocks(filters: readonly Filter[]): Promise<{
    revision: string;
    blocks: (StarknetRpcBlock | null)[];
    endCursor: { orderKey: bigint; uniqueKey?: Bytes };
  } | null> {
    if (this.pendingLoaded && this.websocketSignal) {
      await this.websocketSignal.wait("pending", this.headRefreshIntervalMs());
      await sleep(this.pendingRefreshIntervalMs());
    }
    let raw: RpcBlockWithReceipts;
    let rawState: RpcStateUpdate | undefined;
    try {
      raw = await this.request<RpcBlockWithReceipts>(
        "starknet_getBlockWithReceipts",
        ["pre_confirmed", []],
      );
    } catch (error) {
      if (isBlockNotFound(error)) return null;
      throw error;
    }
    const filterSet = this.createFilterSet(filters);
    const plan = filterSet.createFetchPlan();
    if (plan.fetchState) {
      rawState = await this.request<RpcStateUpdate>("starknet_getStateUpdate", [
        "pre_confirmed",
      ]);
      // The pre-confirmed block may change between the receipt and state calls.
      // Confirm the identity once and retry on the next notification if it did.
      const confirmation = await this.request<RpcBlockWithReceipts>(
        "starknet_getBlockWithReceipts",
        ["pre_confirmed", []],
      );
      if (pendingIdentity(raw) !== pendingIdentity(confirmation)) {
        raw = confirmation;
        rawState = await this.request<RpcStateUpdate>(
          "starknet_getStateUpdate",
          ["pre_confirmed"],
        );
      }
    }
    if (typeof raw.block_number !== "number") {
      const accepted = await this.fetchCursor({ blockTag: "latest" });
      if (!accepted) throw new Error("Cannot number pre-confirmed block");
      raw = { ...raw, block_number: Number(accepted.blockNumber + 1n) };
    }
    const receipt = this.rpcMapper.mapReceiptBlock(raw);
    const state = rawState
      ? this.rpcMapper.mapStateUpdate(rawState)
      : emptyState();
    const block: StarknetRpcBlock = {
      ...receipt,
      traces: [],
      ...state,
    };
    // A pre-confirmed block only exists at the chain tip.
    const mapped = filterSet.createBlockMapper().map(block, "live");
    this.pendingLoaded = true;
    const number =
      typeof raw.block_number === "number"
        ? BigInt(raw.block_number)
        : (await this.fetchCursor({ blockTag: "latest" }))!.blockNumber + 1n;
    return {
      revision: JSON.stringify([raw, rawState]),
      blocks: filters.map((filter, index) => {
        const projected = mapped[index];
        return (
          projected ??
          (filter.header === "on_data_or_on_new_block"
            ? emptyBlock(block.header)
            : null)
        );
      }),
      endCursor: { orderKey: number },
    };
  }

  private async loadAndProjectBlock(
    number: bigint,
    plan: FetchPlan,
    blockMapper: BlockMapper,
    traceRequirements: readonly boolean[],
    capabilities: StarknetCapabilities,
    receiptRequired: boolean,
  ): Promise<{
    header: StarknetRpcBlock["header"];
    blocks: (StarknetRpcBlock | null)[];
  }> {
    let base: StarknetRpcBlock;
    if (receiptRequired) {
      const raw = await this.loadReceiptBlock(number);
      const transformed = this.rpcMapper.mapReceiptBlock(raw);
      base = {
        ...transformed,
        traces: [],
        ...emptyState(),
      };
    } else {
      const header = this.rpcMapper.mapHeader(await this.loadHeader(number));
      base = emptyBlock(header);
    }
    if (plan.fetchState) {
      const state = this.rpcMapper.mapStateUpdate(
        await this.loadStateUpdate(
          number,
          capabilities.rpc.stateAddressFiltering ? plan.stateAddresses : [],
        ),
      );
      base = { ...base, ...state };
    }
    const production = this.blockProduction(number);
    let blocks = blockMapper.map(base, production);
    if (
      plan.fetchTraces &&
      blocks.some((block, index) => traceRequirements[index] && block !== null)
    ) {
      const rawTraces = await this.request<unknown[]>(
        "starknet_traceBlockTransactions",
        [{ block_number: Number(number) }],
      );
      traceCounter.add(1);
      base = {
        ...base,
        traces: this.rpcMapper.mapTraces(
          rawTraces,
          base.transactions,
          base.events,
          base.messages,
        ),
      };
      blocks = blockMapper.map(base, production);
    }
    return {
      header: base.header,
      blocks: [...blocks],
    };
  }

  /**
   * Finds blocks with matching events across the complete requested interval.
   *
   * `starknet_getEvents` bounds work using result pages and continuation
   * tokens. Juno and Pathfinder also surface their internal scan limits as
   * continuation tokens, so this exhausts the token chain instead of guessing
   * provider-specific block limits from error messages.
   */
  private async discoverEventBlocks(
    start: bigint,
    end: bigint,
    filters: readonly Filter[],
    capabilities: StarknetCapabilities,
    acceptedRange: boolean,
  ): Promise<Set<bigint>> {
    const eventFilters = filters.flatMap((filter) => filter.events ?? []);
    if (eventFilters.length === 0) return new Set();
    const shouldMerge =
      capabilities.rpc.multiAddressEvents &&
      ((this.options.mergeEventFilters ?? "accepted") === "always" ||
        ((this.options.mergeEventFilters ?? "accepted") === "accepted" &&
          !acceptedRange));
    const addresses = [
      ...new Set(
        eventFilters.map((filter) =>
          filter.address ? normalizeFelt(filter.address) : undefined,
        ),
      ),
    ];
    const definedAddresses = addresses.filter(
      (address): address is `0x${string}` => address !== undefined,
    );
    const hasWildcard = addresses.includes(undefined);
    const groups: (string | undefined)[][] = hasWildcard
      ? [[undefined]]
      : shouldMerge
        ? [definedAddresses]
        : addresses.map((address) => [address]);
    const blocks = new Set<bigint>();
    for (const group of groups) {
      const rangeSize = this.options.eventRangeSize;
      for (
        let rangeStart = start;
        rangeStart <= end;
        rangeStart = rangeSize === undefined ? end + 1n : rangeStart + rangeSize
      ) {
        const rangeEnd =
          rangeSize === undefined ? end : min(end, rangeStart + rangeSize - 1n);
        let token: string | undefined;
        do {
          const query: Record<string, unknown> = {
            from_block: { block_number: Number(rangeStart) },
            to_block: { block_number: Number(rangeEnd) },
            chunk_size: this.eventPageSize(),
            continuation_token: token,
          };
          const defined = group.filter(
            (address): address is string => address !== undefined,
          );
          if (defined.length === 1) query.address = defined[0];
          if (defined.length > 1) query.address = defined;
          const page = await this.request<RpcEventPage>("starknet_getEvents", [
            query,
          ]);
          pageCounter.add(1);
          for (const event of page.events) {
            const number = event.block_number;
            if (typeof number === "number") blocks.add(BigInt(number));
          }
          token = page.continuation_token;
        } while (token);
      }
    }
    return blocks;
  }

  private async loadHeader(number: bigint): Promise<RpcBlock> {
    const cached = this.headerCache.get(number);
    if (cached) {
      this.touchCacheBlock(number);
      cacheCounter.add(1, { resource: "header" });
      return cached;
    }
    const raw = await this.request<RpcBlock>("starknet_getBlockWithTxHashes", [
      { block_number: Number(number) },
    ]);
    this.rememberBlock(raw);
    return raw;
  }

  private async prefetchWindow(
    numbers: bigint[],
    receiptNumbers: ReadonlySet<bigint>,
    plan: FetchPlan,
    capabilities: StarknetCapabilities,
  ): Promise<void> {
    if (!this.client.batchEnabled || numbers.length === 0) return;
    const calls: {
      method: string;
      params: unknown[];
      resource: "header" | "receipt" | "state";
      number: bigint;
      stateAddressKey?: string;
    }[] = [];
    for (const number of numbers) {
      if (receiptNumbers.has(number)) {
        if (!this.receiptCache.has(number)) {
          calls.push({
            method: "starknet_getBlockWithReceipts",
            params: [{ block_number: Number(number) }],
            resource: "receipt",
            number,
          });
        }
      } else if (!this.headerCache.has(number)) {
        calls.push({
          method: "starknet_getBlockWithTxHashes",
          params: [{ block_number: Number(number) }],
          resource: "header",
          number,
        });
      }
      const stateAddresses = capabilities.rpc.stateAddressFiltering
        ? plan.stateAddresses
        : [];
      const stateAddressKey = stateUpdateAddressKey(stateAddresses);
      if (
        plan.fetchState &&
        this.stateCache.get(number)?.addressKey !== stateAddressKey
      ) {
        const params: unknown[] = [{ block_number: Number(number) }];
        if (stateAddresses.length > 0) {
          params.push({ contract_addresses: stateAddresses });
        }
        calls.push({
          method: "starknet_getStateUpdate",
          params,
          resource: "state",
          number,
          stateAddressKey,
        });
      }
    }
    if (calls.length === 0) return;
    const responses = await this.client.batch<unknown[]>(
      calls.map(({ method, params }) => ({ method, params })),
    );
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const response = responses[index];
      if (call.resource === "state") {
        this.stateCache.set(call.number, {
          addressKey: call.stateAddressKey!,
          update: response as RpcStateUpdate,
        });
        this.touchCacheBlock(call.number);
        stateCounter.add(1);
      } else if (call.resource === "receipt") {
        const block = response as RpcBlockWithReceipts;
        this.rememberBlock(block);
        this.receiptCache.set(call.number, block);
        this.touchCacheBlock(call.number);
        fullBlockCounter.add(1);
      } else {
        this.rememberBlock(response as RpcBlock);
      }
    }
  }

  private async loadReceiptBlock(
    number: bigint,
  ): Promise<RpcBlockWithReceipts> {
    const cached = this.receiptCache.get(number);
    if (cached) {
      this.touchCacheBlock(number);
      cacheCounter.add(1, { resource: "receipt_block" });
      return cached;
    }
    const raw = await this.request<RpcBlockWithReceipts>(
      "starknet_getBlockWithReceipts",
      [{ block_number: Number(number) }],
    );
    fullBlockCounter.add(1);
    this.rememberBlock(raw);
    this.receiptCache.set(number, raw);
    this.touchCacheBlock(number);
    return raw;
  }

  private async loadStateUpdate(
    number: bigint,
    addresses: readonly string[],
  ): Promise<RpcStateUpdate> {
    const addressKey = stateUpdateAddressKey(addresses);
    const cached = this.stateCache.get(number);
    if (cached?.addressKey === addressKey) {
      this.touchCacheBlock(number);
      cacheCounter.add(1, { resource: "state_update" });
      return cached.update;
    }
    const params: unknown[] = [{ block_number: Number(number) }];
    if (addresses.length > 0) {
      params.push({ contract_addresses: addresses });
    }
    const raw = await this.request<RpcStateUpdate>(
      "starknet_getStateUpdate",
      params,
    );
    stateCounter.add(1);
    this.stateCache.set(number, { addressKey, update: raw });
    this.touchCacheBlock(number);
    return raw;
  }

  /**
   * A block is produced live when it is the chain tip the driver last observed.
   * Anything below that is history the stream is still catching up on, whether
   * it comes from the finalized backfill or from the non-finalized backlog.
   *
   * Without a known head — no `latest` cursor has been fetched yet — treat the
   * block as backfilled: that is what every header policy except
   * `on_data_or_on_new_block` produces anyway.
   */
  private blockProduction(number: bigint): BlockProduction {
    return this.latestBlockNumber !== undefined &&
      number >= this.latestBlockNumber
      ? "live"
      : "backfill";
  }

  private rememberBlock(block: RpcBlock): BlockInfo {
    if (
      typeof block.block_number !== "number" ||
      typeof block.block_hash !== "string"
    ) {
      throw new Error("Canonical Starknet block is missing number or hash");
    }
    const number = BigInt(block.block_number);
    const existing = this.headerCache.get(number);
    if (existing?.block_hash && existing.block_hash !== block.block_hash) {
      this.invalidateFrom(number);
    }
    this.headerCache.set(number, block);
    this.touchCacheBlock(number);
    const blockHash = normalizedHash(block.block_hash);
    const parentBlockHash = normalizedHash(block.parent_hash);
    return {
      blockNumber: number,
      blockHash,
      parentBlockHash,
    };
  }

  private invalidateFrom(number: bigint): void {
    for (const key of this.cacheOrder.keys()) {
      if (key >= number) this.deleteCachedBlock(key);
    }
  }

  private touchCacheBlock(number: bigint): void {
    this.cacheOrder.delete(number);
    this.cacheOrder.set(number, true);
    while (this.cacheOrder.size > this.cacheSize()) {
      const oldest = this.cacheOrder.keys().next().value;
      if (oldest === undefined) break;
      this.deleteCachedBlock(oldest);
    }
  }

  private deleteCachedBlock(number: bigint): void {
    this.cacheOrder.delete(number);
    this.headerCache.delete(number);
    this.receiptCache.delete(number);
    this.stateCache.delete(number);
  }

  private async getCapabilities(): Promise<StarknetCapabilities> {
    if (this.capabilities) return this.capabilities;
    this.capabilitiesPromise ??= this.probeCapabilities().catch((error) => {
      this.capabilitiesPromise = undefined;
      throw error;
    });
    this.capabilities = await this.capabilitiesPromise;
    return this.capabilities;
  }

  private probeCapabilities(): Promise<StarknetCapabilities> {
    const probeOptions = {
      timeout: this.timeout(),
      retryCount: this.options.retryCount,
      retryDelay: this.options.retryDelay,
      fetch: this.options.fetch,
      headers: this.options.headers,
    };
    return Promise.all([
      StarknetRpcCapabilities.probe(this.options.url, probeOptions),
      StarknetEndpointCapabilities.probe(
        this.options.url,
        this.options.wsUrl,
        probeOptions,
      ),
    ]).then(([rpc, endpoint]) => ({ rpc, endpoint }));
  }

  private createClient(batch: boolean): StarknetJsonRpcClient {
    return new StarknetJsonRpcClient(this.options.url, {
      requestsPerSecond: this.options.requestsPerSecond ?? 10,
      maxConcurrency: this.options.maxConcurrency ?? 8,
      timeout: this.timeout(),
      retryCount: this.options.retryCount,
      retryDelay: this.options.retryDelay,
      batch,
      fetch: this.options.fetch,
      headers: this.options.headers,
    });
  }

  private timeout(): number {
    return this.options.timeout ?? 10_000;
  }

  private cacheSize(): number {
    return this.options.cacheSize ?? DEFAULT_CACHE_SIZE;
  }

  private blockRangeSize(): number {
    return this.options.blockRangeSize ?? DEFAULT_BLOCK_RANGE_SIZE;
  }

  private eventPageSize(): number {
    return this.options.eventPageSize ?? DEFAULT_EVENT_PAGE_SIZE;
  }

  private async request<T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (error) {
      if (error instanceof StarknetRpcError && error.code === -32601) {
        throw new StarknetRpcCapabilityError(
          method,
          "the endpoint returned JSON-RPC method not found",
        );
      }
      throw error;
    }
  }

  /** Close the internally owned WebSocket and release pending waiters. */
  close(): void {
    this.websocketSignal?.close();
    this.websocketSignal = undefined;
    this.pendingLoaded = false;
  }

  private createFilterSet(filters: readonly Filter[]): FilterSet {
    const filterSet = new FilterSet();
    for (const filter of filters) filterSet.add(filter);
    return filterSet;
  }
}

function cursorArgsToBlockId(args: FetchCursorArgs): RpcObject | string {
  if (args.blockNumber !== undefined) {
    return { block_number: Number(args.blockNumber) };
  }
  if (args.blockHash !== undefined) return { block_hash: args.blockHash };
  // Starknet JSON-RPC encodes block tags as bare strings, not as an object.
  // `{ block_tag: "latest" }` is rejected by nodes with -32602 Invalid params.
  if (args.blockTag === "latest") return "latest";
  if (args.blockTag === "finalized") return "l1_accepted";
  throw new Error("Missing Starknet block identifier");
}

function emptyBlock(header: StarknetRpcBlock["header"]): StarknetRpcBlock {
  return {
    header,
    transactions: [],
    receipts: [],
    events: [],
    messages: [],
    traces: [],
    ...emptyState(),
  };
}

function emptyState(): Pick<
  StarknetRpcBlock,
  "storageDiffs" | "contractChanges" | "nonceUpdates"
> {
  return { storageDiffs: [], contractChanges: [], nonceUpdates: [] };
}

function isBlockNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("block not found") ||
    message.includes("no blocks") ||
    message.includes("block_not_found")
  );
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stateUpdateAddressKey(addresses: readonly string[]): string {
  // Address order is not semantic, while an empty list identifies a full diff.
  return JSON.stringify([...addresses].sort());
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function validatePositiveInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validateNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function normalizedHash(value: string): Bytes {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Invalid Starknet block hash");
  }
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function pendingIdentity(block: RpcBlockWithReceipts): string {
  return JSON.stringify([
    block.parent_hash,
    block.block_number,
    block.timestamp,
    block.new_root,
    block.transactions.map((pair) => pair.receipt.transaction_hash),
  ]);
}
