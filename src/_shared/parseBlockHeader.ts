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
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isFinite(timestamp)) {
    return null;
  }

  // A stream can hand back a header whose hash is absent or malformed; treating
  // that as an unusable block is safer than indexing under a zero hash.
  let hash: bigint;
  try {
    if (typeof header.blockHash !== "string" || !/^0x[0-9a-f]+$/i.test(header.blockHash)) return null;
    hash = BigInt(header.blockHash);
  } catch {
    return null;
  }

  return { number, hash, timestamp };
}
