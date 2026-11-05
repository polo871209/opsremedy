import { Database } from "bun:sqlite";
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/chord/sqlite";

class BunSqliteExecutor implements SqliteExecutor {
  constructor(
    protected readonly db: Database,
    private readonly isActive: () => boolean = () => true,
  ) {}

  private use<T>(op: () => T): Promise<T> {
    if (!this.isActive())
      return Promise.reject(
        new Error("SQLite transaction handle is no longer active"),
      );
    try {
      return Promise.resolve(op());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  exec(sql: string): Promise<void> {
    return this.use(() => void this.db.run(sql));
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.use(() => void this.db.query(sql).run(...params));
  }

  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.use(() => this.db.query(sql).run(...params).changes);
  }

  get<T extends object>(
    sql: string,
    ...params: SqliteValue[]
  ): Promise<T | undefined> {
    return this.use(
      () => (this.db.query(sql).get(...params) as T | null) ?? undefined,
    );
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.use(() => this.db.query(sql).all(...params) as T[]);
  }
}

/** pi-durable `SqliteDatabase` on `bun:sqlite`. Every call waits for the transaction before it. */
class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op);
    this.tail = result.catch(() => {});
    return result;
  }

  override exec(sql: string) {
    return this.serial(() => super.exec(sql));
  }
  override run(sql: string, ...params: SqliteValue[]) {
    return this.serial(() => super.run(sql, ...params));
  }
  override runCounted(sql: string, ...params: SqliteValue[]) {
    return this.serial(() => super.runCounted(sql, ...params));
  }
  override get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.serial(() => super.get<T>(sql, ...params));
  }
  override all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.serial(() => super.all<T>(sql, ...params));
  }

  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      let active = true;
      this.db.run("BEGIN IMMEDIATE");
      try {
        const result = await callback(
          new BunSqliteExecutor(this.db, () => active),
        );
        active = false;
        this.db.run("COMMIT");
        return result;
      } catch (error) {
        active = false;
        try {
          this.db.run("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.serial(async () => {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        this.db.close();
      }
    });
  }
}

export function openBunSqliteDatabase(path: string): SqliteDatabase {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  return new BunSqliteDatabase(db);
}
