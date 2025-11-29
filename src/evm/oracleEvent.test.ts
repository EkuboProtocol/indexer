import { describe, expect, it } from "bun:test";
import { checksumAddress } from "viem";
import { parseOracleEvent } from "./oracleEvent";

function createSnapshot({
  timestamp,
  secondsPerLiquidityCumulative,
  tickCumulative,
}: {
  timestamp: bigint;
  secondsPerLiquidityCumulative: bigint;
  tickCumulative: bigint;
}) {
  const ts = BigInt.asUintN(32, timestamp);
  const spl = BigInt.asUintN(160, secondsPerLiquidityCumulative) << 32n;
  const tick = BigInt.asUintN(64, tickCumulative) << 192n;
  return tick | spl | ts;
}

describe(parseOracleEvent, () => {
  it("decodes packed oracle snapshots", () => {
    const token = "0x1234567890abcdef1234567890abcdef12345678" as const;
    const timestamp = 1234567890n;
    const secondsPerLiquidityCumulative = 0x1111222233334444555566667777888899990000n;
    const tickCumulative = -123456789n;

    const snapshot = createSnapshot({
      timestamp,
      secondsPerLiquidityCumulative,
      tickCumulative,
    });

    const data =
      (`0x${token.slice(2).toLowerCase()}${snapshot
        .toString(16)
        .padStart(64, "0")}` as `0x${string}`);

    expect(parseOracleEvent(data)).toEqual({
      token: checksumAddress(token),
      timestamp,
      secondsPerLiquidityCumulative,
      tickCumulative,
    });
  });

  it("throws on malformed payload length", () => {
    expect(() => parseOracleEvent("0x1234" as `0x${string}`)).toThrowErrorMatchingInlineSnapshot(
      `"Unexpected oracle event length: expected 104 hex chars, received 4"`
    );
  });
});
