import type { DAO } from "../_shared/dao";
import type { EventKey } from "../_shared/eventKey";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeEventTopics,
  type AbiParameter,
} from "viem";
import {
  LAUNCH_TOKEN_ABI,
  ZERO_SEED_LAUNCH_ABI,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI,
} from "./abis_zero_seed_launch";
import {
  createProcessorsFromHandlers,
  type ContractEvent,
  type ContractHandlers,
  type EvmLogProcessor,
} from "./logProcessorsShared";
import { parsePositionId, parseV2PoolKeyConfig, toPoolId } from "./poolKey";
import type { ZeroSeedLaunchPin } from "./zeroSeedLaunchConfig";

export type LaunchCreated = ContractEvent<
  typeof ZERO_SEED_LAUNCH_ABI,
  "LaunchCreated"
>;

const same = (a: string, b: string) => BigInt(a) === BigInt(b);

/** LaunchParameters.supply bounds of the contract (InvalidSupply). */
export const MAX_LAUNCH_SUPPLY = 10n ** 30n;
export const MIN_TICK = -88722835;
export const MAX_TICK = 88722835;

/**
 * The content of a canonical Solady LibString.packOne word: byte 0 is the
 * length 1..31, then that many content bytes, then zeros. Anything else is
 * not a word the contract accepts (InvalidMetadata), so undefined.
 */
export function unpackLaunchString(
  word: `0x${string}`,
): Uint8Array | undefined {
  const bytes = Buffer.from(word.slice(2).padStart(64, "0"), "hex");
  if (bytes.length !== 32) return undefined;
  const length = bytes[0];
  if (length < 1 || length > 31) return undefined;
  if (bytes.subarray(1 + length).some((b) => b !== 0)) return undefined;
  return new Uint8Array(bytes.subarray(1, 1 + length));
}

/**
 * Bytes as Postgres-storable text: valid UTF-8 without NUL, else undefined.
 * Launch metadata and logos are arbitrary creator bytes.
 */
export function storableText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

/**
 * The derived spacing and installed economic bounds of a requested range
 * (ZeroSeedLaunch alignLaunchRange): s = (upper - ask + 255) // 256, the ask
 * rounded up and the top rounded down to a multiple of s, with mathematical
 * (not truncating) signed rounding.
 */
export function alignLaunchRange(askTick: number, upperTick: number) {
  const tickSpacing = floorDiv(upperTick - askTick + 255, 256);
  return {
    tickSpacing,
    alignedAskTick: -floorDiv(-askTick, tickSpacing) * tickSpacing,
    alignedUpperTick: floorDiv(upperTick, tickSpacing) * tickSpacing,
  };
}

/** Pool-tick bounds of the position for the token order. */
export function launchPoolBounds(
  tokenIs1: boolean,
  alignedAskTick: number,
  alignedUpperTick: number,
): [number, number] {
  return tokenIs1
    ? [-alignedUpperTick, -alignedAskTick]
    : [alignedAskTick, alignedUpperTick];
}

function parameterProblems(event: LaunchCreated): [boolean, string][] {
  const { parameters: p } = event;
  return [
    [!same(event.token, p.quoteToken), "launch token is the quote"],
    [
      unpackLaunchString(p.name) !== undefined &&
        unpackLaunchString(p.symbol) !== undefined,
      "name or symbol is not a canonical packed string",
    ],
    [event.liquidity > 0n, "liquidity is 0"],
    [
      p.supply > 0n && p.supply <= MAX_LAUNCH_SUPPLY,
      "requested supply is outside 1..1e30",
    ],
    [
      MIN_TICK <= p.askTick &&
        p.askTick < p.upperTick &&
        p.upperTick <= MAX_TICK,
      "ticks are outside MIN_TICK <= ask < upper <= MAX_TICK",
    ],
    [p.finalFee <= p.initialFee, "final fee above initial fee"],
  ];
}

function geometryProblems(
  key: Pick<EventKey, "emitter">,
  event: LaunchCreated,
): [boolean, string][] {
  const { poolKey, parameters: p, positionId } = event;
  const config = parseV2PoolKeyConfig(poolKey.config);
  const tokenIs1 = BigInt(event.token) > BigInt(p.quoteToken);
  const [token0, token1] = tokenIs1
    ? [p.quoteToken, event.token]
    : [event.token, p.quoteToken];
  const position = parsePositionId(positionId);
  const { tickSpacing, alignedAskTick, alignedUpperTick } = alignLaunchRange(
    p.askTick,
    p.upperTick,
  );
  const [lower, upper] = launchPoolBounds(
    tokenIs1,
    alignedAskTick,
    alignedUpperTick,
  );
  return [
    [same(config.extension, key.emitter), "pool extension is not the emitter"],
    [
      toPoolId(poolKey) === event.poolId.toLowerCase(),
      "poolId != id of poolKey",
    ],
    [
      same(poolKey.token0, token0) && same(poolKey.token1, token1),
      "pool tokens are not (token, quoteToken) in order",
    ],
    [config.fee === 0n, "Core fee is not 0"],
    [
      "tickSpacing" in config && config.tickSpacing === tickSpacing,
      "pool tick spacing is not the derived spacing",
    ],
    [
      position.salt === 0n &&
        position.lower === lower &&
        position.upper === upper,
      "position is not (salt 0, aligned pool bounds)",
    ],
  ];
}

/**
 * Reasons a LaunchCreated log disagrees with itself or its emitter: the
 * parameters the contract validates, and the pool key, derived spacing and
 * position the contract derives from them. The installed supply is not in
 * the log; the DAO takes it from Core's PositionUpdated of the creation.
 */
export function launchCreatedProblems(
  key: Pick<EventKey, "emitter">,
  event: LaunchCreated,
): string[] {
  return [...parameterProblems(event), ...geometryProblems(key, event)]
    .filter(([ok]) => !ok)
    .map(([, problem]) => problem);
}

const LAUNCH_CREATED_EVENT = ZERO_SEED_LAUNCH_ABI.find(
  (item) => item.type === "event" && item.name === "LaunchCreated",
)!;
// The non-indexed inputs with logoUrl read as bytes: the same ABI encoding,
// so the logo comes back as exactly the emitted bytes.
const LAUNCH_CREATED_DATA_AS_BYTES: AbiParameter[] = LAUNCH_CREATED_EVENT.inputs
  .filter((input) => !input.indexed)
  .map((input) =>
    input.name === "logoUrl" ? { ...input, type: "bytes" } : input,
  );

/** The exact bytes of LaunchCreated.logoUrl. */
export function launchCreatedLogoBytes(data: `0x${string}`): Uint8Array {
  const decoded = decodeAbiParameters(LAUNCH_CREATED_DATA_AS_BYTES, data);
  return Buffer.from((decoded.at(-1) as `0x${string}`).slice(2), "hex");
}

/** The decoded LaunchCreated fields the DAO stores. */
export function launchCreatedRow(
  event: LaunchCreated,
  logoBytes: Uint8Array,
  coreAddress: `0x${string}`,
) {
  const { parameters: p } = event;
  const nameBytes = unpackLaunchString(p.name)!;
  const symbolBytes = unpackLaunchString(p.symbol)!;
  return {
    coreAddress,
    poolId: event.poolId,
    token: event.token,
    controller: event.controller,
    quoteToken: p.quoteToken,
    positionId: event.positionId,
    liquidity: event.liquidity,
    requestedSupply: p.supply,
    nameWord: p.name,
    symbolWord: p.symbol,
    name: storableText(nameBytes) ?? null,
    symbol: storableText(symbolBytes) ?? null,
    logoUrlBytes: logoBytes,
    logoUrl: storableText(logoBytes) ?? null,
    askTick: p.askTick,
    upperTick: p.upperTick,
    ...alignLaunchRange(p.askTick, p.upperTick),
    tradingStart: p.tradingStart,
    decayRateX32: p.decayRateX32,
    initialFee: p.initialFee,
    finalFee: p.finalFee,
    salt: p.salt,
  };
}

function launchCreatedProcessor(
  address: `0x${string}`,
  coreAddress: `0x${string}`,
): EvmLogProcessor {
  return {
    address,
    filter: {
      topics: encodeEventTopics({
        abi: ZERO_SEED_LAUNCH_ABI,
        eventName: "LaunchCreated",
      }) as `0x${string}`[],
      strict: false,
    },
    async handler(dao, key, log) {
      const { args } = decodeEventLog({
        abi: ZERO_SEED_LAUNCH_ABI,
        eventName: "LaunchCreated",
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
        strict: true,
      });
      await insertLaunchCreated(dao, key, args, log.data ?? "0x", coreAddress);
    },
  };
}

export async function insertLaunchCreated(
  dao: DAO,
  key: EventKey,
  event: LaunchCreated,
  data: `0x${string}`,
  coreAddress: `0x${string}`,
) {
  const problems = launchCreatedProblems(key, event);
  if (problems.length > 0)
    throw new Error(
      `Refusing LaunchCreated for pool ${event.poolId}: ${problems.join("; ")}`,
    );
  await dao.insertZeroSeedLaunchCreatedEvent(
    key,
    launchCreatedRow(event, launchCreatedLogoBytes(data), coreAddress),
  );
}

/** The extension's swap and claim events. */
export function zeroSeedLaunchHandlers(
  coreAddress: `0x${string}`,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_ABI,
    handlers: {
      async LaunchSwapped(dao, key, event) {
        await dao.insertZeroSeedLaunchSwappedEvent(key, {
          coreAddress,
          ...event,
        });
      },
      async CreatorFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesClaimedEvent(key, {
          coreAddress,
          ...event,
        });
      },
    },
  };
}

/** The periphery's owner and payout events, attributed to its extension. */
export function zeroSeedLaunchPeripheryHandlers(
  coreAddress: `0x${string}`,
  pin: Pick<ZeroSeedLaunchPin, "address">,
): Omit<ContractHandlers<typeof ZERO_SEED_LAUNCH_PERIPHERY_ABI>, "address"> {
  return {
    abi: ZERO_SEED_LAUNCH_PERIPHERY_ABI,
    handlers: {
      async LaunchOwnerChanged(dao, key, event) {
        await dao.insertZeroSeedLaunchOwnerChangedEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
      async LaunchFeesClaimed(dao, key, event) {
        await dao.insertZeroSeedLaunchFeesPaidEvent(key, {
          coreAddress,
          extension: pin.address,
          ...event,
        });
      },
    },
  };
}

/** topics[2] of LaunchCreated is the launch token. */
const LAUNCH_CREATED_TOKEN_TOPIC = 2;

/**
 * Raw Transfer and Approval logs of every launch token the extension creates,
 * from the mints that precede its LaunchCreated onward.
 */
export function launchTokenProcessors(
  extension: `0x${string}`,
): EvmLogProcessor[] {
  const discoveredBy = {
    kind: "zero_seed_launch_token",
    address: extension,
    topic0: (
      encodeEventTopics({
        abi: ZERO_SEED_LAUNCH_ABI,
        eventName: "LaunchCreated",
      }) as `0x${string}`[]
    )[0],
    topicIndex: LAUNCH_CREATED_TOKEN_TOPIC,
  } as const;
  return (["Transfer", "Approval"] as const).map((eventName) => ({
    address: extension,
    discoveredBy,
    filter: {
      topics: encodeEventTopics({
        abi: LAUNCH_TOKEN_ABI,
        eventName,
      }) as `0x${string}`[],
      strict: false,
    },
    async handler(dao, key, log) {
      const { args } = decodeEventLog({
        abi: LAUNCH_TOKEN_ABI,
        eventName,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
        strict: true,
      });
      await dao.insertZeroSeedLaunchTokenEvent(
        key,
        "from" in args
          ? {
              kind: "transfer",
              fromOrOwner: args.from,
              toOrSpender: args.to,
              value: args.amount,
            }
          : {
              kind: "approval",
              fromOrOwner: args.owner,
              toOrSpender: args.spender,
              value: args.amount,
            },
      );
    },
  }));
}

/**
 * The five events of each pinned instance: LaunchCreated, LaunchSwapped and
 * CreatorFeesClaimed of the extension, LaunchOwnerChanged and
 * LaunchFeesClaimed of its periphery, decoded with the frozen ABIs, and the
 * raw Transfer and Approval logs of its launch tokens.
 */
export function createZeroSeedLaunchProcessors({
  coreAddress,
  zeroSeedLaunchPins,
}: {
  coreAddress: `0x${string}`;
  zeroSeedLaunchPins?: readonly ZeroSeedLaunchPin[];
}): EvmLogProcessor[] {
  return (zeroSeedLaunchPins ?? []).flatMap((pin) => {
    if (!same(pin.core, coreAddress))
      throw new Error("ZeroSeedLaunch pin is for another Core");
    return [
      launchCreatedProcessor(pin.address, coreAddress),
      ...createProcessorsFromHandlers({
        ZeroSeedLaunch: {
          address: pin.address,
          ...zeroSeedLaunchHandlers(coreAddress),
        },
        ZeroSeedLaunchPeriphery: {
          address: pin.periphery,
          ...zeroSeedLaunchPeripheryHandlers(coreAddress, pin),
        },
      }),
      ...launchTokenProcessors(pin.address),
    ];
  });
}

/**
 * Refuses, once, before the first indexed block, to index a pinned instance
 * from a block after its deployment unless no launch event can have been
 * missed (see DAO.zeroSeedLaunchCatchUpProblem). The recovery is to roll back
 * to the block before the deployment and replay it inclusively.
 */
export function zeroSeedLaunchCatchUpGuard(
  pins: readonly Pick<
    ZeroSeedLaunchPin,
    "address" | "core" | "deploymentBlock"
  >[],
) {
  let checked = pins.length === 0;
  return async (dao: DAO, firstBlock: number) => {
    if (checked) return;
    for (const pin of pins) {
      const problem = await dao.zeroSeedLaunchCatchUpProblem(
        pin.core,
        pin.address,
        pin.deploymentBlock,
        firstBlock,
      );
      if (problem) throw new Error(problem);
    }
    checked = true;
  };
}
