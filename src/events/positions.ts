import { parseBounds, parseDelta, parsePoolKey } from "./core";
import {
  combineParsers,
  GetParserType,
  parseAddress,
  parseBoolean,
  parseU128,
  parseU64,
} from "../parse";

export const parsePositionMintedEvent = combineParsers({
  id: { index: 0, parser: parseU64 },
  pool_key: { index: 1, parser: parsePoolKey },
  bounds: { index: 2, parser: parseBounds },
});
export type PositionMintedEvent = GetParserType<
  typeof parsePositionMintedEvent
>;

export const parseDepositEvent = combineParsers({
  id: { index: 0, parser: parseU64 },
  pool_key: { index: 1, parser: parsePoolKey },
  bounds: { index: 2, parser: parseBounds },
  liquidity: { index: 3, parser: parseU128 },
  delta: { index: 4, parser: parseDelta },
});
export type DepositEvent = GetParserType<typeof parseDepositEvent>;

export const parseWithdrawEvent = combineParsers({
  id: { index: 0, parser: parseU64 },
  pool_key: { index: 1, parser: parsePoolKey },
  bounds: { index: 2, parser: parseBounds },
  liquidity: { index: 3, parser: parseU128 },
  delta: { index: 4, parser: parseDelta },
  collect_fees: { index: 5, parser: parseBoolean },
  recipient: { index: 5, parser: parseAddress },
});
export type WithdrawEvent = GetParserType<typeof parseWithdrawEvent>;
