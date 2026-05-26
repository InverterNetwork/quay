import { Database } from "bun:sqlite";

export type DB = Database;

export function openDatabase(path: string): DB {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}
