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
  /** A local fixture chain; never accepted in production. */
  local: boolean;
  source: string;
}

/**
 * No live deployment is pinned. The only entry is the local anvil fixture the
 * tests replay, which production refuses.
 */
export const ZERO_SEED_LAUNCH_PINS: readonly ZeroSeedLaunchPin[] = [
  {
    chainId: 31337n,
    address: "0x51bb9650e2f2fd1d05bc22d2c76cb7550d5b66e9",
    runtimeCodehash:
      "0xdbab7bddcb5767d59db958f32d964e458764a79604a6cef74c11902e794699a4",
    abiSha256: ZERO_SEED_LAUNCH_ABI_SHA256,
    local: true,
    source:
      "tests/fixtures/zero-seed-launch/local-chain.json: anvil, evm-contracts 39ca1918, no fork",
  },
];

/**
 * Codehashes that cannot identify a deployment: empty code, and the build's
 * runtime with its immutables (Core) zero-filled.
 */
const INVALID_CODEHASHES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  "0x16d2d4ce55576f418d94b9dcef3e9d4950a0d3f1573af639f1387e1d6b74c319",
]);

export interface ZeroSeedLaunchEnv {
  /** Unknown (no CHAIN_ID) matches no pin. */
  chainId?: bigint;
  address?: `0x${string}`;
  runtimeCodehash?: `0x${string}`;
  production: boolean;
  pins?: readonly ZeroSeedLaunchPin[];
  warn?: (message: string) => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function checkPin(pin: ZeroSeedLaunchPin, env: ZeroSeedLaunchEnv) {
  if (!same(pin.runtimeCodehash, env.runtimeCodehash!))
    throw new Error(
      `ZERO_SEED_LAUNCH_RUNTIME_CODEHASH does not match the pin for ${pin.address} on chain ${pin.chainId}`,
    );
  if (pin.abiSha256 !== ZERO_SEED_LAUNCH_ABI_SHA256)
    throw new Error(
      `The pin for ${pin.address} is for ABI ${pin.abiSha256}, not the compiled ${ZERO_SEED_LAUNCH_ABI_SHA256}`,
    );
  if (pin.local && env.production)
    throw new Error(
      `The pin for ${pin.address} is a local fixture and cannot be used in production`,
    );
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
