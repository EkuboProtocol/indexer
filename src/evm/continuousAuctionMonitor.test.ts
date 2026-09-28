import { describe, expect, it } from "bun:test";
import {
  createPositionId,
  exitCodeFor,
  findFirstBlockAtOrAfter,
} from "./continuousAuctionMonitor";

function chain(times: number[]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    getTime: async (block: bigint) => {
      reads++;
      const time = times[Number(block)];
      if (time === undefined) throw new Error(`no block ${block}`);
      return BigInt(time);
    },
  };
}

describe("findFirstBlockAtOrAfter", () => {
  it("finds the next block on a 12 second chain", async () => {
    // block n at 12n; a bid placed in block 3 (t=36) starts at 37
    const c = chain(Array.from({ length: 11 }, (_, n) => n * 12));
    expect(await findFirstBlockAtOrAfter(c.getTime, 3n, 10n, 37n)).toEqual({
      number: 4n,
      time: 48n,
    });
  });

  it("skips blocks that share a second on a fast chain", async () => {
    // ten blocks per second
    const c = chain(Array.from({ length: 1001 }, (_, n) => Math.floor(n / 10)));
    expect(await findFirstBlockAtOrAfter(c.getTime, 42n, 1000n, 5n)).toEqual({
      number: 50n,
      time: 5n,
    });
    expect(c.reads).toBeLessThan(20);
  });

  it("returns null until the chain reaches the target", async () => {
    const c = chain([0, 12, 24]);
    expect(await findFirstBlockAtOrAfter(c.getTime, 1n, 2n, 25n)).toBeNull();
    expect(await findFirstBlockAtOrAfter(c.getTime, 2n, 2n, 25n)).toBeNull();
  });

  it("reports a block past the tenure when a slot is missed", async () => {
    // slots 4 and 5 missed: block 4 is at 72
    const c = chain([0, 12, 24, 36, 72, 84]);
    expect(await findFirstBlockAtOrAfter(c.getTime, 3n, 5n, 37n)).toEqual({
      number: 4n,
      time: 72n,
    });
  });
});

describe("createPositionId", () => {
  it("packs the salt and the two's complement bounds", () => {
    expect(createPositionId(9n, -10, 20)).toBe(
      `0x${((9n << 64n) | (0xfffffff6n << 32n) | 20n).toString(16).padStart(64, "0")}`,
    );
  });
});

describe("exitCodeFor", () => {
  it("pages over warns over quiet", () => {
    expect(exitCodeFor([])).toBe(0);
    expect(exitCodeFor([{ severity: "warn" }])).toBe(2);
    expect(exitCodeFor([{ severity: "warn" }, { severity: "page" }])).toBe(3);
  });
});
