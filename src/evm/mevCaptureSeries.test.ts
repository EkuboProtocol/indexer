import { describe, expect, test } from "bun:test";
import {
  baseFeeOnInput,
  liquidityAt,
  mevCaptureAdditionalFee,
  MevCapturePoolTracker,
  surchargeExactIn,
  surchargeExactOut,
  timeWeightedLiquidity,
  type MevCapturePoolEvent,
} from "./mevCaptureSeries";

const ONE = 1n << 64n;
// 0.02%, the Ethereum ETH/USDT MEVCapture pool's fee
const FEE = 3689348814741910n;
const POOL = { poolId: "0x01" as const, fee: FEE, tickSpacing: 100 };

let logIndex = 0;
function at(blockNumber: number) {
  return {
    blockNumber,
    transactionIndex: 0,
    logIndex: logIndex++,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as `0x${string}`,
  };
}

function swap(blockNumber: number, delta0: bigint, delta1: bigint, tickAfter: number, liquidityAfter = 1000n): MevCapturePoolEvent {
  return { ...at(blockNumber), kind: "swap", locker: "0x00", delta0, delta1, tickAfter, liquidityAfter, sqrtRatioAfter: 0n };
}

function donation(blockNumber: number, amount0: bigint, amount1: bigint): MevCapturePoolEvent {
  return { ...at(blockNumber), kind: "fees_accumulated", amount0, amount1 };
}

describe("mevCaptureAdditionalFee", () => {
  test("is zero when the tick has not moved a full spacing's worth", () => {
    expect(mevCaptureAdditionalFee(0, 0, 100, FEE)).toBe(0n);
  });

  test("scales the pool fee by tick spacings moved, in either direction", () => {
    expect(mevCaptureAdditionalFee(200, 0, 100, FEE)).toBe(2n * FEE);
    expect(mevCaptureAdditionalFee(-50, 0, 100, FEE)).toBe(FEE / 2n);
  });

  test("caps at uint64", () => {
    expect(mevCaptureAdditionalFee(88_000_000, -88_000_000, 1, FEE)).toBe(ONE - 1n);
  });
});

describe("fee attribution", () => {
  test("base fee is charged on the input token, rounded up", () => {
    expect(baseFeeOnInput(10_000n, -5n, ONE / 100n)).toEqual([100n, 0n]);
    expect(baseFeeOnInput(-5n, 10_001n, ONE / 100n)).toEqual([0n, 101n]);
  });

  test("exact-in surcharge comes out of the output token", () => {
    expect(surchargeExactIn(10_000n, -9_000n, ONE / 100n)).toEqual([0n, 90n]);
    expect(surchargeExactIn(10_000n, -9_000n, 0n)).toEqual([0n, 0n]);
  });

  test("exact-out surcharge grosses up the net input", () => {
    // input 10_100 incl. a 1% pool fee of 101 -> net 9_999; 1% on top -> 101
    expect(surchargeExactOut(10_100n, -9_000n, ONE / 100n, ONE / 100n)).toEqual([101n, 0n]);
  });
});

describe("MevCapturePoolTracker", () => {
  test("uses the tick at the block's first touch for every swap in the block", () => {
    const t = new MevCapturePoolTracker(POOL, { tick: 0, liquidity: 1000n });
    t.apply(swap(10, 1_000_000n, -1_000_000n, 100));
    t.apply(swap(10, 1_000_000n, -1_000_000n, 300));
    expect(t.swaps.map((s) => [s.tickLast, s.tickBefore, s.isFirstTouch])).toEqual([
      [0, 0, true],
      [0, 100, false],
    ]);
    expect(t.swaps[1]!.additionalFee).toBe(3n * FEE);
    t.apply(swap(11, 1_000_000n, -1_000_000n, 350));
    expect(t.swaps[2]!.tickLast).toBe(300);
    expect(t.blocks.get(10)!.firstTouch.logIndex).toBe(t.swaps[0]!.logIndex);
  });

  test("attributes a donation to the latest earlier swapping block", () => {
    const t = new MevCapturePoolTracker(POOL, { tick: 0, liquidity: 1000n });
    t.apply(donation(9, 5n, 0n)); // accrued before the replay started
    t.apply(swap(10, 1_000_000n, -1_000_000n, 200));
    t.apply(donation(14, 0n, 400n));
    t.apply(swap(14, -10n, 10n, 150));
    expect(t.carryInDonations.map((d) => d.blockNumber)).toEqual([9]);
    const b = t.blocks.get(10)!;
    expect([b.surcharge0, b.surcharge1, b.donationBlockNumber]).toEqual([0n, 400n, 14]);
    expect(t.blocks.get(14)!.surcharge1).toBeNull();
  });

  test("records liquidity changes from swaps and position updates", () => {
    const t = new MevCapturePoolTracker(POOL, { tick: 0, liquidity: 1000n });
    t.apply(swap(10, 1n, -1n, 0, 1000n));
    t.apply({ ...at(11), kind: "position", liquidityDelta: 500n, tickAfter: 0, liquidityAfter: 1500n });
    t.apply(swap(12, 1n, -1n, 200, 700n));
    expect(t.liquidityPoints).toEqual([
      { blockNumber: 11, liquidity: 1500n },
      { blockNumber: 12, liquidity: 700n },
    ]);
    expect(t.swaps[1]!.liquidityBefore).toBe(1500n);
  });
});

describe("time-weighted liquidity", () => {
  const points = [
    { timestamp: 110, liquidity: 300n },
    { timestamp: 150, liquidity: 0n },
  ];

  test("weights each value by how long it was in force", () => {
    // 100 for 10s, 300 for 40s, 0 for 50s
    expect(timeWeightedLiquidity(100n, points, 100, 200)).toBe((100n * 10n + 300n * 40n) / 100n);
    expect(timeWeightedLiquidity(100n, points, 120, 140)).toBe(300n);
  });

  test("liquidityAt applies a change from its own timestamp", () => {
    expect(liquidityAt(100n, points, 109)).toBe(100n);
    expect(liquidityAt(100n, points, 110)).toBe(300n);
  });
});
