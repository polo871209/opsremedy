import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  type SqliteDatabase,
  type SqliteExecutor,
} from "@earendil-works/pi-durable/storage/sqlite";
import { ThreadDoc, ThreadIndex } from "./docs.ts";

const PRUNABLE_SCHEMA_VERSION = 1;
const IN_JSON = "(SELECT value FROM json_each(?))";

const loadedThreads = new Set<string>();

// pi-durable's Session caches every document it loads and never rereads it, so pruning a loaded thread leaves a stale
// cache hit. Call this before the first read of a thread.
export function keepUntilRestart(threadKey: string): void {
  loadedThreads.add(threadKey);
}

export type PruneResult = { threads: number; conversations: number };

type Thread = { conversations: number[]; threadKeys: string[]; lastActiveAt: number; live: boolean };

export async function pruneIdleThreads(database: SqliteDatabase, idleBefore: number): Promise<PruneResult> {
  if (CURRENT_SQLITE_SCHEMA_VERSION !== PRUNABLE_SCHEMA_VERSION) {
    throw new Error(
      `pi-durable SQLite schema is v${CURRENT_SQLITE_SCHEMA_VERSION}, pruneIdleThreads deletes from v${PRUNABLE_SCHEMA_VERSION}`,
    );
  }
  return database.transaction(async (tx) => {
    const idle = [...(await threadsOf(tx)).values()].filter(
      (t) => !t.live && t.lastActiveAt < idleBefore && !t.threadKeys.some((key) => loadedThreads.has(key)),
    );
    const conversations = idle.flatMap((t) => t.conversations);
    if (conversations.length > 0) {
      await deleteConversations(
        tx,
        conversations,
        idle.flatMap((t) => t.threadKeys),
      );
    }
    return { threads: idle.length, conversations: conversations.length };
  });
}

async function threadsOf(tx: SqliteExecutor): Promise<Map<number, Thread>> {
  const conversations = await tx.all<{ id: number; parent: number | null; ownerTask: number | null }>(
    `SELECT id, coalesce(json_extract(record, '$.parent.conversationId'), owner_conversation_id) AS parent,
            owner_task_id AS ownerTask
       FROM conversations`,
  );
  const tasks = await tx.all<{ id: number; conversationId: number; live: number }>(
    "SELECT id, conversation_id AS conversationId, status <> 'terminal' AS live FROM tasks",
  );
  const entryTimes = await tx.all<{ id: number; at: number | null }>(
    `SELECT conversation_id AS id, max(json_extract(record, '$.model[0].timestamp')) AS at
       FROM entries GROUP BY conversation_id`,
  );
  const threadDocs = await tx.all<{ id: number; threadKey: string | null; createdAt: number | null }>(
    `SELECT d.owner_id AS id, json_extract(r.content, '$.threadKey') AS threadKey,
            json_extract(r.content, '$.createdAt') AS createdAt
       FROM documents d JOIN document_revisions r ON r.document_id = d.id
      WHERE d.kind = ? AND d.scope_kind = 'conversation' AND d.retired_at IS NULL AND r.kind = 'base'`,
    JSON.stringify(ThreadDoc.definition.kind),
  );

  const taskConversation = new Map(tasks.map((t) => [t.id, t.conversationId]));
  const parentOf = new Map(
    conversations.map((c) => [c.id, c.parent ?? (c.ownerTask === null ? null : taskConversation.get(c.ownerTask))]),
  );
  const rootOf = (id: number): number => {
    const path = new Set([id]);
    let at = id;
    for (;;) {
      const parent = parentOf.get(at);
      if (parent == null || !parentOf.has(parent) || path.has(parent)) return at;
      path.add(parent);
      at = parent;
    }
  };

  const threads = new Map<number, Thread>();
  const threadOf = (conversation: number): Thread => {
    const root = rootOf(conversation);
    let thread = threads.get(root);
    if (!thread) {
      thread = { conversations: [], threadKeys: [], lastActiveAt: 0, live: false };
      threads.set(root, thread);
    }
    return thread;
  };
  for (const c of conversations) threadOf(c.id).conversations.push(c.id);
  for (const t of tasks) if (t.live) threadOf(t.conversationId).live = true;
  for (const e of entryTimes) {
    const thread = threadOf(e.id);
    thread.lastActiveAt = Math.max(thread.lastActiveAt, e.at ?? 0);
  }
  for (const d of threadDocs) {
    const thread = threadOf(d.id);
    thread.lastActiveAt = Math.max(thread.lastActiveAt, d.createdAt ?? 0);
    if (d.threadKey) thread.threadKeys.push(d.threadKey);
  }
  return threads;
}

async function deleteConversations(tx: SqliteExecutor, conversations: number[], threadKeys: string[]): Promise<void> {
  const conversationIds = JSON.stringify(conversations);
  const ids = async (sql: string, ...params: string[]) =>
    JSON.stringify((await tx.all<{ id: number }>(sql, ...params)).map((r) => r.id));
  const taskIds = await ids(`SELECT id FROM tasks WHERE conversation_id IN ${IN_JSON}`, conversationIds);
  const documentIds = await ids(
    `SELECT id FROM documents
      WHERE (scope_kind = 'conversation' AND owner_id IN ${IN_JSON})
         OR (scope_kind = 'task' AND owner_id IN ${IN_JSON})
         OR (scope_kind = 'session' AND kind = ? AND key_value IN ${IN_JSON})`,
    conversationIds,
    taskIds,
    JSON.stringify(ThreadIndex.definition.kind),
    JSON.stringify(threadKeys.map((key) => JSON.stringify(key))),
  );
  for (const table of ["entries", "submissions"]) {
    await tx.run(
      `DELETE FROM record_ids WHERE id IN (SELECT id FROM ${table} WHERE conversation_id IN ${IN_JSON})`,
      conversationIds,
    );
    await tx.run(`DELETE FROM ${table} WHERE conversation_id IN ${IN_JSON}`, conversationIds);
  }
  await tx.run(`DELETE FROM document_revisions WHERE document_id IN ${IN_JSON}`, documentIds);
  for (const [table, idList] of [
    ["documents", documentIds],
    ["tasks", taskIds],
    ["conversations", conversationIds],
  ] as const) {
    await tx.run(`DELETE FROM ${table} WHERE id IN ${IN_JSON}`, idList);
    await tx.run(`DELETE FROM record_ids WHERE id IN ${IN_JSON}`, idList);
  }
}
