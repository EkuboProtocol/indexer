import { computeFee, EVM_POOL_FEE_DENOMINATOR } from "./protocolFees";

// Pure accounting for the MEVCapture extension (evm-contracts
// src/extensions/MEVCapture.sol). Core's Swapped event carries the swap before
// the extension's surcharge, so the surcharge has to be read from the
// FeesAccumulated donation the extension makes at the pool's next touch in a
// later timestamp, and can be cross-checked by re-deriving it from ticks.

const MAX_UINT64 = (1n << 64n) - 1n;

export interface MevCapturePoolParams {
  poolId: `0x${string}`;
  fee: bigint;
  tickSpacing: number;
}

export interface EventPosition {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: `0x${string}`;
}

export type MevCapturePoolEvent =
  | (EventPosition & {
      kind: "swap";
      locker: `0x${string}`;
      delta0: bigint;
      delta1: bigint;
      tickAfter: number;
      liquidityAfter: bigint;
      sqrtRatioAfter: bigint;
    })
  | (EventPosition & {
      kind: "position";
      liquidityDelta: bigint;
      tickAfter: number;
      liquidityAfter: bigint;
    })
  | (EventPosition & { kind: "fees_accumulated"; amount0: bigint; amount1: bigint });

export type SwapEvent = Extract<MevCapturePoolEvent, { kind: "swap" }>;

// MEVCapture.handleForwardData: the multiplier is the number of tick spacings
// moved since the first touch in this timestamp, capped at uint64.
export function mevCaptureAdditionalFee(
  tickAfter: number,
  tickLast: number,
  tickSpacing: number,
  poolFee: bigint,
): bigint {
  const moved = BigInt(Math.abs(tickAfter - tickLast));
  const multiplierX64 = (moved << 64n) / BigInt(tickSpacing);
  const fee = (multiplierX64 * poolFee) >> 64n;
  return fee > MAX_UINT64 ? MAX_UINT64 : fee;
}

function inputSide(delta0: bigint, delta1: bigint): 0 | 1 | null {
  if (delta0 > 0n) return 0;
  if (delta1 > 0n) return 1;
  return null;
}

// The contractual pool fee, taken by Core on the input amount.
export function baseFeeOnInput(
  delta0: bigint,
  delta1: bigint,
  poolFee: bigint,
): [bigint, bigint] {
  const side = inputSide(delta0, delta1);
  if (side === 0) return [computeFee(delta0, poolFee), 0n];
  if (side === 1) return [0n, computeFee(delta1, poolFee)];
  return [0n, 0n];
}

// Exact-input swaps pay the surcharge out of their output token.
export function surchargeExactIn(
  delta0: bigint,
  delta1: bigint,
  additionalFee: bigint,
): [bigint, bigint] {
  if (additionalFee === 0n) return [0n, 0n];
  if (delta0 < 0n) return [computeFee(-delta0, additionalFee), 0n];
  if (delta1 < 0n) return [0n, computeFee(-delta1, additionalFee)];
  return [0n, 0n];
}

function amountBeforeFee(afterFee: bigint, fee: bigint): bigint {
  const v = afterFee << 64n;
  const d = EVM_POOL_FEE_DENOMINATOR - fee;
  return v / d + (v % d === 0n ? 0n : 1n);
}

// Exact-output swaps pay the surcharge on top of their input token.
export function surchargeExactOut(
  delta0: bigint,
  delta1: bigint,
  poolFee: bigint,
  additionalFee: bigint,
): [bigint, bigint] {
  if (additionalFee === 0n) return [0n, 0n];
  const side = inputSide(delta0, delta1);
  if (side === null) return [0n, 0n];
  const input = side === 0 ? delta0 : delta1;
  const net = input - computeFee(input, poolFee);
  const fee = amountBeforeFee(net, additionalFee) - net;
  return side === 0 ? [fee, 0n] : [0n, fee];
}

export interface SwapRow extends EventPosition {
  poolId: `0x${string}`;
  locker: `0x${string}`;
  delta0: bigint;
  delta1: bigint;
  tickBefore: number;
  tickAfter: number;
  tickLast: number;
  liquidityBefore: bigint;
  liquidityAfter: bigint;
  sqrtRatioAfter: bigint;
  baseFee0: bigint;
  baseFee1: bigint;
  additionalFee: bigint;
  surchargeExactIn0: bigint;
  surchargeExactIn1: bigint;
  isFirstTouch: boolean;
}

export interface BlockRow {
  poolId: `0x${string}`;
  blockNumber: number;
  swaps: number;
  amountIn0: bigint;
  amountIn1: bigint;
  amountOut0: bigint;
  amountOut1: bigint;
  baseFee0: bigint;
  baseFee1: bigint;
  surchargeEstimate0: bigint;
  surchargeEstimate1: bigint;
  // Filled when the donation for this block's accrual is seen.
  surcharge0: bigint | null;
  surcharge1: bigint | null;
  donationBlockNumber: number | null;
  donationTransactionHash: `0x${string}` | null;
  tickLast: number;
  tickAfterLastSwap: number;
  liquidityBeforeFirstSwap: bigint;
  liquidityAfterLastSwap: bigint;
  firstTouch: SwapRow;
}

export interface CarryInDonation extends EventPosition {
  poolId: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
}

export interface LiquidityPoint {
  blockNumber: number;
  liquidity: bigint;
}

export interface InitialPoolState {
  tick: number;
  liquidity: bigint;
}

// Replays one pool's Core events in log order. `initial` is the pool's state
// at the end of the block before the first event passed in.
export class MevCapturePoolTracker {
  readonly swaps: SwapRow[] = [];
  readonly blocks = new Map<number, BlockRow>();
  readonly carryInDonations: CarryInDonation[] = [];
  readonly liquidityPoints: LiquidityPoint[] = [];
  private tick: number;
  private liquidity: bigint;
  private lastSwapBlock: number | null = null;

  constructor(
    readonly pool: MevCapturePoolParams,
    initial: InitialPoolState,
  ) {
    this.tick = initial.tick;
    this.liquidity = initial.liquidity;
  }

  apply(event: MevCapturePoolEvent) {
    if (event.kind === "swap") this.applySwap(event);
    else if (event.kind === "position") this.applyPosition(event);
    else this.applyDonation(event);
  }

  private setLiquidity(blockNumber: number, liquidity: bigint) {
    if (liquidity === this.liquidity) return;
    this.liquidity = liquidity;
    this.liquidityPoints.push({ blockNumber, liquidity });
  }

  private applyPosition(event: Extract<MevCapturePoolEvent, { kind: "position" }>) {
    this.tick = event.tickAfter;
    this.setLiquidity(event.blockNumber, event.liquidityAfter);
  }

  private applyDonation(event: Extract<MevCapturePoolEvent, { kind: "fees_accumulated" }>) {
    // A donation empties what the extension saved at the pool's last swapping
    // timestamp: any touch at a later timestamp donates first, so it can only
    // belong to the most recent earlier block that swapped.
    const target =
      this.lastSwapBlock !== null && this.lastSwapBlock < event.blockNumber
        ? this.blocks.get(this.lastSwapBlock)
        : undefined;
    if (!target || target.surcharge0 !== null) {
      this.carryInDonations.push({ ...event, poolId: this.pool.poolId });
      return;
    }
    target.surcharge0 = event.amount0;
    target.surcharge1 = event.amount1;
    target.donationBlockNumber = event.blockNumber;
    target.donationTransactionHash = event.transactionHash;
  }

  private applySwap(event: SwapEvent) {
    const existing = this.blocks.get(event.blockNumber);
    const tickLast = existing ? existing.tickLast : this.tick;
    const row = this.swapRow(event, tickLast, !existing);
    this.swaps.push(row);
    this.tick = event.tickAfter;
    this.setLiquidity(event.blockNumber, event.liquidityAfter);
    this.lastSwapBlock = event.blockNumber;
    if (existing) addSwapToBlock(existing, row);
    else this.blocks.set(event.blockNumber, newBlockRow(row));
  }

  private swapRow(event: SwapEvent, tickLast: number, isFirstTouch: boolean): SwapRow {
    const { fee, tickSpacing, poolId } = this.pool;
    const [baseFee0, baseFee1] = baseFeeOnInput(event.delta0, event.delta1, fee);
    const additionalFee = mevCaptureAdditionalFee(event.tickAfter, tickLast, tickSpacing, fee);
    const [surchargeExactIn0, surchargeExactIn1] = surchargeExactIn(
      event.delta0,
      event.delta1,
      additionalFee,
    );
    return {
      poolId,
      blockNumber: event.blockNumber,
      transactionIndex: event.transactionIndex,
      logIndex: event.logIndex,
      transactionHash: event.transactionHash,
      locker: event.locker,
      delta0: event.delta0,
      delta1: event.delta1,
      tickBefore: this.tick,
      tickAfter: event.tickAfter,
      tickLast,
      liquidityBefore: this.liquidity,
      liquidityAfter: event.liquidityAfter,
      sqrtRatioAfter: event.sqrtRatioAfter,
      baseFee0,
      baseFee1,
      additionalFee,
      surchargeExactIn0,
      surchargeExactIn1,
      isFirstTouch,
    };
  }
}

function abs(x: bigint) {
  return x < 0n ? -x : x;
}

function newBlockRow(row: SwapRow): BlockRow {
  const block: BlockRow = {
    poolId: row.poolId,
    blockNumber: row.blockNumber,
    swaps: 0,
    amountIn0: 0n,
    amountIn1: 0n,
    amountOut0: 0n,
    amountOut1: 0n,
    baseFee0: 0n,
    baseFee1: 0n,
    surchargeEstimate0: 0n,
    surchargeEstimate1: 0n,
    surcharge0: null,
    surcharge1: null,
    donationBlockNumber: null,
    donationTransactionHash: null,
    tickLast: row.tickLast,
    tickAfterLastSwap: row.tickAfter,
    liquidityBeforeFirstSwap: row.liquidityBefore,
    liquidityAfterLastSwap: row.liquidityAfter,
    firstTouch: row,
  };
  addSwapToBlock(block, row);
  return block;
}

function addSwapToBlock(block: BlockRow, row: SwapRow) {
  block.swaps += 1;
  if (row.delta0 > 0n) block.amountIn0 += row.delta0;
  else block.amountOut0 += abs(row.delta0);
  if (row.delta1 > 0n) block.amountIn1 += row.delta1;
  else block.amountOut1 += abs(row.delta1);
  block.baseFee0 += row.baseFee0;
  block.baseFee1 += row.baseFee1;
  block.surchargeEstimate0 += row.surchargeExactIn0;
  block.surchargeEstimate1 += row.surchargeExactIn1;
  block.tickAfterLastSwap = row.tickAfter;
  block.liquidityAfterLastSwap = row.liquidityAfter;
}

// Liquidity is piecewise constant between events. Points must be sorted and
// carry the timestamp of the block that set them; the value set in a block is
// in force from that block's timestamp.
export function timeWeightedLiquidity(
  initial: bigint,
  points: { timestamp: number; liquidity: bigint }[],
  from: number,
  to: number,
): bigint {
  if (to <= from) throw new Error("empty interval");
  let current = initial;
  let cursor = from;
  let acc = 0n;
  for (const point of points) {
    if (point.timestamp >= to) break;
    if (point.timestamp > cursor) {
      acc += current * BigInt(point.timestamp - cursor);
      cursor = point.timestamp;
    }
    current = point.liquidity;
  }
  acc += current * BigInt(to - cursor);
  return acc / BigInt(to - from);
}

// Liquidity in force at `at`, given the same sorted points.
export function liquidityAt(
  initial: bigint,
  points: { timestamp: number; liquidity: bigint }[],
  at: number,
): bigint {
  let current = initial;
  for (const point of points) {
    if (point.timestamp > at) break;
    current = point.liquidity;
  }
  return current;
}
