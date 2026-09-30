import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { createPublicClient, http } from "viem";
import { PriceSyncError } from "./errors";
import { installLogRedaction, redactPriceSyncLog } from "./redactLogs";

const ALCHEMY_KEY = "FakeAlchemyKey0123456789abcdefXY";
const COINGECKO_KEY = "CG-FakeCoinGeckoKey0123456";
// Port 9 (discard) on loopback refuses the connection, so viem fails fast with
// its real HttpRequestError, URL included.
const rpcUrl = `http://127.0.0.1:9/v2/${ALCHEMY_KEY}`;
const env = {
  CHAINLINK_TOKEN_PRICE_CONFIG: JSON.stringify({
    1: { rpcUrls: [rpcUrl], catalogUrl: "https://catalog.example/feeds.json" },
  }),
  COINGECKO_API_KEY: COINGECKO_KEY,
};

async function viemError(url: string): Promise<Error> {
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  try {
    await client.request({ method: "eth_chainId" } as never);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

function capturingConsole() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const target = {
    ...globalThis.console,
    log: write,
    info: write,
    warn: write,
    error: write,
    debug: write,
    trace: write,
  } as Console.Console & globalThis.Console;
  return { target, output: () => lines.join("\n") };
}

describe("redactPriceSyncLog", () => {
  it("replaces configured RPC URLs with their origin and masks the CoinGecko key", () => {
    expect(
      redactPriceSyncLog(`URL: ${rpcUrl} header: ${COINGECKO_KEY}`, env),
    ).toBe("URL: http://127.0.0.1:9/<redacted> header: <redacted>");
  });

  it("still masks the key when the config does not parse", () => {
    const out = redactPriceSyncLog(
      `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      { CHAINLINK_TOKEN_PRICE_CONFIG: "{not json" },
    );
    expect(out).toBe("https://eth-mainnet.g.alchemy.com/v2/<redacted>");
  });

  it("leaves the catalog URL and quota monitor lines alone", () => {
    const text =
      "https://catalog.example/feeds.json COINGECKO_CREDITS plan=Analyst limit=500000 used=1 remaining=499999 remaining_pct=99.9";
    expect(redactPriceSyncLog(text, env)).toBe(text);
  });
});

describe("the price-sync console", () => {
  it("redacts a real viem error on every Effect log path", async () => {
    const { target, output } = capturingConsole();
    const restore = installLogRedaction(target, env);
    try {
      const failure = await viemError(rpcUrl);
      expect(failure.message).toContain(ALCHEMY_KEY);
      const wrapped = new PriceSyncError({
        source: "chainlink",
        operation: "read feed prices for chain 1",
        cause: failure,
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          // worker.ts runCycle and chainlink.ts feed discovery.
          yield* Effect.logError(`Price sync job clk:1 failed: ${wrapped.message}`);
          yield* Effect.logWarning(
            `Chainlink feed discovery failed for chain 1; using 0 configured feeds: ${wrapped.message}`,
          );
          // ekuboQuoter.ts: the bare message.
          yield* Effect.logWarning(wrapped.message);
          // A defect and a failure carried as the log's cause, as runMain reports them.
          yield* Effect.logError("crashed", failure);
          yield* Effect.logError(wrapped);
          yield* Effect.die(failure).pipe(
            Effect.catchCause((cause) => Effect.logError("main failed", cause)),
          );
          yield* Effect.logWarning("annotated").pipe(
            Effect.annotateLogs({ url: rpcUrl }),
          );
        }).pipe(Effect.provideService(Console.Console, target)),
      );

      const text = output();
      expect(text).toContain("Price sync job clk:1 failed");
      expect(text).toContain("<redacted>");
      expect(text).not.toContain(ALCHEMY_KEY);
    } finally {
      restore();
    }
  });

  it("redacts the direct console.warn for a failed feed, cause included", async () => {
    const { target, output } = capturingConsole();
    const restore = installLogRedaction(target, env);
    try {
      const failure = await viemError(rpcUrl);
      // chainlinkFeeds.ts
      target.warn(
        "Failed to fetch Chainlink price for 0xabc on chain 1",
        new Error("multicall failed", { cause: failure }),
      );
      target.error({ nested: { url: rpcUrl, key: COINGECKO_KEY } });

      const text = output();
      expect(text).toContain("Failed to fetch Chainlink price");
      expect(text).toContain("<redacted>");
      expect(text).not.toContain(ALCHEMY_KEY);
      expect(text).not.toContain(COINGECKO_KEY);
    } finally {
      restore();
    }
  });
});

const repoRoot = join(import.meta.dir, "../..");

async function run(command: string[], extraEnv: Record<string, string>, runForMs?: number) {
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "",
      // Every outbound HTTPS request (Sushi, the quoter) fails at a dead proxy,
      // so nothing leaves the machine; the loopback RPC is reached directly.
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      ...env,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = runForMs === undefined ? undefined : setTimeout(() => child.kill("SIGTERM"), runForMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearTimeout(timer);
  return stdout + stderr;
}

describe("the price-sync worker process", () => {
  it(
    "writes no key to stdout or stderr while its RPC and database fail",
    async () => {
      const output = await run(["bun", "src/price-sync/index.ts"], {
        PG_CONNECTION_STRING: `postgres://user:pw@127.0.0.1:9/db`,
        TOKEN_PRICE_SYNC_INTERVAL_MS: "60000",
        COINGECKO_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "0",
        CHAINLINK_TOKEN_PRICE_SYNC_INTERVAL_SECONDS: "1",
        // An explicit feed, so the job reads the RPC without the database.
        CHAINLINK_TOKEN_PRICE_CONFIG: JSON.stringify({
          1: {
            rpcUrls: [rpcUrl],
            feeds: [
              {
                tokenAddress: "0x0000000000000000000000000000000000000001",
                feedAddress: "0x0000000000000000000000000000000000000002",
                maxAgeSeconds: 3600,
              },
            ],
          },
        }),
      }, 4_000);

      // The line that would carry the key: viem prints the endpoint it failed on.
      expect(output).toContain("Price sync job 1:cl1 failed");
      expect(output).toContain("URL: http://127.0.0.1:9/<redacted>");
      expect(output).not.toContain(ALCHEMY_KEY);
      expect(output).not.toContain(COINGECKO_KEY);
    },
    15_000,
  );

  it("redacts an uncaught exception and an unhandled rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "price-sync-redaction-"));
    const console_ = join(import.meta.dir, "redactedConsole.ts");
    const throws = join(dir, "throws.ts");
    const rejects = join(dir, "rejects.ts");
    writeFileSync(
      throws,
      `import ${JSON.stringify(console_)};\nsetTimeout(() => { throw new Error("boom ${rpcUrl}"); });\n`,
    );
    writeFileSync(
      rejects,
      `import ${JSON.stringify(console_)};\nPromise.reject(new Error("boom", { cause: new Error("${rpcUrl}") }));\n`,
    );

    for (const script of [throws, rejects]) {
      const output = await run(["bun", script], {});
      expect(output).toContain("<redacted>");
      expect(output).not.toContain(ALCHEMY_KEY);
    }
  }, 15_000);
});
