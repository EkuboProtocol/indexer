import "../src/config.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { migrate } from "postgres-migrations";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.PG_CONNECTION_STRING,
  });

  const migrationsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations"
  );

  await client.connect();

  try {
    await migrate({ client }, migrationsPath);
    console.log("Migrations applied successfully.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration run failed:", err);
  process.exitCode = 1;
});
