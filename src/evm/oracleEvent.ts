import { checksumAddress } from "viem";
import { toSigned } from "./swapEvent";

export interface OracleEvent {
  token: `0x${string}`;
  timestamp: bigint;
  secondsPerLiquidityCumulative: bigint;
  tickCumulative: bigint;
}

const ORACLE_EVENT_LENGTH = 52; // bytes

function sliceHex(
  hex: string,
  startBytes: number,
  lengthBytes: number
): string {
  const start = startBytes * 2;
  return hex.slice(start, start + lengthBytes * 2);
}

export function parseOracleEvent(data: `0x${string}`): OracleEvent {
  if (!data.startsWith("0x")) {
    throw new Error("Oracle event data must be hex-prefixed");
  }
  const hex = data.slice(2);

  if (hex.length !== ORACLE_EVENT_LENGTH * 2) {
    throw new Error(
      `Unexpected oracle event length: expected ${
        ORACLE_EVENT_LENGTH * 2
      } hex chars, received ${hex.length}`
    );
  }

  const tokenChunk = sliceHex(hex, 0, 20);
  const snapshotChunk = sliceHex(hex, 20, 32);

  const token = checksumAddress(`0x${tokenChunk}` as `0x${string}`);

  const snapshot = BigInt(`0x${snapshotChunk}`);
  const timestamp = snapshot & ((1n << 32n) - 1n);
  const secondsPerLiquidityCumulative =
    (snapshot >> 32n) & ((1n << 160n) - 1n);
  const tickCumulativeRaw = snapshot >> 192n;
  const tickCumulative = toSigned(tickCumulativeRaw, 64);

  return { token, timestamp, secondsPerLiquidityCumulative, tickCumulative };
}
