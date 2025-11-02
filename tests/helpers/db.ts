import path from "node:path";
import { promises as fs } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

async function loadMigrationFiles(select?: string[]) {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((file) => file.endsWith(".sql")).sort();

  if (!select || select.length === 0) {
    return sqlFiles;
  }

  const remaining = new Set(select);
  const picked: string[] = [];
  for (const file of sqlFiles) {
    if (remaining.has(file)) {
      picked.push(file);
      remaining.delete(file);
    }
  }

  if (remaining.size > 0) {
    const missing = Array.from(remaining).join(", ");
    throw new Error(`Missing migration files: ${missing}`);
  }

  return picked;
}

export async function runMigrations(
  client: PGlite,
  options: { files?: string[] } = {}
) {
  const { files } = options;
  const migrations = await loadMigrationFiles(files);

  for (const file of migrations) {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.exec(sql);
  }
}

export async function createClient(options: { files?: string[] } = {}) {
  const client = new PGlite("memory://temp");
  try {
    await runMigrations(client, options);
  } catch (e) {
    console.error("Failed to run migrations", e);
    throw e;
  }
  return client;
}
