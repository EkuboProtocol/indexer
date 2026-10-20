import {
  ZERO_SEED_LAUNCH_ABI_SHA256,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
} from "./abis_zero_seed_launch";

/** Plain WETH9 runtime (Base 0x4200…0006); the only accepted ERC-20 quote runtime. */
export const PLAIN_WETH_RUNTIME_CODEHASH =
  "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c";

/**
 * The quote of an instance. Native ETH is `address(0)`, always token0, 18
 * decimals, and has no code: nothing about it is read or hashed. An ERC-20
 * quote is bound to its runtime codehash.
 */
export type ZeroSeedLaunchQuote =
  | { kind: "native"; address: "0x0000000000000000000000000000000000000000" }
  | {
      kind: "erc20";
      address: `0x${string}`;
      runtimeCodehash: `0x${string}`;
    };

/**
 * A ZeroSeedLaunch deployment the indexer may decode: the extension and the
 * periphery that forwards creations and claims to it (the launch controller
 * that records transferable owners). The indexer makes no provider call to
 * check a deployment: the operator's extension address and runtime codehash
 * must equal an entry here, which is reviewed with the code, and the periphery
 * comes from the same entry, never from configuration.
 */
export interface ZeroSeedLaunchPin {
  chainId: bigint;
  address: `0x${string}`;
  runtimeCodehash: `0x${string}`;
  abiSha256: string;
  periphery: `0x${string}`;
  peripheryRuntimeCodehash: `0x${string}`;
  peripheryAbiSha256: string;
  core: `0x${string}`;
  quote: ZeroSeedLaunchQuote;
  /** First block to index, inclusive: the block that deployed the extension. */
  deploymentBlock: number;
  /** A local fixture chain; never accepted in production. */
  local: boolean;
  source: string;
}

const LOCAL_CORE = "0x00000000000014aa86c5d3c41765bb24e11bd701";
const LOCAL_SOURCE =
  "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts 4f1a3060, constructor-executed, no fork";

/**
 * No live deployment is pinned. Only the two constructor-executed local
 * instances of the replay fixture exist: native ETH (launch token is token1)
 * and relocated plain WETH (launch token is token0). Production refuses both.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [
  {
    chainId: 31337n,
    address: "0x5114703a4cf4256f0acb68f992c861d8c4d1b173",
    runtimeCodehash:
      "0x846786a63ba1a2c976f748fdc94b8cbc8f76dc64f07452333d36ff564f281bf7",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    periphery: "0xb27e16c3d01850191c1e027f7a3372cd2e1fb324",
    peripheryRuntimeCodehash:
      "0x57d0ee27c634ac08d08b60bf8e6c2f185c7e9444613ccfde5ac9bbb5e3f84f2a",
    peripheryAbiSha256: ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
    core: LOCAL_CORE,
    quote: {
      kind: "native",
      address: "0x0000000000000000000000000000000000000000",
    },
    deploymentBlock: 2,
    local: true,
    source: `${LOCAL_SOURCE}, native quote`,
  },
  {
    chainId: 31337n,
    address: "0x519435a42752da78e395999218d0ecc4fdcbcf4b",
    runtimeCodehash:
      "0x56e32aeac03464c3babd754fc21e0594c42d82db9d9c0cc3dd1ce1ec20273750",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    periphery: "0x94e1b338def908449e6ea7c7d254630b45d27562",
    peripheryRuntimeCodehash:
      "0xb78ea649f2e1817c851f7417a604d1565a346c6bec022abc821e3f1110739ac8",
    peripheryAbiSha256: ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
    core: LOCAL_CORE,
    quote: {
      kind: "erc20",
      address: "0xffffffffffffffffffffffffffffffffffffffff",
      runtimeCodehash: PLAIN_WETH_RUNTIME_CODEHASH,
    },
    deploymentBlock: 2,
    local: true,
    source: `${LOCAL_SOURCE}, relocated plain WETH quote`,
  },
];

/**
 * Codehashes that cannot identify a deployment: empty code, and the build's
 * runtimes with their immutables zero-filled (extension and periphery).
 */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  "0x25637ad2d1071b641f275d3b1037616b8836d2445501c05d38618764fa924167",
  "0x271683d2c3cf5e518fc5aa531f8568191b166a262a43e05d13325f0630dd5d7a",
]);

export interface ZeroSeedLaunchEnv {
  /** Unknown (no CHAIN_ID) matches no pin. */
  chainId?: bigint;
  address?: `0x${string}`;
  runtimeCodehash?: `0x${string}`;
  coreAddress?: `0x${string}`;
  production: boolean;
  pins?: readonly ZeroSeedLaunchPin[];
  warn?: (message: string) => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function quoteProblem(quote: ZeroSeedLaunchQuote): string | undefined {
  if (quote.kind === "native")
    return BigInt(quote.address) === 0n
      ? undefined
      : "a native quote must be address(0)";
  if (BigInt(quote.address) === 0n)
    return "an ERC-20 quote cannot be address(0)";
  return quote.runtimeCodehash === PLAIN_WETH_RUNTIME_CODEHASH
    ? undefined
    : "the ERC-20 quote lacks plain-WETH runtime provenance";
}

function checkPin(pin: ZeroSeedLaunchPin, env: ZeroSeedLaunchEnv) {
  if (!env.coreAddress || !same(pin.core, env.coreAddress))
    throw new Error(
      "ZeroSeedLaunch Core does not match constructor provenance",
    );
  const problem = quoteProblem(pin.quote);
  if (problem) throw new Error(`ZeroSeedLaunch quote: ${problem}`);
  if (!same(pin.runtimeCodehash, env.runtimeCodehash!))
    throw new Error(
      `ZERO_SEED_LAUNCH_RUNTIME_CODEHASH does not match the pin for ${pin.address} on chain ${pin.chainId}`,
    );
  checkPinArtifacts(pin);
  checkConstructorProvenance(pin);
  if (pin.local && env.production)
    throw new Error(
      `The pin for ${pin.address} is a local fixture and cannot be used in production`,
    );
}

function checkPinArtifacts(pin: ZeroSeedLaunchPin) {
  if (
    pin.abiSha256 !== ZERO_SEED_LAUNCH_ABI_SHA256 ||
    pin.peripheryAbiSha256 !== ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256
  )
    throw new Error(
      `The pin for ${pin.address} is for another ABI than the compiled extension and periphery`,
    );
  if (
    BigInt(pin.periphery) === 0n ||
    INVALID_CODEHASHES.has(pin.peripheryRuntimeCodehash.toLowerCase())
  )
    throw new Error(`The pin for ${pin.address} has no deployed periphery`);
}

function sameQuote(a: ZeroSeedLaunchQuote, b: ZeroSeedLaunchQuote) {
  if (a.kind !== b.kind || !same(a.address, b.address)) return false;
  return (
    a.kind === "native" ||
    (b.kind === "erc20" && same(a.runtimeCodehash, b.runtimeCodehash))
  );
}

function checkConstructorProvenance(pin: ZeroSeedLaunchPin) {
  const reviewed = ZERO_SEED_LAUNCH_PINS.find(
    (p) => p.chainId === pin.chainId && same(p.address, pin.address),
  );
  if (
    !reviewed ||
    !sameQuote(reviewed.quote, pin.quote) ||
    !same(reviewed.core, pin.core) ||
    !same(reviewed.runtimeCodehash, pin.runtimeCodehash) ||
    !same(reviewed.periphery, pin.periphery) ||
    !same(reviewed.peripheryRuntimeCodehash, pin.peripheryRuntimeCodehash) ||
    reviewed.deploymentBlock !== pin.deploymentBlock ||
    reviewed.local !== pin.local
  )
    throw new Error(
      "ZeroSeedLaunch instance/periphery/constructor quote/runtime provenance is not reviewed",
    );
}

/** Used by all launch event entrypoints, not just swap routing. */
export function zeroSeedLaunchPinForAddress(
  address: string,
): ZeroSeedLaunchPin | undefined {
  return ZERO_SEED_LAUNCH_PINS.find((pin) => same(pin.address, address));
}

/**
 * The launch deployment to index, or undefined to leave launch support off.
 *
 * Off when the address or codehash is missing, or the chain has no pin. A
 * mismatch against a pin for the chain, an invalid codehash, or a local pin in
 * production refuses to start: the operator asked for something the reviewed
 * pins do not allow.
 */
export function resolveZeroSeedLaunchPin(
  env: ZeroSeedLaunchEnv,
): ZeroSeedLaunchPin | undefined {
  const { address, runtimeCodehash, chainId } = env;
  const pins = env.pins ?? ZERO_SEED_LAUNCH_PINS;
  const warn = env.warn ?? (() => {});
  if (!address) return undefined;
  if (!runtimeCodehash) {
    warn(
      "ZERO_SEED_LAUNCH_ADDRESS is set without ZERO_SEED_LAUNCH_RUNTIME_CODEHASH; launch indexing is off",
    );
    return undefined;
  }
  if (INVALID_CODEHASHES.has(runtimeCodehash.toLowerCase()))
    throw new Error(
      `ZERO_SEED_LAUNCH_RUNTIME_CODEHASH ${runtimeCodehash} is not a deployed runtime`,
    );

  const chainPins = pins.filter((pin) => pin.chainId === chainId);
  const pin = chainPins.find((p) => same(p.address, address));
  if (!pin) {
    if (chainPins.length > 0)
      throw new Error(
        `ZERO_SEED_LAUNCH_ADDRESS ${address} is not a pinned launch for chain ${chainId}`,
      );
    warn(`No ZeroSeedLaunch pin for chain ${chainId}; launch indexing is off`);
    return undefined;
  }
  checkPin(pin, env);
  return pin;
}

/** The extension address of {@link resolveZeroSeedLaunchPin}. */
export function resolveZeroSeedLaunchAddress(
  env: ZeroSeedLaunchEnv,
): `0x${string}` | undefined {
  return resolveZeroSeedLaunchPin(env)?.address;
}
