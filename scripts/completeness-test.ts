import "../src/config";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POSITIONS_ABI } from "../src/evm/abis_v3";
import { parsePositionsProtocolFeeConfigs } from "../src/evm/positionsProtocolFeeConfig";

type EnvOptions = {
  pgUrl: string;
  rpcUrl: string;
  privateKey: Hex;
  positionsAddress: Hex;
  pollIntervalMs: number;
  timeoutMs: number;
  cycleDelayMs: number;
  chainId?: bigint;
};

function parseEnvOptions(): EnvOptions {
  const pgUrl = process.env.PG_CONNECTION_STRING;
  const rpcUrl = process.env.EVM_RPC_URL?.split(",")
    .map((v) => v.trim())
    .filter(Boolean)[0];
  const privateKey = process.env.PRIVATE_KEY;
  const positionsAddress =
    process.env.POSITIONS_V3_ADDRESS ??
    parsePositionsProtocolFeeConfigs(
      process.env.POSITIONS_V3_PROTOCOL_FEE_CONFIGS,
    )?.[0]?.address;
  const chainIdRaw = process.env.CHAIN_ID;
  const pollIntervalMsRaw = process.env.POLL_INTERVAL_MS ?? "3000";
  const timeoutMsRaw = process.env.TIMEOUT_MS ?? "180000";
  const cycleDelayMsRaw = process.env.CYCLE_DELAY_MS ?? "1000";

  if (!pgUrl) throw new Error("Missing PG_CONNECTION_STRING.");
  if (!rpcUrl) throw new Error("Missing EVM_RPC_URL.");
  if (!privateKey) throw new Error("Missing PRIVATE_KEY.");
  if (!positionsAddress)
    throw new Error(
      "Missing POSITIONS_V3_ADDRESS or POSITIONS_V3_PROTOCOL_FEE_CONFIGS.",
    );

  if (!privateKey.startsWith("0x")) {
    throw new Error("Private key must be 0x-prefixed.");
  }
  if (!positionsAddress.startsWith("0x")) {
    throw new Error("Positions address must be 0x-prefixed.");
  }

  const pollIntervalMs = Number(pollIntervalMsRaw);
  const timeoutMs = Number(timeoutMsRaw);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid poll interval: ${pollIntervalMsRaw}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutMsRaw}`);
  }
  const cycleDelayMs = Number(cycleDelayMsRaw);
  if (!Number.isFinite(cycleDelayMs) || cycleDelayMs < 0) {
    throw new Error(`Invalid cycle delay: ${cycleDelayMsRaw}`);
  }

  return {
    pgUrl,
    rpcUrl,
    privateKey: privateKey as Hex,
    positionsAddress: positionsAddress as Hex,
    pollIntervalMs,
    timeoutMs,
    cycleDelayMs,
    chainId: chainIdRaw ? BigInt(chainIdRaw) : undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSalt(): Hex {
  return `0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex;
}

async function main() {
  const {
    pgUrl,
    rpcUrl,
    privateKey,
    positionsAddress,
    pollIntervalMs,
    timeoutMs,
    cycleDelayMs,
    chainId: expectedChainId,
  } = parseEnvOptions();

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });

  const rpcChainId = BigInt(await publicClient.getChainId());
  const chainId = expectedChainId ?? rpcChainId;
  if (expectedChainId !== undefined && expectedChainId !== rpcChainId) {
    throw new Error(
      `Chain ID mismatch: expected ${expectedChainId.toString()}, RPC returned ${rpcChainId.toString()}`,
    );
  }

  const sql = postgres(pgUrl, {
    connect_timeout: 5,
    types: { bigint: postgres.BigInt },
    connection: { application_name: "completeness-test.ts" },
  });

  let shouldStop = false;
  const requestStop = (signal: string) => {
    shouldStop = true;
    console.log(`Received ${signal}, stopping after current iteration...`);
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));

  try {
    let iteration = 0;
    while (!shouldStop) {
      iteration += 1;
      try {
        console.log(
          `Iteration ${iteration}: sending Positions.mint() on chain ${chainId.toString()} using ${positionsAddress}`,
        );
        const salt = randomSalt();
        const txHash = await walletClient.writeContract({
          chain: null,
          address: positionsAddress,
          abi: POSITIONS_ABI,
          functionName: "mint",
          args: [salt],
        });
        console.log(
          `Iteration ${iteration}: submitted tx ${txHash} (salt=${salt})`,
        );

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
          timeout: timeoutMs,
        });
        if (receipt.status !== "success") {
          throw new Error(`Mint transaction reverted: ${txHash}`);
        }

        const transferLogs = parseEventLogs({
          abi: POSITIONS_ABI,
          eventName: "Transfer",
          logs: receipt.logs,
          strict: false,
        }).filter(
          (log) => log.address.toLowerCase() === positionsAddress.toLowerCase(),
        );

        const mintTransfer = transferLogs.find(
          (log) => log.args.from?.toLowerCase() === zeroAddress.toLowerCase(),
        );
        if (!mintTransfer || mintTransfer.args.id === undefined) {
          throw new Error(
            `Could not find mint Transfer(from=0x0) log in transaction receipt: ${txHash}`,
          );
        }

        const mintBlock = BigInt(receipt.blockNumber);
        const tokenId = BigInt(mintTransfer.args.id);
        const txHashAsNumeric = BigInt(txHash);
        const emitterAsNumeric = BigInt(positionsAddress);

        console.log(
          `Iteration ${iteration}: minted token ${tokenId.toString()} in block ${mintBlock.toString()}, waiting for indexer cursor...`,
        );

        const startedAt = Date.now();
        let verified = false;
        while (Date.now() - startedAt < timeoutMs && !shouldStop) {
          const [cursor] = await sql<{ order_key: bigint }[]>`
            SELECT order_key
            FROM indexer_cursor
            WHERE chain_id = ${chainId}
          `;

          if (!cursor) {
            throw new Error(
              `No indexer_cursor row found for chain_id=${chainId.toString()}`,
            );
          }

          const [eventRow] = await sql<{ found: number }[]>`
            SELECT 1 AS found
            FROM nonfungible_token_transfers
            WHERE chain_id = ${chainId}
              AND emitter = ${emitterAsNumeric.toString()}::numeric
              AND token_id = ${tokenId.toString()}::numeric
              AND transaction_hash = ${txHashAsNumeric.toString()}::numeric
            LIMIT 1
          `;

          const cursorOrderKey = BigInt(cursor.order_key);
          const eventExists = Boolean(eventRow?.found);

          if (cursorOrderKey > mintBlock) {
            if (!eventExists) {
              throw new Error(
                `Cursor advanced past mint block but event missing. cursor=${cursorOrderKey.toString()} mintBlock=${mintBlock.toString()} tokenId=${tokenId.toString()} tx=${txHash}`,
              );
            }

            console.log(
              `Iteration ${iteration}: success, cursor=${cursorOrderKey.toString()} > mintBlock=${mintBlock.toString()} and event exists`,
            );
            verified = true;
            break;
          }

          console.log(
            `Iteration ${iteration}: waiting... cursor=${cursorOrderKey.toString()} mintBlock=${mintBlock.toString()} eventExists=${eventExists}`,
          );
          await sleep(pollIntervalMs);
        }

        if (!verified && !shouldStop) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for cursor to pass mint block and validate event.`,
          );
        }
      } catch (err) {
        console.error(`Iteration ${iteration}: failed`, err);
      }

      if (!shouldStop && cycleDelayMs > 0) {
        await sleep(cycleDelayMs);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
