import { describe, expect, it } from "bun:test";
import { normalizeV2PoolKey } from "./logProcessors";

describe("normalizeV1PoolKey", () => {
  it("keeps concentrated pools when tick spacing is positive", () => {
    const poolKey = normalizeV2PoolKey({
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      fee: 1n,
      tickSpacing: 60,
      extension: "0x0000000000000000000000000000000000000003",
      poolConfig: 0x1234n,
    });

    expect(poolKey.poolConfigType).toBe("concentrated");
    expect(poolKey.tickSpacing).toBe(60);
    expect(poolKey.stableswapCenterTick).toBeNull();
    expect(poolKey.stableswapAmplification).toBeNull();
  });

  it("reinterprets zero tick spacing pools as stableswap", () => {
    const poolConfig = 0x5678n;
    const poolKey = normalizeV2PoolKey({
      token0: "0x0000000000000000000000000000000000000001",
      token1: "0x0000000000000000000000000000000000000002",
      fee: 1n,
      tickSpacing: 0,
      extension: "0x0000000000000000000000000000000000000003",
      poolConfig,
    });

    expect(poolKey.poolConfigType).toBe("stableswap");
    expect(poolKey.tickSpacing).toBeNull();
    expect(poolKey.stableswapCenterTick).toBe(0);
    expect(poolKey.stableswapAmplification).toBe(0);
    expect(poolKey.poolConfig).toBe(poolConfig);
  });
});
