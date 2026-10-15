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
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  let hash: bigint;
  try {
    if (
      typeof header.blockHash !== "string" ||
      !/^0x[0-9a-f]+$/i.test(header.blockHash)
    )
      return null;
    hash = BigInt(header.blockHash);
  } catch {
    return null;
  }

  return { number, hash, timestamp };
}
