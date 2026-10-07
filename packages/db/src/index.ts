// SQLite via Drizzle. The database is a single file; migrations run on first open,
// so there is no setup step. After changing schema.ts run `pnpm --filter @bulkhead/db generate`.
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export type DB = BetterSQLite3Database<typeof schema>;

let cached: { db: DB; sqlite: Database.Database } | null = null;

/** The bulkhead/ repo root (this file is packages/db/src/index.ts). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Relative DATABASE_PATH values resolve against the repo root, so the engine, web app, market
 * and scripts all share one file whatever their working directory. */
export function dbPath(raw = process.env.DATABASE_PATH ?? "./data/bulkhead.sqlite"): string {
  if (raw === ":memory:" || raw.startsWith("file:")) return raw; // in-memory / URI databases (tests)
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export function openDb(path = dbPath()): DB {
  if (cached) return cached.db;
  path = dbPath(path);
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  // Create/upgrade tables from the generated migrations (pnpm --filter @bulkhead/db generate).
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  cached = { db, sqlite };
  return db;
}

/** Raw handle for transactions that need BEGIN IMMEDIATE (e.g. TreasuryQueue). */
export function rawSqlite(): Database.Database {
  if (!cached) openDb();
  return cached!.sqlite;
}

export function closeDb() {
  cached?.sqlite.close();
  cached = null;
}
