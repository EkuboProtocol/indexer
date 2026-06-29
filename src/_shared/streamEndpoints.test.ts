import { describe, expect, it } from "bun:test";
import { requireEvmRpcUrl, requireStarknetApibaraUrl } from "./streamEndpoints";

describe("requireEvmRpcUrl", () => {
  it("returns a trimmed value", () => {
    expect(requireEvmRpcUrl(" https://evm.rpc ")).toBe("https://evm.rpc");
  });

  it("throws when missing", () => {
    expect(() => requireEvmRpcUrl(undefined)).toThrow("Missing EVM_RPC_URL");
    expect(() => requireEvmRpcUrl("   ")).toThrow("Missing EVM_RPC_URL");
  });
});

describe("requireStarknetApibaraUrl", () => {
  it("returns a trimmed value", () => {
    expect(requireStarknetApibaraUrl(" https://starknet.preview.apibara.org ")).toBe(
      "https://starknet.preview.apibara.org",
    );
  });

  it("throws when missing", () => {
    expect(() => requireStarknetApibaraUrl(undefined)).toThrow(
      "Missing APIBARA_URL",
    );
    expect(() => requireStarknetApibaraUrl("   ")).toThrow(
      "Missing APIBARA_URL",
    );
  });
});
