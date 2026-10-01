import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { isProduction, requireDeployedRpcUrl } from "./config";

const ROOT = join(import.meta.dir, "..");

/**
 * A clean environment for a child process: nothing inherited from the shell
 * running the tests, so an `EVM_RPC_URL` exported there cannot mask the case.
 * The database is unreachable, so a worker that got past the check would fail
 * with a different error.
 */
function childEnv(vars: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PG_CONNECTION_STRING: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
    ...vars,
  };
}

function run(cmd: string[], vars: Record<string, string>) {
  const child = Bun.spawnSync(cmd, { cwd: ROOT, env: childEnv(vars), timeout: 30_000 });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

describe("isProduction", () => {
  it("matches the image's value and the app spec's, ignoring case", () => {
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "PRODUCTION" })).toBe(true);
    expect(isProduction({})).toBe(false);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
    expect(isProduction({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("requireDeployedRpcUrl", () => {
  for (const [networkType, name] of [["evm", "EVM_RPC_URL"], ["starknet", "STARKNET_RPC_URL"]] as const) {
    it(`requires ${name} in a production environment`, () => {
      for (const value of [undefined, "", "  "]) {
        expect(() => requireDeployedRpcUrl(networkType, { NODE_ENV: "PRODUCTION", [name]: value })).toThrow(
          `Missing ${name}`,
        );
      }
      expect(() =>
        requireDeployedRpcUrl(networkType, { NODE_ENV: "PRODUCTION", [name]: "https://rpc.example/v2/key" }),
      ).not.toThrow();
    });

    it(`leaves ${name} to the .env files outside production`, () => {
      expect(() => requireDeployedRpcUrl(networkType, {})).not.toThrow();
      expect(() => requireDeployedRpcUrl(networkType, { NODE_ENV: "development" })).not.toThrow();
    });
  }
});

describe("worker startup without an RPC URL in the environment", () => {
  for (const [entrypoint, name, network] of [
    ["src/evm.ts", "EVM_RPC_URL", "base-mainnet"],
    ["src/starknet.ts", "STARKNET_RPC_URL", "mainnet"],
  ] as const) {
    it(`${entrypoint} exits naming ${name} in production`, () => {
      const result = run(["bun", entrypoint], { NODE_ENV: "PRODUCTION", NETWORK: network });
      expect(result.exitCode).not.toBe(0);
      // The logger reports the uncaught error as JSON on stdout.
      expect(result.stdout + result.stderr).toContain(`Missing ${name}: in production`);
    });
  }

  it("takes the committed default outside production", () => {
    const fileDefault = parse(readFileSync(join(ROOT, ".env.evm.base-mainnet"))).EVM_RPC_URL;
    expect(fileDefault).toBeTruthy();
    const script = `
      import { loadConfig, requireDeployedRpcUrl } from "./src/config";
      requireDeployedRpcUrl("evm");
      loadConfig("evm");
      console.log(JSON.stringify(process.env.EVM_RPC_URL));
    `;
    const result = run(["bun", "-e", script], { NETWORK: "base-mainnet" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toBe(fileDefault);
  });
});
