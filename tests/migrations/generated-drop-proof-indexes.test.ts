import { expect, test } from "bun:test";
import { createClient } from "../helpers/db.js";

type Client = Awaited<ReturnType<typeof createClient>>;

async function seedProofs(client: Client, drops: number, perDrop: number) {
  for (let d = 1; d <= drops; d++) {
    await client.query(`INSERT INTO incentives.generated_drop (root) VALUES ($1)`, [String(1000 + d)]);
  }
  // Production rows are ~850 bytes because the Merkle proof (an array of
  // 256-bit numerics) is stored inline, which is what makes a heap scan of
  // this table expensive relative to its indexes. Seed a comparable width so
  // the planner faces the same trade-off here.
  await client.query(
    `INSERT INTO incentives.generated_drop_proof (drop_id, id, address, amount, proof)
     SELECT d, i, (d * 1000000 + i)::numeric, (i * 7)::numeric,
            (SELECT array_agg((2::numeric ^ 250) + g) FROM generate_series(1, 24) g)
     FROM generate_series(1, $1) d, generate_series(1, $2) i`,
    [drops, perDrop]
  );
  // Index-only scans need the visibility map, which only VACUUM builds.
  await client.query(`VACUUM ANALYZE incentives.generated_drop_proof`);
}

test("the claims lookup by address is an index scan, not a table scan", async () => {
  const client = await createClient();
  await seedProofs(client, 20, 2000); // 40,000 rows

  const { rows } = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT gdp.drop_id, gdp.id, gdp.amount
     FROM incentives.generated_drop_proof gdp
     JOIN incentives.generated_drop gd ON gd.id = gdp.drop_id
     WHERE gdp.address = 3000042::numeric`
  );
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  expect(plan).toContain("generated_drop_proof_address_idx");
  expect(plan).not.toMatch(/Seq Scan on generated_drop_proof/);
});

test("the per-drop totals aggregate does not touch the proof-laden heap", async () => {
  const client = await createClient();
  await seedProofs(client, 20, 2000);

  const { rows } = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT drop_id, SUM(amount) FROM incentives.generated_drop_proof GROUP BY drop_id`
  );
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  expect(plan).toContain("generated_drop_proof_drop_id_amount_idx");
  expect(plan).toMatch(/Index Only Scan/);
});

test("both indexes exist with the expected definitions", async () => {
  const client = await createClient();
  const { rows } = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'incentives' AND tablename = 'generated_drop_proof' ORDER BY indexname`
  );
  const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
  expect(defs["generated_drop_proof_address_idx"]).toMatch(/\(address\)$/);
  expect(defs["generated_drop_proof_drop_id_amount_idx"]).toMatch(/\(drop_id, amount\)$/);
  expect(defs["generated_drop_proof_pkey"]).toBeDefined();
});
