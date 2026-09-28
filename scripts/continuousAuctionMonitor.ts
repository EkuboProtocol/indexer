/**
 * One pass of the ContinuousAuction user-value monitor for one chain:
 *
 * 1. For every tenure without a settled answer, finds the first block at or
 *    after its start and records whether it fell inside the tenure
 *    (continuous_auction_tenure_executability).
 * 2. At the indexed head block, records allocated, collected and claimable
 *    rent per auction pool (continuous_auction_rent_reconciliations); the
 *    difference is rent discarded by liquidity changes.
 * 3. Evaluates continuous_auction_alerts and prints one JSON line.
 *
 *   NETWORK=mainnet bun scripts/continuousAuctionMonitor.ts
 *
 * Reads the same env as the chain's indexer: PG_CONNECTION_STRING,
 * EVM_RPC_URL, CHAIN_ID and CONTINUOUS_AUCTION_V3_ADDRESS. The RPC has to
 * serve state at the indexed head, which any node does for recent blocks.
 * Exits 0 when nothing fires, 2 on warnings only, 3 when anything pages, and
 * 1 when the check itself fails, so a scheduler can route on the exit code.
 */
import postgres from "postgres";
import { createPublicClient, http } from "viem";
import { loadConfig } from "../src/config";
import { CONTINUOUS_AUCTION_ABI } from "../src/evm/abis_v3";
import {
  type AlertSeverity,
  createPositionId,
  exitCodeFor,
  findFirstBlockAtOrAfter,
  toAddress,
  toBytes32,
} from "../src/evm/continuousAuctionMonitor";

loadConfig("evm");

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const chainId = BigInt(requireEnv("CHAIN_ID"));
const auction = requireEnv("CONTINUOUS_AUCTION_V3_ADDRESS") as `0x${string}`;
const sql = postgres(requireEnv("PG_CONNECTION_STRING"), { idle_timeout: 1, max: 1 });
const client = createPublicClient({
  transport: http(requireEnv("EVM_RPC_URL").split(",")[0], { retryCount: 2 }),
});

const blockTimes = new Map<bigint, bigint>();
async function getTime(block: bigint) {
  let time = blockTimes.get(block);
  if (time === undefined) {
    time = (await client.getBlock({ blockNumber: block })).timestamp;
    blockTimes.set(block, time);
  }
  return time;
}

async function head() {
  const [row] = await sql<{ number: string; time: string }[]>`
    SELECT head_block_number::text AS number, EXTRACT(EPOCH FROM head_block_time)::int8::text AS time
    FROM indexer_cursor
    WHERE chain_id = ${chainId.toString()}
      AND head_block_number IS NOT NULL
  `;
  if (!row) throw new Error(`no indexed head for chain ${chainId}`);
  return { number: BigInt(row.number), time: BigInt(row.time) };
}

async function resolveExecutability(headBlock: bigint) {
  const pending = await sql<
    {
      pool_key_id: string;
      bidder: string;
      bid_start: string;
      live_until: string;
      observed_until: string;
      placed_block: string;
    }[]
  >`
    SELECT t.pool_key_id::text, t.bidder::text, t.bid_start::text, t.live_until::text,
           t.observed_until::text,
           (SELECT MAX(bu.block_number)
            FROM continuous_auction_bid_updated bu
            WHERE bu.pool_key_id = t.pool_key_id
              AND bu.bidder = t.bidder
              AND bu.bid_start = t.bid_start
              AND bu.rate <> 0)::text AS placed_block
    FROM continuous_auction_tenures t
             LEFT JOIN continuous_auction_tenure_executability e
                       ON e.pool_key_id = t.pool_key_id AND e.bidder = t.bidder AND e.bid_start = t.bid_start
    WHERE t.chain_id = ${chainId.toString()}
      AND (e.pool_key_id IS NULL OR (NOT e.executable AND e.live_until <> t.live_until))
  `;

  let resolved = 0;
  for (const t of pending) {
    const first = await findFirstBlockAtOrAfter(
      getTime,
      BigInt(t.placed_block),
      headBlock,
      BigInt(t.bid_start),
    );
    if (!first) continue;
    const executable = first.time < BigInt(t.live_until);
    // An open tenure can still get its first block.
    if (!executable && t.live_until === t.observed_until) continue;
    await sql`
      INSERT INTO continuous_auction_tenure_executability
        (pool_key_id, bidder, bid_start, live_until, first_block_number, first_block_time, executable)
      VALUES (${t.pool_key_id}, ${t.bidder}, ${t.bid_start}, ${t.live_until},
              ${first.number.toString()}, ${first.time.toString()}, ${executable})
      ON CONFLICT (pool_key_id, bidder, bid_start) DO UPDATE
        SET live_until         = EXCLUDED.live_until,
            first_block_number = EXCLUDED.first_block_number,
            first_block_time   = EXCLUDED.first_block_time,
            executable         = EXCLUDED.executable,
            checked_at         = now()
    `;
    resolved++;
  }
  return { pending: pending.length, resolved };
}

async function reconcileRent(headBlock: { number: bigint; time: bigint }) {
  // One snapshot, so the sums and the position list agree with each other.
  return sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    const pools = await tx<
      { pool_key_id: string; token0: string; token1: string; pool_config: string; allocated: string; collected: string }[]
    >`
      SELECT pk.pool_key_id::text, pk.token0::text, pk.token1::text, pk.pool_config::text,
             (SELECT COALESCE(SUM(rs.amount), 0)
              FROM continuous_auction_rent_settled rs
              WHERE rs.pool_key_id = pk.pool_key_id AND rs.allocated
                AND rs.block_number <= ${headBlock.number.toString()})::text AS allocated,
             (SELECT COALESCE(SUM(rc.amount), 0)
              FROM continuous_auction_rent_collected rc
              WHERE rc.pool_key_id = pk.pool_key_id
                AND rc.block_number <= ${headBlock.number.toString()})::text AS collected
      FROM continuous_auction_pool_keys cap
               JOIN pool_keys pk ON pk.pool_key_id = cap.pool_key_id
      WHERE pk.chain_id = ${chainId.toString()}
    `;
    const rows = [];
    for (const pool of pools) {
      const positions = await tx<{ locker: string; salt: string; lower_bound: number; upper_bound: number }[]>`
        SELECT locker::text, salt::text, lower_bound, upper_bound
        FROM position_current_liquidity
        WHERE pool_key_id = ${pool.pool_key_id}
          AND liquidity > 0
      `;
      const key = {
        token0: toAddress(BigInt(pool.token0)),
        token1: toAddress(BigInt(pool.token1)),
        config: toBytes32(BigInt(pool.pool_config)),
      };
      let claimable = 0n;
      for (const p of positions) {
        claimable += await client.readContract({
          address: auction,
          abi: CONTINUOUS_AUCTION_ABI,
          functionName: "getPositionRent",
          args: [
            key,
            toAddress(BigInt(p.locker)),
            createPositionId(BigInt(p.salt), p.lower_bound, p.upper_bound),
          ],
          blockNumber: headBlock.number,
        });
      }
      rows.push({
        pool_key_id: pool.pool_key_id,
        allocated: pool.allocated,
        collected: pool.collected,
        claimable: claimable.toString(),
        positions: positions.length,
      });
    }
    return rows;
  }).then(async (rows) => {
    for (const r of rows) {
      await sql`
        INSERT INTO continuous_auction_rent_reconciliations
          (pool_key_id, block_number, block_time, allocated, collected, claimable)
        VALUES (${r.pool_key_id}, ${headBlock.number.toString()}, TO_TIMESTAMP(${headBlock.time.toString()}),
                ${r.allocated}, ${r.collected}, ${r.claimable})
        ON CONFLICT (pool_key_id, block_number) DO NOTHING
      `;
    }
    return rows;
  });
}

async function main() {
  const headBlock = await head();
  const executability = await resolveExecutability(headBlock.number);
  const reconciliations = await reconcileRent(headBlock);
  const alerts = await sql<
    { pool_key_id: string; alert: string; severity: AlertSeverity; value: string; threshold: string }[]
  >`
    SELECT pool_key_id::text, alert, severity, value::text, threshold::text, window_from, window_to
    FROM continuous_auction_alerts(${chainId.toString()})
  `;
  console.log(
    JSON.stringify({
      chainId: chainId.toString(),
      head: { number: headBlock.number.toString(), time: headBlock.time.toString() },
      executability,
      reconciliations,
      alerts,
    }),
  );
  return exitCodeFor(alerts);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("continuous auction monitor failed:", err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
