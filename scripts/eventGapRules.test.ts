import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  ERROR_MAX_LENGTH,
  checkError,
  createRedactor,
  elide,
} from "./eventGapRules";

// Shaped like real keys, under paths the shared log patterns do not cover, so
// only the monitor's own redaction can keep them out.
const EVM_KEY = "FakeProviderKey0123456789abcdef";
const STARKNET_KEY = "FakeStarknetKey9876543210";
const PG_PASSWORD = "FakePgPassword0123";
const evmUrl = `https://rpc.provider.example/fake-provider/${EVM_KEY}`;
const starknetUrl = `https://starknet.provider.example/starknet/${STARKNET_KEY}`;
const pgUrl = `postgresql://monitor:${PG_PASSWORD}@db.example:25060/indexer?sslmode=require`;
const redact = createRedactor({
  rpcUrls: [evmUrl, starknetUrl, "https://public.example"],
  pgConnectionString: pgUrl,
});

const banners = [
  ".env.evm.bsc-mainnet.local",
  ".env.evm.bsc-mainnet",
  ".env.evm",
  ".env",
]
  .map((file) => `◇ injected env (3) from ${file}`)
  .join("\n");
const addressConfig = JSON.stringify({
  level: "info",
  message: "Indexing V3 EVM contracts",
  service: "ekubo-indexer",
  v3AddressConfig: {
    coreAddress: "0x00000000000014aA86C5d3c41765bb24e11bd701",
    oracleAddress: "0x517E506700271AEa091b02f42756F5E174Af5230",
  },
});
const uncaught = (message: string) =>
  JSON.stringify({
    level: "error",
    message: `Uncaught exception ${message}`,
    service: "ekubo-indexer",
    stack: `Error: ${message}\n    at request (/srv/indexer/src/starknet/eventStream.ts:455:20)`,
  });
const viemMessage = (url: string) =>
  [
    "HTTP request failed.",
    "",
    "Status: 401",
    `URL: ${url}`,
    'Request body: {"method":"eth_chainId"}',
    "",
    `Details: "Cannot POST ${new URL(url).pathname}"`,
    "Version: viem@2.57.13",
  ].join("\n");

describe("checkError", () => {
  it("reports the exception the audit logged, not the output around it", () => {
    const stdout = `${addressConfig}\n${uncaught("starknet_chainId failed with HTTP 401")}\n`;
    expect(checkError("exit 1", stdout, banners, redact)).toBe(
      "exit 1, no summary: Uncaught exception starknet_chainId failed with HTTP 401",
    );
  });

  it("joins a viem message and redacts its URL and the echoed key", () => {
    const stdout = `${addressConfig}\n${uncaught(viemMessage(evmUrl))}\n`;
    const error = checkError("exit 1", stdout, banners, redact);
    expect(error).toBe(
      'exit 1, no summary: Uncaught exception HTTP request failed. | Status: 401 | URL: <redacted rpc url> | Request body: {"method":"eth_chainId"} | Details: "Cannot POST /fake-provider/<redacted>" | Version: viem@2.57.13',
    );
  });

  it("falls back to Bun's own report, without its excerpt, stack and trailer", () => {
    const stderr = [
      banners,
      "1 | await fetch(url);",
      "    ^",
      "TypeError: ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
      `  path: "${starknetUrl}",`,
      " errno: 0,",
      '  code: "ECONNREFUSED"',
      "      at createAuditAdapter (/srv/indexer/scripts/auditEventGaps.ts:49:38)",
      "",
      "Bun v1.4.3 (Linux x64)",
      "",
    ].join("\n");
    expect(checkError("exit 1", `${addressConfig}\n`, stderr, redact)).toBe(
      'exit 1, no summary: TypeError: ECONNREFUSED: Unable to connect. Is the computer able to access the url? | path: "<redacted rpc url>", | errno: 0, | code: "ECONNREFUSED"',
    );
  });

  it("ends a timeout with the audit's last progress", () => {
    const stdout = `${addressConfig}\n${JSON.stringify({ kind: "missing", block: 10 })}\n`;
    const progress = (hi: number) =>
      JSON.stringify({ progress: hi, to: 300, missing: 1 });
    const stderr = `${banners}\n${progress(100)}\n${progress(200)}\n`;
    expect(
      checkError("timed out after 10 minutes", stdout, stderr, redact),
    ).toBe(
      `timed out after 10 minutes, no summary: ${progress(100)} | ${progress(200)}`,
    );
  });

  it("says so when the audit printed nothing", () => {
    expect(checkError("exit 1", "", banners, redact)).toBe(
      "exit 1, no summary: no output",
    );
  });

  it("redacts before shortening, so a cut cannot leave part of a key", () => {
    const head = Math.floor(ERROR_MAX_LENGTH / 3);
    // Puts the cut at every position in the URL, key included.
    for (let pad = head - evmUrl.length - 40; pad < head; pad++) {
      const message = `${"x".repeat(pad)} ${evmUrl} ${"y".repeat(2 * ERROR_MAX_LENGTH)} the end`;
      const error = checkError("exit 1", uncaught(message), "", redact);
      expect(error).not.toContain(EVM_KEY.slice(0, 4));
      expect(error).not.toContain(EVM_KEY.slice(-4));
      expect(error.endsWith("y the end")).toBe(true);
      expect(error.length).toBeLessThanOrEqual(
        "exit 1, no summary: ".length + ERROR_MAX_LENGTH,
      );
    }
  });
});

describe("createRedactor", () => {
  it("replaces a configured URL in every form it can be printed in", () => {
    const shouted = createRedactor({
      rpcUrls: [`https://RPC.Provider.example/fake-provider/${EVM_KEY}`],
    });
    expect(
      shouted(
        `a https://rpc.provider.example/fake-provider/${EVM_KEY} b /fake-provider/${EVM_KEY}`,
      ),
    ).toBe("a <redacted rpc url> b /fake-provider/<redacted>");
    expect(redact("https://public.example/ and https://public.example")).toBe(
      "<redacted rpc url> and <redacted rpc url>",
    );
  });

  it("leaves ordinary words alone, including the URLs' own path words", () => {
    const text =
      "starknet_chainId failed with HTTP 401 | fake-provider version starknet";
    expect(redact(text)).toBe(text);
  });

  it("replaces the PG connection string and its password", () => {
    expect(
      redact(`connect ${pgUrl} failed; password ${PG_PASSWORD} rejected`),
    ).toBe(
      "connect <redacted pg connection string> failed; password <redacted> rejected",
    );
  });

  it("strips credentials from URLs that were never configured", () => {
    expect(
      redact(
        "postgres://user:other-password@db.other:5432/x https://lb.example/rpc?apikey=abc123 https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWx",
      ),
    ).toBe(
      "postgres://<redacted>@db.other:5432/x https://lb.example/rpc?apikey=<redacted> https://eth-mainnet.g.alchemy.com/v2/<redacted>",
    );
  });

  it("is idempotent", () => {
    const once = redact(`${evmUrl} ${pgUrl} https://u:p@h.example/x`);
    expect(redact(once)).toBe(once);
  });
});

describe("elide", () => {
  it("keeps the start and the end within the limit", () => {
    const text = `${"a".repeat(100)}${"b".repeat(100)}`;
    const short = elide(text, 60);
    expect(short).toBe(`${"a".repeat(20)} … ${"b".repeat(37)}`);
    expect(short.length).toBe(60);
    expect(elide("short", 60)).toBe("short");
  });
});

describe("the monitor process", () => {
  it("alerts with each audit's exception and no key or password", async () => {
    const hooks: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/hook") {
          hooks.push(await request.text());
          return new Response("ok");
        }
        // Like a provider that echoes the request path in its error.
        return new Response(`Cannot POST ${pathname}`, { status: 401 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const child = Bun.spawn(["bun", "scripts/monitorEventGaps.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          GAP_MONITOR_CHAINS: `starknet/mainnet=${base}/starknet/${STARKNET_KEY},bsc-mainnet=${base}/fake-provider/${EVM_KEY}|5000`,
          GAP_MONITOR_RETRY_SECONDS: "0",
          PG_CONNECTION_STRING: `postgres://monitor:${PG_PASSWORD}@127.0.0.1:9/indexer`,
          ALERT_WEBHOOK_URL: `${base}/hook`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(code).toBe(1);
      expect(hooks).toHaveLength(1);
      const { payload } = JSON.parse(hooks[0]) as {
        payload: { summary: string; report: unknown };
      };
      expect(payload.report).toEqual(JSON.parse(stdout));
      expect(payload.summary).toContain(
        "starknet/mainnet: check failed (exit 1, no summary: Uncaught exception starknet_chainId failed with HTTP 401)",
      );
      const [starknet, bsc] = (payload.report as { results: unknown[] })
        .results as { network: string; error: string }[];
      expect(starknet).toMatchObject({
        network: "starknet/mainnet",
        error:
          "exit 1, no summary: Uncaught exception starknet_chainId failed with HTTP 401",
      });
      expect(bsc.network).toBe("bsc-mainnet");
      expect(bsc.error).toContain("Status: 401 | URL: <redacted rpc url>");
      expect(bsc.error).toContain(
        'Details: "Cannot POST /fake-provider/<redacted>"',
      );
      for (const text of [stdout, stderr, hooks[0]]) {
        expect(text).not.toContain(EVM_KEY);
        expect(text).not.toContain(STARKNET_KEY);
        expect(text).not.toContain(PG_PASSWORD);
      }
    } finally {
      await server.stop(true);
    }
  }, 30_000);
});
