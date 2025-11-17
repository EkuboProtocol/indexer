import "../src/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import shift from "postgres-shift";

async function main() {
  const connectionString = process.env.PG_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("PG_CONNECTION_STRING must be set");
  }

  const sql = postgres(connectionString, {
    idle_timeout: 1,
  });

  const migrationsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations"
  );

  try {
    await shift({
      sql,
      path: migrationsPath,
      before: ({ migration_id, name }) => {
        console.log("Migrating", migration_id, name);
      },
    });
    console.log("Migrations applied successfully.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Migration run failed:", err);
  process.exitCode = 1;
});
