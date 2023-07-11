import { FieldElement, v1alpha2 as starknet } from "@apibara/starknet";

export function parseLong(long: number | Long): bigint {
  return BigInt(typeof long === "number" ? long : long.toNumber());
}

interface PoolKey {
  token0: string;
  token1: string;
  fee: bigint;
  tick_spacing: number;
  extension: bigint;
}

interface Bounds {
  lower: bigint;
  upper: bigint;
}

export interface PositionMintedEvent {
  token_id: bigint;
  pool_key: PoolKey;
  bounds: Bounds;
}

export interface UpdatePositionParameters {
  salt: bigint;
  bounds: Bounds;
  liquidity_delta: bigint;
}

export interface Delta {
  amount0: bigint;
  amount1: bigint;
}

export interface PositionUpdatedEvent {
  pool_key: PoolKey;
  params: UpdatePositionParameters;
  delta: Delta;
}

export function parseU128(
  data: starknet.IFieldElement[],
  startingFrom: number
): bigint {
  return FieldElement.toBigInt(data[startingFrom]);
}

export function parseU256(
  data: starknet.IFieldElement[],
  startingFrom: number
): bigint {
  return (
    FieldElement.toBigInt(data[startingFrom]) +
    FieldElement.toBigInt(data[startingFrom + 1]) * 2n ** 128n
  );
}

export function parseI129(
  data: starknet.IFieldElement[],
  startingFrom: number
): bigint {
  return (
    FieldElement.toBigInt(data[startingFrom]) *
    (FieldElement.toBigInt(data[startingFrom + 1]) !== 0n ? -1n : 1n)
  );
}

export function parsePoolKey(
  data: starknet.IFieldElement[],
  startingFrom: number
) {
  return {
    token0: FieldElement.toHex(data[startingFrom]),
    token1: FieldElement.toHex(data[startingFrom + 1]),
    fee: BigInt(FieldElement.toHex(data[startingFrom + 2])),
    tick_spacing: Number(FieldElement.toHex(data[startingFrom + 3])),
    extension: BigInt(FieldElement.toHex(data[startingFrom + 4])),
  };
}

export function parseBounds(
  data: starknet.IFieldElement[],
  startingFrom: number
): { lower: bigint; upper: bigint } {
  return {
    lower: parseI129(data, startingFrom),
    upper: parseI129(data, startingFrom + 2),
  };
}

export function parsePositionMintedEvent(
  ev: starknet.IEventWithTransaction
): PositionMintedEvent {
  return {
    token_id: parseU256(ev.event.data, 0),
    pool_key: parsePoolKey(ev.event.data, 2),
    bounds: parseBounds(ev.event.data, 7),
  };
}

function parseUpdatePositionParams(
  data: starknet.IFieldElement[],
  startingFrom: number
): UpdatePositionParameters {
  return {
    salt: parseU128(data, startingFrom),
    bounds: parseBounds(data, startingFrom + 1),
    liquidity_delta: parseI129(data, startingFrom + 5),
  };
}

export function parseDelta(
  data: starknet.IFieldElement[],
  startingFrom: number
): Delta {
  return {
    amount0: parseI129(data, startingFrom),
    amount1: parseI129(data, startingFrom + 2),
  };
}

export function parsePositionUpdatedEvent(
  data: starknet.IFieldElement[],
  startingFrom: number
): PositionUpdatedEvent {
  return {
    pool_key: parsePoolKey(data, startingFrom),
    params: parseUpdatePositionParams(data, startingFrom + 5),
    delta: parseDelta(data, startingFrom + 11),
  };
}
