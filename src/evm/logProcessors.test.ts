import { describe, expect, it } from "bun:test";
import { normalizeV2PoolKey } from "./logProcessors";

type PoolKey = Parameters<typeof normalizeV2PoolKey>[0];

function basePoolKey(overrides: Partial<PoolKey> = {}): PoolKey {
  return {
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
    fee: 1n,
    tickSpacing: 60,
    extension: "0x0000000000000000000000000000000000000003",
    poolConfig: 0x1234n,
    poolConfigType: "concentrated",
    stableswapCenterTick: null,
    stableswapAmplification: null,
    ...overrides,
  };
}

describe("normalizeV2PoolKey", () => {
  it("keeps concentrated pools with positive tick spacing", () => {
    const normalized = normalizeV2PoolKey(basePoolKey());

    expect(normalized.poolConfigType).toBe("concentrated");
    expect(normalized.tickSpacing).toBe(60);
    expect(normalized.stableswapCenterTick).toBeNull();
    expect(normalized.stableswapAmplification).toBeNull();
  });

  it("converts zero tick spacing pools into stableswap metadata", () => {
    const existingConfig = 0xabcdefn;
    const normalized = normalizeV2PoolKey(
      basePoolKey({ tickSpacing: 0, poolConfig: existingConfig })
    );

    expect(normalized.poolConfigType).toBe("stableswap");
    expect(normalized.tickSpacing).toBeNull();
    expect(normalized.stableswapCenterTick).toBe(0);
    expect(normalized.stableswapAmplification).toBe(0);
    expect(normalized.poolConfig).toBe(existingConfig);
  });

  it("throws when zero tick spacing pools omit pool_config", () => {
    expect(() =>
      normalizeV2PoolKey(basePoolKey({ tickSpacing: 0, poolConfig: null }))
    ).toThrow("pool_config must be present");
  });
});
