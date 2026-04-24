const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]+$/;

export type HexAddress = `0x${string}`;

function parseHexAddress(value: string): HexAddress | undefined {
  const trimmedValue = value.trim();

  return HEX_ADDRESS_REGEX.test(trimmedValue)
    ? (trimmedValue as HexAddress)
    : undefined;
}

export function loadOptionalHexAddress(
  envName: string,
  env: Record<string, string | undefined> = process.env
): HexAddress | undefined {
  const rawValue = env[envName];

  if (typeof rawValue !== "string") {
    return undefined;
  }

  const address = parseHexAddress(rawValue);

  if (!address) {
    throw new Error(`Invalid hex address for ${envName}: "${rawValue}"`);
  }

  return address;
}

export function loadHexAddresses<
  EnvType extends Record<string, string | undefined>,
  T extends Record<string, keyof EnvType>
>(
  envMap: T,
  env: Record<string, string | undefined> = process.env
): { [K in keyof T]: HexAddress } | undefined {
  const resolved = {} as { [K in keyof T]: HexAddress };

  for (const [alias, envName] of Object.entries(envMap) as [
    keyof T,
    T[keyof T]
  ][]) {
    const rawValue = env[envName as string];
    const address =
      typeof rawValue === "string" ? parseHexAddress(rawValue) : undefined;

    if (!address) {
      return undefined;
    }

    resolved[alias] = address;
  }

  return resolved;
}
