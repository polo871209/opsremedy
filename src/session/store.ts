import { makeSqliteKVStore } from "./sqlite-store.ts";

export interface KVStore<T> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
  /** `ttlSeconds` overrides the store TTL for this entry, for a short-lived claim. */
  setIfAbsent(id: string, value: T, ttlSeconds?: number): Promise<boolean>;
}

class MemoryKVStore<T> implements KVStore<T> {
  private m = new Map<string, T>();
  async get(id: string) {
    return this.m.get(id) ?? null;
  }
  async set(id: string, v: T) {
    this.m.set(id, v);
  }
  async delete(id: string) {
    this.m.delete(id);
  }
  async setIfAbsent(id: string, v: T): Promise<boolean> {
    if (this.m.has(id)) return false;
    this.m.set(id, v);
    return true;
  }
}

function makeKVStore<T>(
  dbPath: string,
  prefix: string,
  ttlSeconds: number,
  encode: (v: T) => string,
  decode: (s: string) => T,
): KVStore<T> {
  if (!dbPath) return new MemoryKVStore<T>();
  return makeSqliteKVStore<T>(dbPath, prefix, ttlSeconds, encode, decode);
}

function makeJsonStore<T>(dbPath: string, prefix: string, ttlSeconds: number): KVStore<T> {
  return makeKVStore<T>(dbPath, prefix, ttlSeconds, JSON.stringify, (s) => JSON.parse(s) as T);
}

export type IncidentStore = KVStore<string>;

interface IncidentMeta {
  endedAt: string;
}
export type IncidentMetaStore = KVStore<IncidentMeta>;
export function makeIncidentMetaStore(dbPath: string, ttlSeconds: number): IncidentMetaStore {
  return makeJsonStore<IncidentMeta>(dbPath, "sre:incident-meta:", ttlSeconds);
}

export function makeThreadMessagesCache<T>(dbPath: string, ttlSeconds: number): KVStore<T> {
  return makeJsonStore<T>(dbPath, "sre:thread-msgs:", ttlSeconds);
}

export interface AlertGroup {
  rootMsgId: string;
  incidentId: string;
  opens: number;
  firstOpenedAt: string;
}
export type AlertGroupStore = KVStore<AlertGroup>;
export function makeAlertGroupStore(dbPath: string, ttlSeconds: number): AlertGroupStore {
  return makeJsonStore<AlertGroup>(dbPath, "sre:alert-group:", ttlSeconds);
}

export function makeIncidentStore(dbPath: string, ttlSeconds: number): IncidentStore {
  return makeKVStore<string>(
    dbPath,
    "sre:incident:",
    ttlSeconds,
    (v) => v,
    (s) => s,
  );
}
