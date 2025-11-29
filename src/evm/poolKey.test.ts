import { describe, expect, it } from "bun:test";
import { checksumAddress } from "viem";
import {
  parseOrderConfig,
  parsePoolBalanceUpdate,
  parsePositionId,
  parseV2PoolKeyConfig,
} from "./poolKey";

function toHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function encodeConcentratedPoolConfig({
  extension,
  fee,
  tickSpacing,
}: {
  extension: `0x${string}`;
  fee: bigint;
  tickSpacing: number;
}) {
  const extensionBig = BigInt(extension);
  const feeMasked = BigInt.asUintN(64, fee);
  const spacingMasked = BigInt(tickSpacing & 0x7fffffff);
  return (
    (extensionBig << 96n) +
    (feeMasked << 32n) +
    spacingMasked +
    (1n << 31n)
  );
}

function encodeStableswapPoolConfig({
  extension,
  fee,
  amplification,
  centerTick,
}: {
  extension: `0x${string}`;
  fee: bigint;
  amplification: number;
  centerTick: number;
}) {
  const extensionBig = BigInt(extension);
  const feeMasked = BigInt.asUintN(64, fee);
  const amplificationMasked = BigInt(amplification & 0x7f);
  const centerTickCompressed = BigInt(centerTick) / 16n;
  const centerTickEncoded = BigInt.asUintN(24, centerTickCompressed);
  const typeConfig = (amplificationMasked << 24n) | centerTickEncoded;
  return (extensionBig << 96n) + (feeMasked << 32n) + typeConfig;
}

describe("parseV2PoolKeyConfig", () => {
  const concentratedCases = [
    {
      extension: "0x0000000000000000000000000000000000000000",
      fee: 0n,
      tickSpacing: 1,
    },
    {
      extension: "0x9995855c00494d039ab6792f18e368e530dff931",
      fee: 123n,
      tickSpacing: 60,
    },
    {
      extension: "0x1111111111111111111111111111111111111111",
      fee: (1n << 64n) - 1n,
      tickSpacing: 0x7fffffff,
    },
    {
      extension: "0xffffffffffffffffffffffffffffffffffffffff",
      fee: 42n,
      tickSpacing: 5000,
    },
    {
      extension: "0x85cdb1e5cf646550e25c4d587ef02bcf5a2b7d27",
      fee: 987654321n,
      tickSpacing: 12,
    },
  ] as const;

  concentratedCases.forEach(({ extension, fee, tickSpacing }, idx) => {
    it(`decodes concentrated config #${idx + 1}`, () => {
      const word = encodeConcentratedPoolConfig({
        extension,
        fee,
        tickSpacing,
      });
      const parsed = parseV2PoolKeyConfig(toHex(word));

      expect(parsed).toEqual({
        fee: BigInt.asUintN(64, fee),
        tickSpacing: tickSpacing & 0x7fffffff,
        extension: checksumAddress(extension),
      });
    });
  });

  const stableswapCases = [
    {
      extension: "0x0000000000000000000000000000000000000000",
      fee: 0n,
      amplification: 0,
      centerTick: 0,
    },
    {
      extension: "0x9995855c00494d039ab6792f18e368e530dff931",
      fee: 555n,
      amplification: 1,
      centerTick: -15,
    },
    {
      extension: "0xffffffffffffffffffffffffffffffffffffffff",
      fee: (1n << 64n) - 1n,
      amplification: 26,
      centerTick: 123456,
    },
    {
      extension: "0x85cdb1e5cf646550e25c4d587ef02bcf5a2b7d27",
      fee: 789n,
      amplification: 5,
      centerTick: -887200,
    },
    {
      extension: "0x1111111111111111111111111111111111111111",
      fee: 424242n,
      amplification: 12,
      centerTick: 320,
    },
  ] as const;

  stableswapCases.forEach(
    ({ extension, fee, amplification, centerTick }, idx) => {
      it(`decodes stableswap config #${idx + 1}`, () => {
        const word = encodeStableswapPoolConfig({
          extension,
          fee,
          amplification,
          centerTick,
        });
        const parsed = parseV2PoolKeyConfig(toHex(word));
        const expectedCenterTick =
          Number((BigInt(centerTick) / 16n) * 16n);

        expect(parsed).toEqual({
          fee: BigInt.asUintN(64, fee),
          amplificationFactor: amplification,
          centerTick: expectedCenterTick,
          extension: checksumAddress(extension),
        });
      });
    }
  );
});

describe("parsePoolBalanceUpdate", () => {
  const cases = [
    { delta0: 0n, delta1: 0n },
    { delta0: (1n << 127n) - 1n, delta1: -1n },
    { delta0: -((1n << 80n) + 5n), delta1: (1n << 64n) - 2n },
    { delta0: 12345678901234567890n, delta1: -9876543210987654321n },
  ];

  cases.forEach(({ delta0, delta1 }, idx) => {
    it(`unpacks signed deltas #${idx + 1}`, () => {
      const packed =
        (BigInt.asUintN(128, delta0) << 128n) |
        BigInt.asUintN(128, delta1);
      expect(parsePoolBalanceUpdate(toHex(packed))).toEqual({
        delta0,
        delta1,
      });
    });
  });
});

describe("parsePositionId", () => {
  const cases = [
    {
      salt: 0n,
      lower: -1,
      upper: 1,
    },
    {
      salt: (1n << 192n) - 1n,
      lower: -887272,
      upper: 887272,
    },
    {
      salt: 0x1234567890abcdef1234567890abcdef123456n,
      lower: -120,
      upper: 480,
    },
    {
      salt: 0xffffffffffffffffffffffffffffffffffffffffffffffn,
      lower: 0,
      upper: 1,
    },
  ];

  cases.forEach(({ salt, lower, upper }, idx) => {
    it(`recovers salt and bounds #${idx + 1}`, () => {
      const saltMasked = BigInt.asUintN(192, salt);
      const packed =
        (saltMasked << 64n) |
        (BigInt.asUintN(32, BigInt(lower)) << 32n) |
        BigInt.asUintN(32, BigInt(upper));

      expect(parsePositionId(toHex(packed))).toEqual({
        salt: saltMasked,
        lower,
        upper,
      });
    });
  });
});

describe("parseOrderConfig", () => {
  const cases = [
    {
      fee: 0n,
      isToken1: false,
      salt: 0n,
      startTime: 0n,
      endTime: 0n,
    },
    {
      fee: (1n << 64n) - 1n,
      isToken1: true,
      salt: (1n << 56n) - 1n,
      startTime: (1n << 64n) - 2n,
      endTime: (1n << 64n) - 3n,
    },
    {
      fee: 789n,
      isToken1: true,
      salt: 0x11223344556677n,
      startTime: 1000n,
      endTime: 2000n,
    },
    {
      fee: 4242424242n,
      isToken1: false,
      salt: 0x123456789abcdefn,
      startTime: 555n,
      endTime: 999999n,
    },
    {
      fee: (1n << 70n) - 1n, // exceeds 64 bits -> should be masked
      isToken1: true,
      salt: (1n << 80n) - 1n, // exceeds 56 bits -> should be masked
      startTime: (1n << 80n) - 5n,
      endTime: (1n << 90n) - 7n,
    },
  ];

  cases.forEach(({ fee, isToken1, salt, startTime, endTime }, idx) => {
    it(`decodes TWAMM config fields #${idx + 1}`, () => {
      const feeMasked = BigInt.asUintN(64, fee);
      const saltMasked = BigInt.asUintN(56, salt);
      const startMasked = BigInt.asUintN(64, startTime);
      const endMasked = BigInt.asUintN(64, endTime);
      const word =
        (feeMasked << 192n) |
        (BigInt(isToken1 ? 1 : 0) << 184n) |
        (saltMasked << 128n) |
        (startMasked << 64n) |
        endMasked;

      expect(parseOrderConfig(toHex(word))).toEqual({
        fee: feeMasked,
        isToken1,
        salt: saltMasked,
        startTime: startMasked,
        endTime: endMasked,
      });
    });
  });
});
