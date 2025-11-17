import path from "node:path";
import { promises as fs } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function normalizeSelection(name: string) {
  if (!name) return name;
  let normalized = name.replace(/\/?index\.(sql|js)$/, "");
  normalized = normalized.replace(/\.sql$/, "");
  const match = normalized.match(/^(\d+)(_.+)?$/);
  if (!match) {
    return normalized;
  }
  const [, numericPart, rest = ""] = match;
  const padded = numericPart.padStart(5, "0");
  return `${padded}${rest}`;
}

async function loadMigrationDirs(select?: string[]) {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!select || select.length === 0) {
    return directories;
  }

  const normalizedSelect = select.map((name) => ({
    original: name,
    normalized: normalizeSelection(name),
  }));

  const lookup = new Map(
    normalizedSelect.map((item) => [item.normalized, item.original])
  );

  const picked: string[] = [];
  for (const dir of directories) {
    if (lookup.has(dir)) {
      picked.push(dir);
      lookup.delete(dir);
    }
  }

  if (lookup.size > 0) {
    const missing = Array.from(lookup.values()).join(", ");
    throw new Error(`Missing migration directories: ${missing}`);
  }

  return picked;
}

export async function runMigrations(
  client: PGlite,
  options: { files?: string[] } = {}
) {
  const { files } = options;
  const migrations = await loadMigrationDirs(files);

  for (const file of migrations) {
    const sql = await fs.readFile(
      path.join(MIGRATIONS_DIR, file, "index.sql"),
      "utf8"
    );
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
