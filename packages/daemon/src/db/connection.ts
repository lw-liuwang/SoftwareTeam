import Database from "better-sqlite3";
import { existsSync } from "node:fs";

/**
 * Create a SQLite database connection.
 * Defaults to in-memory for tests. Pass a file path for persistence.
 */
export function createDb(filePath?: string): Database.Database {
  if (filePath && filePath !== ":memory:" && existsSync(filePath)) {
    const previous = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      if (previous.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get("rigs")) {
        throw new Error("Unsupported legacy OpenRig database; select a fresh SoftwareTeam database. Existing data was not migrated.");
      }
    } finally { previous.close(); }
  }
  const db = new Database(filePath ?? ":memory:");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}
