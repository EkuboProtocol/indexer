import { describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { createPublicClient, http } from "viem";
import { createLogger, transports } from "winston";
import { createBlockStream, type ChainAdapter } from "./blockStream";
import { loggerFormat } from "./logger";
import { redactSecrets } from "./redactSecrets";

const ALCHEMY_KEY = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const DRPC_KEY = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe";
// Port 9 (discard) on loopback refuses the connection, so viem fails fast with
// its real HttpRequestError, URL included.
const alchemyUrl = `http://127.0.0.1:9/v2/${ALCHEMY_KEY}`;
const drpcUrl = `http://127.0.0.1:9/ogrpc?network=ink&dkey=${DRPC_KEY}`;

function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = createLogger({ format: loggerFormat, transports: [new transports.Stream({ stream })] });
  return { logger, output: () => lines.join("") };
}

async function viemError(url: string): Promise<Error> {
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  try {
    await client.request({ method: "eth_getLogs", params: [{}] } as never);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

describe("redactSecrets", () => {
  it("replaces configured endpoints with their origin", () => {
    const env = { EVM_RPC_URL: `${alchemyUrl},${drpcUrl}` };
    expect(redactSecrets(`URL: ${alchemyUrl} then ${drpcUrl}`, env))
      .toBe("URL: http://127.0.0.1:9/<redacted> then http://127.0.0.1:9/<redacted>");
  });

  it("catches key-shaped URLs that were never configured", () => {
    const text = [
      `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      `https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/${ALCHEMY_KEY}`,
      `https://lb.drpc.org/ogrpc?network=ink&dkey=${DRPC_KEY}`,
    ].join("\n");
    const out = redactSecrets(text, {});
    expect(out).not.toContain(ALCHEMY_KEY);
    expect(out).not.toContain(DRPC_KEY);
    expect(out).toContain("eth-mainnet.g.alchemy.com/v2/<redacted>");
    expect(out).toContain("network=ink&dkey=<redacted>");
  });

  it("leaves ordinary API paths alone", () => {
    const text = "https://pro-api.coingecko.com/api/v3/simple/token_price/ethereum";
    expect(redactSecrets(text, {})).toBe(text);
  });
});

describe("the indexer logger", () => {
  it("never prints a provider key from a real viem error, however it is logged", async () => {
    const saved = process.env.EVM_RPC_URL;
    process.env.EVM_RPC_URL = alchemyUrl;
    try {
      const { logger, output } = capturingLogger();
      const alchemy = await viemError(alchemyUrl);
      const drpc = await viemError(drpcUrl);
      expect(alchemy.message).toContain(ALCHEMY_KEY);

      logger.warn({ message: "provider read failed; backing off", error: alchemy.message });
      logger.error(new Error(`eth_getLogs failed. Cause: ${drpc.message}`, { cause: drpc }));
      logger.error(alchemy);
      await new Promise((resolve) => setImmediate(resolve));

      const text = output();
      expect(text).toContain("<redacted>");
      expect(text).not.toContain(ALCHEMY_KEY);
      expect(text).not.toContain(DRPC_KEY);
    } finally {
      if (saved === undefined) delete process.env.EVM_RPC_URL;
      else process.env.EVM_RPC_URL = saved;
    }
  });

  it("redacts the backoff warning the block stream emits", async () => {
    const { logger, output } = capturingLogger();
    const failure = await viemError(alchemyUrl);
    let heads = 0;
    const adapter: ChainAdapter<string> = {
      label: "fixture",
      async fetchBlock() { return null; },
      async fetchHead() {
        heads++;
        throw failure;
      },
      async fetchFinalized() { return null; },
      async readRange() { return []; },
      async completeFresh() {},
    };
    const stream = createBlockStream({
      adapter, startingCursor: { orderKey: 0n },
      options: {
        pollIntervalMs: 1, maxPollIntervalMs: 1, providerOutageBudgetMs: 5,
        onWarning: (message, detail) => logger.warn({ message, ...detail }),
      },
    });
    await expect(stream.next()).rejects.toBe(failure);
    await new Promise((resolve) => setImmediate(resolve));
    expect(heads).toBeGreaterThan(1);
    expect(output()).toContain("provider read failed; backing off");
    expect(output()).not.toContain(ALCHEMY_KEY);
  });
});
