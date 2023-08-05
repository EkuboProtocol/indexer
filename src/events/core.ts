import {
  combineParsers,
  GetParserType,
  parseBoolean,
  parseFelt252,
  parseI129,
  parseU128,
  parseU256,
  parseU8,
} from "../parse";

export const parsePoolKey = combineParsers({
  token0: { index: 0, parser: parseFelt252 },
  token1: { index: 1, parser: parseFelt252 },
  fee: { index: 2, parser: parseU128 },
  tick_spacing: { index: 3, parser: parseU128 },
  extension: { index: 4, parser: parseFelt252 },
});
export type PoolKey = GetParserType<typeof parsePoolKey>;
export const parseBounds = combineParsers({
  lower: { index: 0, parser: parseI129 },
  upper: { index: 1, parser: parseI129 },
});
export type Bounds = GetParserType<typeof parseBounds>;
const parseUpdatePositionParams = combineParsers({
  salt: { index: 0, parser: parseU128 },
  bounds: { index: 1, parser: parseBounds },
  liquidity_delta: { index: 2, parser: parseI129 },
});
export type UpdatePositionParameters = GetParserType<
  typeof parseUpdatePositionParams
>;
export const parseDelta = combineParsers({
  amount0: { index: 0, parser: parseI129 },
  amount1: { index: 1, parser: parseI129 },
});
export type Delta = GetParserType<typeof parseDelta>;
export const parsePositionUpdatedEvent = combineParsers({
  locker: { index: 0, parser: parseFelt252 },
  pool_key: { index: 1, parser: parsePoolKey },
  params: { index: 2, parser: parseUpdatePositionParams },
  delta: { index: 3, parser: parseDelta },
});
export type PositionUpdatedEvent = GetParserType<
  typeof parsePositionUpdatedEvent
>;
export const parsePositionKey = combineParsers({
  salt: { index: 0, parser: parseU128 },
  owner: { index: 1, parser: parseFelt252 },
  bounds: { index: 2, parser: parseBounds },
});
export const parsePositionFeesCollectedEvent = combineParsers({
  pool_key: { index: 1, parser: parsePoolKey },
  position_key: { index: 2, parser: parsePositionKey },
  delta: { index: 3, parser: parseDelta },
});
export type PositionFeesCollectedEvent = GetParserType<
  typeof parsePositionFeesCollectedEvent
>;
export const parseProtocolFeesWithdrawnEvent = combineParsers({
  recipient: { index: 0, parser: parseFelt252 },
  token: { index: 1, parser: parseFelt252 },
  amount: { index: 2, parser: parseU128 },
});
export type FeesWithdrawnEvent = GetParserType<
  typeof parseProtocolFeesWithdrawnEvent
>;
const parseSwapParameters = combineParsers({
  amount: { index: 0, parser: parseI129 },
  is_token1: { index: 1, parser: parseBoolean },
  sqrt_ratio_limit: { index: 2, parser: parseU256 },
  skip_ahead: { index: 3, parser: parseU128 },
});
export const parseSwappedEvent = combineParsers({
  locker: { index: 0, parser: parseFelt252 },
  pool_key: { index: 1, parser: parsePoolKey },
  params: { index: 2, parser: parseSwapParameters },
  delta: { index: 3, parser: parseDelta },
  sqrt_ratio_after: { index: 4, parser: parseU256 },
  tick_after: { index: 5, parser: parseI129 },
  liquidity_after: { index: 6, parser: parseU128 },
});
export type SwappedEvent = GetParserType<typeof parseSwappedEvent>;
export const parsePoolInitializedEvent = combineParsers({
  pool_key: { index: 0, parser: parsePoolKey },
  tick: { index: 1, parser: parseI129 },
  sqrt_ratio: { index: 2, parser: parseU256 },
  call_points: { index: 3, parser: parseU8 },
});
export type PoolInitializationEvent = GetParserType<
  typeof parsePoolInitializedEvent
>;
export const parseFeesPaidEvent = combineParsers({
  pool_key: { index: 0, parser: parsePoolKey },
  position_key: { index: 1, parser: parsePositionKey },
  delta: { index: 2, parser: parseDelta },
});
export type FeesPaidEvent = GetParserType<typeof parseFeesPaidEvent>;
