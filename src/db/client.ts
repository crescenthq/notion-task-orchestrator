import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export function openDatabase(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
