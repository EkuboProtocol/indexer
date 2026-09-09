/** Reject ambiguous event identities before any processor can write them. */
export function recordEventIdentity(
  seen: Map<string, string>,
  blockNumber: number,
  blockHash: string,
  eventPosition: string,
): void {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`Invalid event block number ${blockNumber}`);
  }
  const blockKey = `block:${blockNumber}`;
  const hash = BigInt(blockHash).toString();
  const held = seen.get(blockKey);
  if (held !== undefined && held !== hash) {
    throw new Error(`Mixed block hashes for block ${blockNumber}`);
  }
  seen.set(blockKey, hash);
  const eventKey = `${blockNumber}:${eventPosition}`;
  if (seen.has(eventKey)) {
    throw new Error(`Duplicate event position ${eventKey}`);
  }
  seen.set(eventKey, hash);
}

export function requireBlockInRange(number: number, from: number, to: number): void {
  if (!Number.isSafeInteger(number) || number < from || number > to) {
    throw new Error(`RPC returned block ${number} outside requested range ${from}..${to}`);
  }
}

/** Tokens are opaque; repeated tokens or non-string values cannot advance. */
export function checkContinuationToken(token: unknown, seen: Set<string>): void {
  if (token === undefined || token === null) return;
  if (typeof token !== "string" || token.length === 0 || seen.has(token)) {
    throw new Error("starknet_getEvents returned an invalid or repeated continuation token");
  }
  seen.add(token);
}
