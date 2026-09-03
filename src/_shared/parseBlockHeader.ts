/**
 * The EVM and Starknet streams deliver different block shapes, but the three
 * fields the runtime actually keys on — height, hash, timestamp — are validated
 * identically on both. That validation lives here so the two entrypoints cannot
 * drift apart on what counts as a usable header.
 */
export interface CommonBlockHeader {
  number: number;
  hash: bigint;
  timestamp: number;
}

export function parseCommonBlockHeader(header: {
  blockNumber?: unknown;
  timestamp?: unknown;
  blockHash?: unknown;
}): CommonBlockHeader | null {
  if (
    typeof header.blockNumber !== "bigint" ||
    !(header.timestamp instanceof Date)
  ) {
    return null;
  }

  const number = Number(header.blockNumber);
  const timestamp = header.timestamp.getTime();
  if (!Number.isSafeInteger(number) || !Number.isFinite(timestamp)) {
    return null;
  }

  // A stream can hand back a header whose hash is absent or malformed; treating
  // that as an unusable block is safer than indexing under a zero hash.
  let hash: bigint;
  try {
    hash = BigInt((header.blockHash as string | undefined) ?? "0x0");
  } catch {
    return null;
  }

  return { number, hash, timestamp };
}
