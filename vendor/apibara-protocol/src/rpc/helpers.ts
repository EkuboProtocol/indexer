import type { Cursor } from "../common";
import type { BlockInfo } from "./config";

export function blockInfoToCursor(blockInfo: BlockInfo): Cursor {
  return {
    orderKey: blockInfo.blockNumber,
    uniqueKey: blockInfo.blockHash,
  };
}

/** Resolve after the requested number of milliseconds. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
