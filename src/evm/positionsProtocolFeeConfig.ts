import type { HexAddress } from "../_shared/loadHexAddresses";

export interface PositionsContractProtocolFeeConfig {
  address: HexAddress;
  swapProtocolFee: bigint;
  withdrawalProtocolFeeDivisor: bigint;
}

const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]+$/;
const FIXED_POINT_FEE_DENOMINATOR = 1n << 64n;

export function parsePositionsProtocolFeeConfigs(
  raw: string | undefined
): PositionsContractProtocolFeeConfig[] | undefined {
  if (!raw) return undefined;

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) return undefined;

  return entries.map((entry) => {
    const [addressRaw, swapFeeRaw, withdrawalDivisorRaw] = entry
      .split(":")
      .map((value) => value.trim());

    if (!addressRaw)
      throw new Error(
        `Invalid positions protocol fee config entry "${entry}". Expected "address:swapProtocolFee[:withdrawalProtocolFeeDivisor]".`
      );

    if (!HEX_ADDRESS_REGEX.test(addressRaw))
      throw new Error(
        `Invalid positions contract address "${addressRaw}" in protocol fee config "${entry}".`
      );

    const swapProtocolFee =
      swapFeeRaw !== undefined && swapFeeRaw !== "" ? BigInt(swapFeeRaw) : 0n;
    if (swapProtocolFee < 0n || swapProtocolFee >= FIXED_POINT_FEE_DENOMINATOR)
      throw new Error(
        `Swap protocol fee must be between 0 and ${
          FIXED_POINT_FEE_DENOMINATOR - 1n
        } (inclusive). Entry: "${entry}".`
      );

    const withdrawalProtocolFeeDivisor =
      withdrawalDivisorRaw !== undefined && withdrawalDivisorRaw !== ""
        ? BigInt(withdrawalDivisorRaw)
        : 0n;
    if (withdrawalProtocolFeeDivisor < 0n)
      throw new Error(
        `Withdrawal protocol fee divisor must be >= 0. Entry: "${entry}".`
      );

    return {
      address: addressRaw as HexAddress,
      swapProtocolFee,
      withdrawalProtocolFeeDivisor,
    };
  });
}
