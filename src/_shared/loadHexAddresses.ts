const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]+$/;

export type HexAddress = `0x${string}`;

type EnvSource = Partial<Record<keyof NodeJS.ProcessEnv, string>> &
  Record<string, string | undefined>;

export function loadHexAddresses<
  T extends Record<string, keyof NodeJS.ProcessEnv>
>(
  envMap: T,
  env: EnvSource = process.env
): { [K in keyof T]: HexAddress } | undefined {
  const resolved = {} as { [K in keyof T]: HexAddress };

  for (const [alias, envName] of Object.entries(envMap) as [keyof T, T[keyof T]][]) {
    const rawValue = env[envName];

    if (typeof rawValue !== "string") {
      return undefined;
    }

    const trimmedValue = rawValue.trim();

    if (!HEX_ADDRESS_REGEX.test(trimmedValue)) {
      return undefined;
    }

    resolved[alias] = trimmedValue as HexAddress;
  }

  return resolved;
}
