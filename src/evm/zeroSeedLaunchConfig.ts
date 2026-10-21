import {
  ZERO_SEED_LAUNCH_ABI_SHA256,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
} from "./abis_zero_seed_launch";

/**
 * A ZeroSeedLaunch deployment the indexer may decode: the extension and the
 * periphery that forwards creations and claims to it (the launch controller
 * that records transferable owners). An instance has no quote: every launch
 * names its own in LaunchParameters.quoteToken (address 0 is native ETH), and
 * one extension and periphery serve every quote. The indexer records each
 * launch with its quote; which quotes are supported is a reader's policy.
 *
 * The indexer makes no provider call to check a deployment: the operator's
 * extension address and runtime codehash must equal an entry here, which is
 * reviewed with the code, and the periphery comes from the same entry, never
 * from configuration.
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
  /** First block to index, inclusive: the block that deployed the extension. */
  deploymentBlock: number;
  /** A local fixture chain; never accepted in production. */
  local: boolean;
  source: string;
}

/**
 * No live deployment is pinned. The only entry is the local instance of the
 * replay fixture (anvil, evm-contracts 40af6cb, no fork), which serves both a
 * native-ETH and an ERC-20 quote launch. Production refuses it.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [
  {
    chainId: 31337n,
    address: "0x519ddb6580e97e08e639d601dc6e378285c3ef34",
    runtimeCodehash:
      "0x32160cd19576b73812a6c557ca8f9697ac1c3cd821576afc70e9a9b00bf888be",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    periphery: "0x094511cf93e73feca154da35a2404e8bde1111b4",
    peripheryRuntimeCodehash:
      "0x91a98d2669389244ad8553d84f5c7e3c2947d5d4b5abb519be93d68142cce7c1",
    peripheryAbiSha256: ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
    core: "0x00000000000014aa86c5d3c41765bb24e11bd701",
    deploymentBlock: 2,
    local: true,
    source:
      "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts 40af6cb, constructor-executed, no fork",
  },
];

/**
 * Codehashes that cannot identify a deployment: empty code, and the build's
 * runtimes with their immutables zero-filled (extension and periphery).
 */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  "0x39a99e30dfff34873b7a820416ae4bc33a337612c644c45e68c51ac6564a9f4d",
  "0x08216f696368b4398afb8c43ca3eff0cccdcea00e71397178b78b2b94f957dbb",
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

function checkPin(pin: ZeroSeedLaunchPin, env: ZeroSeedLaunchEnv) {
  if (!env.coreAddress || !same(pin.core, env.coreAddress))
    throw new Error(
      "ZeroSeedLaunch Core does not match constructor provenance",
    );
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

function checkConstructorProvenance(pin: ZeroSeedLaunchPin) {
  const reviewed = ZERO_SEED_LAUNCH_PINS.find(
    (p) => p.chainId === pin.chainId && same(p.address, pin.address),
  );
  if (
    !reviewed ||
    !same(reviewed.core, pin.core) ||
    !same(reviewed.runtimeCodehash, pin.runtimeCodehash) ||
    !same(reviewed.periphery, pin.periphery) ||
    !same(reviewed.peripheryRuntimeCodehash, pin.peripheryRuntimeCodehash) ||
    reviewed.deploymentBlock !== pin.deploymentBlock ||
    reviewed.local !== pin.local
  )
    throw new Error(
      "ZeroSeedLaunch instance/periphery/Core/runtime provenance is not reviewed",
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
