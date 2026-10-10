import { Database } from "bun:sqlite";
import { log } from "../utils/logger.ts";
import type { KVStore } from "./store.ts";

const dbs = new Map<string, Database>();
function getDb(path: string): Database {
  const cached = dbs.get(path);
  if (cached) return cached;
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at)");
  log.info("sqlite store init", { path });
  dbs.set(path, db);
  return db;
}

export function sweepExpired(dbPath: string): number {
  return getDb(dbPath).run("DELETE FROM kv WHERE expires_at < ?", [Date.now()]).changes;
}

class SqliteKVStore<T> implements KVStore<T> {
  constructor(
    private db: Database,
    private prefix: string,
    private ttlSeconds: number,
    private encode: (v: T) => string,
    private decode: (s: string) => T,
  ) {}
  private k(id: string) {
    return `${this.prefix}${id}`;
  }
  async get(id: string): Promise<T | null> {
    const row = this.db.query("SELECT value, expires_at FROM kv WHERE key = ?").get(this.k(id)) as {
      value: string;
      expires_at: number;
    } | null;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.run("DELETE FROM kv WHERE key = ?", [this.k(id)]);
      return null;
    }
    return this.decode(row.value);
  }
  async set(id: string, v: T): Promise<void> {
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    this.db.run(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      [this.k(id), this.encode(v), expiresAt],
    );
  }
  async delete(id: string): Promise<void> {
    this.db.run("DELETE FROM kv WHERE key = ?", [this.k(id)]);
  }
  async setIfAbsent(id: string, v: T, ttlSeconds = this.ttlSeconds): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const result = this.db.run(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at " +
        "WHERE kv.expires_at < ?",
      [this.k(id), this.encode(v), expiresAt, now],
    );
    return result.changes > 0;
  }
}

export function makeSqliteKVStore<T>(
  dbPath: string,
  prefix: string,
  ttlSeconds: number,
  encode: (v: T) => string,
  decode: (s: string) => T,
): KVStore<T> {
  return new SqliteKVStore<T>(getDb(dbPath), prefix, ttlSeconds, encode, decode);
}
