import { ZERO_SEED_LAUNCH_ABI_SHA256 } from "./abis_zero_seed_launch";

/**
 * A ZeroSeedLaunch deployment the indexer may decode. The indexer makes no
 * provider call to check a deployment: the operator's address and runtime
 * codehash must equal an entry here, which is reviewed with the code.
 */
export interface ZeroSeedLaunchPin {
  chainId: bigint;
  address: `0x${string}`;
  runtimeCodehash: `0x${string}`;
  abiSha256: string;
  core: `0x${string}`;
  quoteToken: `0x${string}`;
  quoteRuntimeCodehash: `0x${string}`;
  /** A local fixture chain; never accepted in production. */
  local: boolean;
  source: string;
}

/**
 * No live deployment is pinned. Only the constructor-executed, relocated
 * plain-WETH instances are supported locally. Synthetic 6-decimal arithmetic
 * fixtures are deliberately absent. Production refuses both local entries.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [
  {
    chainId: 31337n,
    address: "0x510d7c117adeeb89bb33b9acb53995f3280eaa3a",
    runtimeCodehash:
      "0x8d8839b97583f275a84aaf26cd6a5fa3ba21a7be04731a65f6140fc5040477c4",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    core: "0x00000000000014aa86c5d3c41765bb24e11bd701",
    quoteToken: "0xffffffffffffffffffffffffffffffffffffffff",
    quoteRuntimeCodehash: "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c",
    local: true,
    source:
      "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts d6aeb58d, constructor (Core, high WETH), no fork",
  },
  {
    chainId: 31337n,
    address: "0x5195c03d30c11be73485ab76a35eb6f59fc52072",
    runtimeCodehash: "0x8751bab213ba226c4e45f6441b9df2db1f9c8ee9e9335320e180f3b348646014",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    core: "0x00000000000014aa86c5d3c41765bb24e11bd701",
    quoteToken: "0x0000000000000000000000000000000000010000",
    quoteRuntimeCodehash: "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c",
    local: true,
    source: "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts d6aeb58d, constructor (Core, low WETH), no fork",
  },
];

/**
 * Codehashes that cannot identify a deployment: empty code, and the build's
 * runtime with its immutables (Core and quote) zero-filled.
 */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  "0xa85c864302696dce32b5e2452508219bb08323c142b40fb7c487540db3f75d89",
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
    throw new Error("ZeroSeedLaunch Core does not match constructor provenance");
  if (!pin.quoteToken || BigInt(pin.quoteToken) === 0n ||
      pin.quoteRuntimeCodehash !== "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c")
    throw new Error("ZeroSeedLaunch quote lacks plain-WETH runtime provenance");
  if (!same(pin.runtimeCodehash, env.runtimeCodehash!))
    throw new Error(
      `ZERO_SEED_LAUNCH_RUNTIME_CODEHASH does not match the pin for ${pin.address} on chain ${pin.chainId}`,
    );
  if (pin.abiSha256 !== ZERO_SEED_LAUNCH_ABI_SHA256)
    throw new Error(
      `The pin for ${pin.address} is for ABI ${pin.abiSha256}, not the compiled ${ZERO_SEED_LAUNCH_ABI_SHA256}`,
    );
  checkConstructorProvenance(pin);
  if (pin.local && env.production)
    throw new Error(
      `The pin for ${pin.address} is a local fixture and cannot be used in production`,
    );
}

function checkConstructorProvenance(pin: ZeroSeedLaunchPin) {
  const reviewed = ZERO_SEED_LAUNCH_PINS.find((p) => p.chainId === pin.chainId && same(p.address, pin.address));
  if (!reviewed || !same(reviewed.quoteToken, pin.quoteToken) ||
      !same(reviewed.core, pin.core) || !same(reviewed.runtimeCodehash, pin.runtimeCodehash) ||
      reviewed.local !== pin.local)
    throw new Error("ZeroSeedLaunch instance/constructor quote/runtime provenance is not reviewed");
}

/** Used by all launch event entrypoints, not just swap routing. */
export function zeroSeedLaunchPinForAddress(address: string): ZeroSeedLaunchPin | undefined {
  return ZERO_SEED_LAUNCH_PINS.find((pin) => same(pin.address, address));
}

/**
 * The launch address to index, or undefined to leave launch support off.
 *
 * Off when the address or codehash is missing, or the chain has no pin. A
 * mismatch against a pin for the chain, an invalid codehash, or a local pin in
 * production refuses to start: the operator asked for something the reviewed
 * pins do not allow.
 */
export function resolveZeroSeedLaunchAddress(
  env: ZeroSeedLaunchEnv,
): `0x${string}` | undefined {
  const { address, runtimeCodehash, chainId } = env;
  const pins = env.pins ?? ZERO_SEED_LAUNCH_PINS;
  const warn = env.warn ?? (() => {});
  if (!address) return undefined;
  if (!runtimeCodehash) {
    warn("ZERO_SEED_LAUNCH_ADDRESS is set without ZERO_SEED_LAUNCH_RUNTIME_CODEHASH; launch indexing is off");
    return undefined;
  }
  if (INVALID_CODEHASHES.has(runtimeCodehash.toLowerCase()))
    throw new Error(`ZERO_SEED_LAUNCH_RUNTIME_CODEHASH ${runtimeCodehash} is not a deployed runtime`);

  const chainPins = pins.filter((pin) => pin.chainId === chainId);
  const pin = chainPins.find((p) => same(p.address, address));
  if (!pin) {
    if (chainPins.length > 0)
      throw new Error(`ZERO_SEED_LAUNCH_ADDRESS ${address} is not the pinned launch for chain ${chainId}`);
    warn(`No ZeroSeedLaunch pin for chain ${chainId}; launch indexing is off`);
    return undefined;
  }
  checkPin(pin, env);
  return pin.address;
}
