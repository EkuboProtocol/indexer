// MEVCapture v2.1 on the current (V3) Core, the `main` variant (evm-contracts
// branch eku-1582/mevcapture-v21-main, src/extensions/MEVCaptureV21.sol; spec
// EKU-946 rev 10 §(b-main)).
//
// Core's logs do not carry the extension's per-pool state, so it is read
// explicitly: getConfig() once per extension, getAnchor(poolId) at the end of
// every block that touched a v2.1 pool. Both are eth_call pinned to the block
// hash, so the state belongs to exactly the block whose Core events are being
// written. Gate failures come from the extension's own AnchorGateFailed log.
// The surcharge is charged through Core.accumulateAsFees right after each
// charged Core call, so it is attributed per forwarded swap from Core's own
// Swapped and FeesAccumulated logs (recordMevCaptureV21SwapSurcharges).
//
// Every decode is strict: a word that does not re-encode to the bytes it came
// from (a dirty high bit in a uint8, a wrong length, an extra topic) throws
// instead of being truncated into a plausible value.
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  toEventSelector,
  type Hex,
} from "viem";
import type { DAO } from "../_shared/dao";
import type { EventKey } from "../_shared/eventKey";
import type { RpcLike } from "./logStream";
import type { EvmLogProcessor } from "./logProcessorsShared";

// IMEVCaptureV21 of the main variant (EKU-1582).
export const MEV_CAPTURE_V21_ABI = [
  {
    type: "function",
    name: "getAnchor",
    inputs: [{ name: "poolId", type: "bytes32", internalType: "PoolId" }],
    outputs: [
      { name: "lastUpdateTime", type: "uint32", internalType: "uint32" },
      { name: "lRefTime", type: "uint32", internalType: "uint32" },
      { name: "lastPosTime", type: "uint32", internalType: "uint32" },
      { name: "lRefBits", type: "uint8", internalType: "uint8" },
      { name: "snapBits", type: "uint8", internalType: "uint8" },
      { name: "lRefRaiseTime", type: "uint32", internalType: "uint32" },
      { name: "anchorX16", type: "int64", internalType: "int64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getConfig",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct IMEVCaptureV21.Config",
        components: [
          { name: "halfLife", type: "uint32", internalType: "uint32" },
          { name: "slopeK", type: "uint8", internalType: "uint8" },
          { name: "segmentExp", type: "uint8", internalType: "uint8" },
          { name: "segmentWidthMultiplier", type: "uint32", internalType: "uint32" },
          { name: "jLin", type: "uint8", internalType: "uint8" },
          { name: "maxFee", type: "uint64", internalType: "uint64" },
          { name: "clampTicks", type: "uint32", internalType: "uint32" },
          { name: "mGate", type: "uint8", internalType: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "AnchorGateFailed",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true, internalType: "PoolId" },
      { name: "lObs", type: "uint8", indexed: false, internalType: "uint8" },
      { name: "eRef", type: "uint8", indexed: false, internalType: "uint8" },
    ],
    anonymous: false,
  },
] as const;

export const ANCHOR_GATE_FAILED_TOPIC = toEventSelector(
  "AnchorGateFailed(bytes32,uint8,uint8)",
);

const MAX_TICK = 88722835;

export interface MevCaptureV21Config {
  halfLife: number;
  slopeK: number;
  segmentExp: number;
  segmentWidthMultiplier: number;
  jLin: number;
  /** 0.64 fixed point, like the pool fee. */
  maxFee: bigint;
  clampTicks: number;
  mGate: number;
}

export interface MevCaptureV21Anchor {
  lastUpdateTime: number;
  lRefTime: number;
  lastPosTime: number;
  lRefBits: number;
  snapBits: number;
  lRefRaiseTime: number;
  anchorX16: bigint;
}

export interface AnchorGateFailedEvent {
  poolId: Hex;
  lObs: number;
  eRef: number;
}

function sameAddress(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

function requireCanonical(
  label: string,
  data: Hex,
  reencoded: Hex,
): void {
  if (data.toLowerCase() !== reencoded.toLowerCase()) {
    throw new Error(`${label}: non-canonical ABI encoding ${data}`);
  }
}

/**
 * The constructor's own checks, plus `segmentWidthMultiplier == 2^segmentExp`.
 * A contract that answers getConfig with anything else is not this v2.1 build.
 */
const CONFIG_BOUNDS: Record<
  Exclude<keyof MevCaptureV21Config, "maxFee" | "segmentWidthMultiplier">,
  [number, number]
> = {
  halfLife: [1, 1 << 20],
  slopeK: [1, 16],
  segmentExp: [0, 8],
  jLin: [1, 64],
  clampTicks: [1, 2 * MAX_TICK],
  mGate: [0, 16],
};

export function validateMevCaptureV21Config(config: MevCaptureV21Config): void {
  const inBounds = Object.entries(CONFIG_BOUNDS).every(([field, [min, max]]) => {
    const value = config[field as keyof typeof CONFIG_BOUNDS];
    return value >= min && value <= max;
  });
  if (
    !inBounds ||
    config.maxFee < 1n ||
    config.maxFee > 1n << 63n ||
    config.segmentWidthMultiplier !== 2 ** config.segmentExp
  ) {
    throw new Error(
      `getConfig returned a configuration MEVCaptureV21 cannot have: ${JSON.stringify(config, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }
}

export function decodeMevCaptureV21Config(data: Hex): MevCaptureV21Config {
  const decoded = decodeFunctionResult({
    abi: MEV_CAPTURE_V21_ABI,
    functionName: "getConfig",
    data,
  });
  requireCanonical(
    "getConfig",
    data,
    encodeFunctionResult({ abi: MEV_CAPTURE_V21_ABI, functionName: "getConfig", result: decoded }),
  );
  const config: MevCaptureV21Config = { ...decoded };
  validateMevCaptureV21Config(config);
  return config;
}

export function decodeMevCaptureV21Anchor(data: Hex): MevCaptureV21Anchor {
  const decoded = decodeFunctionResult({
    abi: MEV_CAPTURE_V21_ABI,
    functionName: "getAnchor",
    data,
  });
  requireCanonical(
    "getAnchor",
    data,
    encodeFunctionResult({ abi: MEV_CAPTURE_V21_ABI, functionName: "getAnchor", result: decoded }),
  );
  const [lastUpdateTime, lRefTime, lastPosTime, lRefBits, snapBits, lRefRaiseTime, anchorX16] = decoded;
  return { lastUpdateTime, lRefTime, lastPosTime, lRefBits, snapBits, lRefRaiseTime, anchorX16 };
}

export function encodeMevCaptureV21Anchor(anchor: MevCaptureV21Anchor): Hex {
  return encodeFunctionResult({
    abi: MEV_CAPTURE_V21_ABI,
    functionName: "getAnchor",
    result: [
      anchor.lastUpdateTime,
      anchor.lRefTime,
      anchor.lastPosTime,
      anchor.lRefBits,
      anchor.snapBits,
      anchor.lRefRaiseTime,
      anchor.anchorX16,
    ],
  });
}

/**
 * Decodes AnchorGateFailed from the configured extension only. Rejects another
 * emitter (another version or a lookalike), another topic0, a non-indexed or
 * extra-indexed layout, and dirty or short data.
 */
export function parseAnchorGateFailed(
  extension: Hex,
  log: { address: Hex; topics: readonly Hex[]; data: Hex | undefined },
): AnchorGateFailedEvent {
  if (!sameAddress(log.address, extension)) {
    throw new Error(`AnchorGateFailed from ${log.address}, not the v2.1 extension ${extension}`);
  }
  if (log.topics.length !== 2 || log.topics[0]?.toLowerCase() !== ANCHOR_GATE_FAILED_TOPIC) {
    throw new Error(`Not an AnchorGateFailed(bytes32 indexed,uint8,uint8) log: topics ${log.topics.join(",")}`);
  }
  const poolId = log.topics[1]!;
  if (!/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    throw new Error(`AnchorGateFailed poolId topic is not 32 bytes: ${poolId}`);
  }
  const data = log.data ?? "0x";
  if (data.length !== 2 + 128) {
    throw new Error(`AnchorGateFailed data must be two words, got ${data}`);
  }
  const params = [{ type: "uint8" }, { type: "uint8" }] as const;
  const [lObs, eRef] = decodeAbiParameters(params, data);
  requireCanonical("AnchorGateFailed", data, encodeAbiParameters(params, [lObs, eRef]));
  return { poolId: poolId.toLowerCase() as Hex, lObs, eRef };
}

/** The gate processor if v2.1 is configured, otherwise none. */
export function mevCaptureV21Processors(
  extension: Hex | undefined,
  coreAddress: Hex,
): EvmLogProcessor[] {
  return extension ? [createMevCaptureV21GateProcessor(extension, coreAddress)] : [];
}

export function createMevCaptureV21GateProcessor(
  extension: Hex,
  coreAddress: Hex,
): EvmLogProcessor {
  return {
    address: extension,
    filter: { topics: [ANCHOR_GATE_FAILED_TOPIC], strict: false },
    async handler(dao: DAO, key: EventKey, event) {
      const parsed = parseAnchorGateFailed(extension, {
        address: key.emitter,
        topics: event.topics,
        data: event.data,
      });
      await dao.insertMEVCaptureV21GateFailed({ ...parsed, coreAddress }, key);
    },
  };
}

async function ethCallAtBlockHash(rpc: RpcLike, to: Hex, data: Hex, blockHash: Hex): Promise<Hex> {
  const result = await rpc.request({
    method: "eth_call",
    params: [{ to, data }, { blockHash, requireCanonical: true }],
  });
  return result;
}

export function getAnchorCalldata(poolId: Hex): Hex {
  return encodeFunctionData({ abi: MEV_CAPTURE_V21_ABI, functionName: "getAnchor", args: [poolId] });
}

export const GET_CONFIG_CALLDATA = encodeFunctionData({
  abi: MEV_CAPTURE_V21_ABI,
  functionName: "getConfig",
});

/**
 * Runs after a block's logs are written, inside the same transaction. Any read
 * or decode failure throws, so the block is retried rather than written with
 * a missing state row.
 */
export async function recordMevCaptureV21BlockState({
  rpc,
  dao,
  extension,
  coreAddress,
  blockNumber,
  blockHash,
}: {
  rpc: RpcLike;
  dao: DAO;
  extension: Hex;
  coreAddress: Hex;
  blockNumber: number;
  blockHash: Hex;
}): Promise<number> {
  const pools = await dao.getMEVCaptureV21PoolsTouchedInBlock(extension, coreAddress, blockNumber);
  if (pools.length === 0) return 0;

  await dao.insertMEVCaptureV21SwapSurcharges(extension, coreAddress, blockNumber);

  if (!(await dao.hasMEVCaptureV21Config(extension))) {
    const config = decodeMevCaptureV21Config(
      await ethCallAtBlockHash(rpc, extension, GET_CONFIG_CALLDATA, blockHash),
    );
    await dao.insertMEVCaptureV21Config({ extension, blockNumber, blockHash, config });
  }

  const anchors = await Promise.all(
    pools.map(async ({ poolKeyId, poolId }) => ({
      poolKeyId,
      anchor: decodeMevCaptureV21Anchor(
        await ethCallAtBlockHash(rpc, extension, getAnchorCalldata(poolId), blockHash),
      ),
    })),
  );
  for (const { poolKeyId, anchor } of anchors) {
    await dao.insertMEVCaptureV21AnchorState({ poolKeyId, blockNumber, blockHash, anchor });
  }
  return anchors.length;
}

/**
 * The v2.1 extension address, if configured. Refuses to treat the v1
 * MEVCapture address as v2.1: the two are different contracts with different
 * state, and one address cannot be both.
 */
export function loadMevCaptureV21Address(
  v21: Hex | undefined,
  v1Addresses: (Hex | undefined)[],
): Hex | undefined {
  if (!v21) return undefined;
  for (const v1 of v1Addresses) {
    if (v1 && sameAddress(v1, v21)) {
      throw new Error(`MEV_CAPTURE_V21_V3_ADDRESS ${v21} is also configured as MEVCapture v1`);
    }
  }
  return v21;
}
