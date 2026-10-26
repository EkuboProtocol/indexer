/**
 * A ZeroSeedLaunch deployment of evm-contracts 853b608 the indexer may
 * decode: the extension and the periphery that forwards creations and claims
 * to it and records transferable owners. One instance serves every quote:
 * each launch names its own in LaunchParameters.quoteToken (address 0 is
 * native ETH). Logs are decoded only with the frozen ABIs of that commit.
 *
 * The indexer makes no provider call to check a deployment: the operator's
 * extension address and runtime codehash must equal a reviewed pin, and the
 * periphery comes from the same pin, never from configuration.
 */
export interface ZeroSeedLaunchPin {
  chainId: bigint;
  address: `0x${string}`;
  runtimeCodehash: `0x${string}`;
  periphery: `0x${string}`;
  core: `0x${string}`;
  /** First block to index, inclusive: the block that deployed the extension. */
  deploymentBlock: number;
  /** A local fixture chain; never accepted in production. */
  local: boolean;
  source: string;
}

/**
 * The final contract has no deployment yet, so nothing is pinned and launch
 * indexing is off everywhere. Tests inject the local pin of their fixture
 * chain through {@link ZeroSeedLaunchEnv.pins}. Historical deployments of
 * earlier launch drafts are not entries: their ABIs differ and their events
 * would be misread.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [];

/** Codehashes that cannot identify a deployment: none, and empty code. */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
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
    throw new Error("ZeroSeedLaunch Core does not match the pin");
  if (!same(pin.runtimeCodehash, env.runtimeCodehash!))
    throw new Error(
      `ZERO_SEED_LAUNCH_RUNTIME_CODEHASH does not match the pin for ${pin.address} on chain ${pin.chainId}`,
    );
  if (
    BigInt(pin.periphery) === 0n ||
    INVALID_CODEHASHES.has(pin.runtimeCodehash.toLowerCase())
  )
    throw new Error(`The pin for ${pin.address} has no deployed contracts`);
  if (pin.local && env.production)
    throw new Error(
      `The pin for ${pin.address} is a local fixture and cannot be used in production`,
    );
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
