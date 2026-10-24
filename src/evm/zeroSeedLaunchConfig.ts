import {
  ZERO_SEED_LAUNCH_ABI_SHA256,
  ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
} from "./abis_zero_seed_launch";
import {
  ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI_SHA256,
  ZERO_SEED_LAUNCH_V2_ABI_SHA256,
} from "./abis_zero_seed_launch_v2";

/**
 * The fee math and LaunchParameters/LaunchCreated shape of a deployment's
 * contract revision, fixed for the life of the deployment:
 *   fixed_base_duration_v1  evm-contracts 43d6628, uint32 feeDuration
 *   tick_rate_v2            evm-contracts 3d6378f, uint64 decayRateX32
 * It is never inferred from an event: a log is decoded only with its pin's ABI.
 */
export type ZeroSeedLaunchFeeModel = "fixed_base_duration_v1" | "tick_rate_v2";

/** The ABI hashes each fee model's extension and periphery must have. */
export const ZERO_SEED_LAUNCH_MODEL_ABI_SHA256: Record<
  ZeroSeedLaunchFeeModel,
  { extension: string; periphery: string }
> = {
  fixed_base_duration_v1: {
    extension: ZERO_SEED_LAUNCH_ABI_SHA256,
    periphery: ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
  },
  tick_rate_v2: {
    extension: ZERO_SEED_LAUNCH_V2_ABI_SHA256,
    periphery: ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI_SHA256,
  },
};

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
  feeModel: ZeroSeedLaunchFeeModel;
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
 * No live deployment is pinned. The entries are the local instances of the
 * replay fixtures (anvil, no fork), one per fee model, each serving both a
 * native-ETH and an ERC-20 quote launch. Production refuses them.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [
  {
    chainId: 31337n,
    feeModel: "fixed_base_duration_v1",
    address: "0x519c5f793d3f6cf9ee439e4cc38d8285cf08211f",
    runtimeCodehash:
      "0xd6b4c7ce8da56e9948fdb004a035d9b52dbd3690bcb03c1269bbf2a9981d8ed5",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    periphery: "0x0df4e2a76640b52e51479b435f52d0eb0e7e8ef4",
    peripheryRuntimeCodehash:
      "0x2a9329dbb064a2c031115c7c120c8b6a1f31de167f33374180e4dc73d975974b",
    peripheryAbiSha256: ZERO_SEED_LAUNCH_PERIPHERY_ABI_SHA256,
    core: "0x00000000000014aa86c5d3c41765bb24e11bd701",
    deploymentBlock: 2,
    local: true,
    source:
      "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts 43d6628, constructor-executed, no fork",
  },
  {
    chainId: 31337n,
    feeModel: "tick_rate_v2",
    address: "0x5135fd3e9a6056937eaf6b99454bbc2198c2263d",
    runtimeCodehash:
      "0xe08ad382497fc9825956c2b4e9ccf463014c4ed65baf50c0a59db8d7b7aedfc3",
    abiSha256: ZERO_SEED_LAUNCH_V2_ABI_SHA256,
    periphery: "0xfb2e7927d3e4984dca3e390526d43c6f5a3461e9",
    peripheryRuntimeCodehash:
      "0xf72d3cd6b99e1b64f0b08c0f6933b4f8adb92464ded48c51bfb7d2805c09d667",
    peripheryAbiSha256: ZERO_SEED_LAUNCH_PERIPHERY_V2_ABI_SHA256,
    core: "0x00000000000014aa86c5d3c41765bb24e11bd701",
    deploymentBlock: 2,
    local: true,
    source:
      "tests/fixtures/zero-seed-launch/local-chain-v2.json: anvil, evm-contracts 3d6378f, constructor-executed, no fork",
  },
];

/**
 * Codehashes that cannot identify a deployment: empty code, and the build's
 * runtimes with their immutables zero-filled (extension and periphery).
 */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  "0x19d7461a57e0058bd09c848684152a234b4b3909404c1c85dbf6e69b9d59c925",
  "0x76db610aa6d183253d966ff21d2c59f750028b9ad83c0e4cc0d362324740e2e7",
  "0xae9245361f958f479a4ff1a85ca242f6adf3ae21b3e1f3696317368ba8c47c3b",
  "0x1fa935c3de39691b912dd3db3ef84d7e66cc0e54dddef3740aeb1d453e6ad3f8",
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
  const expected = ZERO_SEED_LAUNCH_MODEL_ABI_SHA256[pin.feeModel];
  if (
    !expected ||
    pin.abiSha256 !== expected.extension ||
    pin.peripheryAbiSha256 !== expected.periphery
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
    reviewed.feeModel !== pin.feeModel ||
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
