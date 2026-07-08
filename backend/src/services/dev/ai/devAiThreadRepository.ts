import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../../config/env";
import type {
  DevAiMessageIntent,
  DevAiMessageRole,
  DevAiThread,
  DevAiThreadArtifact,
  DevAiThreadContext,
  DevAiThreadMessage,
  DevAiThreadMode,
} from "@shared-types/ragicDefinitions";

interface ThreadRow {
  id: string;
  owner_actor: string;
  title: string;
  mode: DevAiThreadMode;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  current_form_path: string | null;
  current_field_id: string | null;
  current_formula_kind: string | null;
  last_message_preview: string;
  summary: string | null;
  summary_updated_at: string | null;
  summary_message_id: string | null;
}

interface MessageRow {
  id: string;
  thread_id: string;
  owner_actor: string;
  role: DevAiMessageRole;
  content: string;
  intent: DevAiMessageIntent | null;
  model: string | null;
  status: "completed" | "failed";
  created_at: string;
  metadata_json: string;
}

interface ArtifactRow {
  id: string;
  message_id: string;
  thread_id: string;
  type: DevAiThreadArtifact["type"];
  payload_json: string;
  created_at: string;
}

export interface CreateThreadInput {
  ownerActor: string;
  title: string;
  mode: DevAiThreadMode;
  context: DevAiThreadContext;
  now: string;
}

export interface AppendMessageInput {
  threadId: string;
  ownerActor: string;
  role: DevAiMessageRole;
  content: string;
  intent?: DevAiMessageIntent | null;
  model?: string | null;
  status?: "completed" | "failed";
  metadata?: Record<string, unknown>;
  now: string;
}

export interface AppendArtifactInput {
  messageId: string;
  threadId: string;
  type: DevAiThreadArtifact["type"];
  payload: Record<string, unknown>;
  now: string;
}

export interface DevAiThreadRepository {
  createThread(input: CreateThreadInput): Promise<DevAiThread>;
  listThreads(ownerActor: string, limit: number): Promise<DevAiThread[]>;
  getThread(ownerActor: string, threadId: string): Promise<DevAiThread | null>;
  listMessages(ownerActor: string, threadId: string, limit?: number): Promise<DevAiThreadMessage[]>;
  listArtifacts(ownerActor: string, threadId: string, limit?: number): Promise<DevAiThreadArtifact[]>;
  appendMessage(input: AppendMessageInput): Promise<DevAiThreadMessage>;
  appendArtifact(input: AppendArtifactInput): Promise<DevAiThreadArtifact>;
  updateThreadAfterMessage(params: {
    ownerActor: string;
    threadId: string;
    preview: string;
    updatedAt: string;
    context?: DevAiThreadContext;
  }): Promise<DevAiThread | null>;
  archiveThread(ownerActor: string, threadId: string, archivedAt: string): Promise<DevAiThread | null>;
  updateThreadSummary(params: {
    ownerActor: string;
    threadId: string;
    summary: string;
    summaryUpdatedAt: string;
    summaryMessageId: string;
  }): Promise<DevAiThread | null>;
  pruneThreadItems(params: {
    ownerActor: string;
    threadId: string;
    maxMessages: number;
    maxArtifacts: number;
  }): Promise<void>;
  pruneActorThreads(params: {
    ownerActor: string;
    now: string;
    maxThreads: number;
    activeRetentionDays: number;
    archivedRetentionDays: number;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface DevAiThreadRepositoryDeps {
  dbFile?: string;
  idFactory?: () => string;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeContext(context: DevAiThreadContext): DevAiThreadContext {
  return {
    formPath: context.formPath?.trim() ?? "",
    fieldId: context.fieldId?.trim() ?? "",
    formulaKind:
      context.formulaKind === "formula" || context.formulaKind === "defaultFormula"
        ? context.formulaKind
        : undefined,
  };
}

function mapThread(row: ThreadRow): DevAiThread {
  return {
    id: row.id,
    ownerActor: row.owner_actor,
    title: row.title,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    context: {
      ...(row.current_form_path ? { formPath: row.current_form_path } : {}),
      ...(row.current_field_id ? { fieldId: row.current_field_id } : {}),
      ...(row.current_formula_kind === "formula" || row.current_formula_kind === "defaultFormula"
        ? { formulaKind: row.current_formula_kind }
        : {}),
    },
    lastMessagePreview: row.last_message_preview,
    summary: row.summary,
    summaryUpdatedAt: row.summary_updated_at,
    summaryMessageId: row.summary_message_id,
  };
}

function mapMessage(row: MessageRow): DevAiThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    intent: row.intent,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapArtifact(row: ArtifactRow): DevAiThreadArtifact {
  return {
    id: row.id,
    messageId: row.message_id,
    threadId: row.thread_id,
    type: row.type,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  };
}

async function initializeSchema(db: Database): Promise<void> {
  await db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS dev_ai_threads (
      id TEXT PRIMARY KEY,
      owner_actor TEXT NOT NULL,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      current_form_path TEXT,
      current_field_id TEXT,
      current_formula_kind TEXT,
      last_message_preview TEXT NOT NULL DEFAULT '',
      summary TEXT,
      summary_updated_at TEXT,
      summary_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS dev_ai_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      owner_actor TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(thread_id) REFERENCES dev_ai_threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dev_ai_message_artifacts (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(message_id) REFERENCES dev_ai_messages(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES dev_ai_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_dev_ai_threads_owner_updated
      ON dev_ai_threads(owner_actor, archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_ai_messages_thread_created
      ON dev_ai_messages(owner_actor, thread_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_dev_ai_artifacts_thread
      ON dev_ai_message_artifacts(thread_id, created_at ASC);
  `);

  const columns = await db.all<Array<{ name: string }>>("PRAGMA table_info(dev_ai_threads)");
  const existing = new Set(columns.map((column) => column.name));
  if (!existing.has("summary")) await db.exec("ALTER TABLE dev_ai_threads ADD COLUMN summary TEXT");
  if (!existing.has("summary_updated_at")) {
    await db.exec("ALTER TABLE dev_ai_threads ADD COLUMN summary_updated_at TEXT");
  }
  if (!existing.has("summary_message_id")) {
    await db.exec("ALTER TABLE dev_ai_threads ADD COLUMN summary_message_id TEXT");
  }
}

export function createDevAiThreadRepository(
  deps: DevAiThreadRepositoryDeps = {}
): DevAiThreadRepository {
  const rawDbFile = deps.dbFile ?? env.DEV_AI_CONVERSATION_DB_FILE;
  const dbFile = rawDbFile === ":memory:" ? ":memory:" : path.resolve(rawDbFile);
  const idFactory = deps.idFactory ?? randomUUID;
  let dbPromise: Promise<Database> | null = null;

  async function getDb(): Promise<Database> {
    if (!dbPromise) {
      dbPromise = (async () => {
        if (dbFile !== ":memory:") await fs.mkdir(path.dirname(dbFile), { recursive: true });
        const db = await open({ filename: dbFile, driver: sqlite3.Database });
        await initializeSchema(db);
        return db;
      })();
    }
    return dbPromise;
  }

  return {
    async createThread(input) {
      const db = await getDb();
      const id = idFactory();
      const context = normalizeContext(input.context);
      await db.run(
        `INSERT INTO dev_ai_threads (
          id, owner_actor, title, mode, created_at, updated_at,
          current_form_path, current_field_id, current_formula_kind, last_message_preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.ownerActor,
        input.title,
        input.mode,
        input.now,
        input.now,
        context.formPath || null,
        context.fieldId || null,
        context.formulaKind || null,
        ""
      );
      return (await this.getThread(input.ownerActor, id)) as DevAiThread;
    },

    async listThreads(ownerActor, limit) {
      const db = await getDb();
      const rows = await db.all<ThreadRow[]>(
        `SELECT * FROM dev_ai_threads
         WHERE owner_actor = ? AND archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
        ownerActor,
        limit
      );
      return rows.map(mapThread);
    },

    async getThread(ownerActor, threadId) {
      const db = await getDb();
      const row = await db.get<ThreadRow>(
        "SELECT * FROM dev_ai_threads WHERE owner_actor = ? AND id = ?",
        ownerActor,
        threadId
      );
      return row ? mapThread(row) : null;
    },

    async listMessages(ownerActor, threadId, limit = 200) {
      const db = await getDb();
      const rows = await db.all<MessageRow[]>(
        `SELECT * FROM (
           SELECT * FROM dev_ai_messages
           WHERE owner_actor = ? AND thread_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         ) ORDER BY created_at ASC`,
        ownerActor,
        threadId,
        limit
      );
      return rows.map(mapMessage);
    },

    async listArtifacts(ownerActor, threadId, limit = 100) {
      const db = await getDb();
      const thread = await this.getThread(ownerActor, threadId);
      if (!thread) return [];
      const rows = await db.all<ArtifactRow[]>(
        `SELECT * FROM (
           SELECT * FROM dev_ai_message_artifacts
           WHERE thread_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         ) ORDER BY created_at ASC`,
        threadId,
        limit
      );
      return rows.map(mapArtifact);
    },

    async appendMessage(input) {
      const db = await getDb();
      const id = idFactory();
      await db.run(
        `INSERT INTO dev_ai_messages (
          id, thread_id, owner_actor, role, content, intent, model, status, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.threadId,
        input.ownerActor,
        input.role,
        input.content,
        input.intent ?? null,
        input.model ?? null,
        input.status ?? "completed",
        input.now,
        JSON.stringify(input.metadata ?? {})
      );
      const row = await db.get<MessageRow>("SELECT * FROM dev_ai_messages WHERE id = ?", id);
      return mapMessage(row as MessageRow);
    },

    async appendArtifact(input) {
      const db = await getDb();
      const id = idFactory();
      await db.run(
        `INSERT INTO dev_ai_message_artifacts (
          id, message_id, thread_id, type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        input.messageId,
        input.threadId,
        input.type,
        JSON.stringify(input.payload),
        input.now
      );
      const row = await db.get<ArtifactRow>("SELECT * FROM dev_ai_message_artifacts WHERE id = ?", id);
      return mapArtifact(row as ArtifactRow);
    },

    async updateThreadAfterMessage(params) {
      const db = await getDb();
      const context = params.context ? normalizeContext(params.context) : null;
      if (context) {
        await db.run(
          `UPDATE dev_ai_threads
           SET updated_at = ?, last_message_preview = ?,
               current_form_path = COALESCE(?, current_form_path),
               current_field_id = COALESCE(?, current_field_id),
               current_formula_kind = COALESCE(?, current_formula_kind)
           WHERE owner_actor = ? AND id = ?`,
          params.updatedAt,
          params.preview,
          context.formPath || null,
          context.fieldId || null,
          context.formulaKind || null,
          params.ownerActor,
          params.threadId
        );
      } else {
        await db.run(
          `UPDATE dev_ai_threads
           SET updated_at = ?, last_message_preview = ?
           WHERE owner_actor = ? AND id = ?`,
          params.updatedAt,
          params.preview,
          params.ownerActor,
          params.threadId
        );
      }
      return this.getThread(params.ownerActor, params.threadId);
    },

    async archiveThread(ownerActor, threadId, archivedAt) {
      const db = await getDb();
      await db.run(
        "UPDATE dev_ai_threads SET archived_at = ?, updated_at = ? WHERE owner_actor = ? AND id = ?",
        archivedAt,
        archivedAt,
        ownerActor,
        threadId
      );
      return this.getThread(ownerActor, threadId);
    },

    async updateThreadSummary(params) {
      const db = await getDb();
      await db.run(
        `UPDATE dev_ai_threads
         SET summary = ?, summary_updated_at = ?, summary_message_id = ?
         WHERE owner_actor = ? AND id = ?`,
        params.summary,
        params.summaryUpdatedAt,
        params.summaryMessageId,
        params.ownerActor,
        params.threadId
      );
      return this.getThread(params.ownerActor, params.threadId);
    },

    async pruneThreadItems(params) {
      const db = await getDb();
      const thread = await this.getThread(params.ownerActor, params.threadId);
      if (!thread) return;
      const maxMessages = Math.max(1, Math.trunc(params.maxMessages));
      const maxArtifacts = Math.max(1, Math.trunc(params.maxArtifacts));
      await db.run(
        `DELETE FROM dev_ai_message_artifacts
         WHERE thread_id = ?
           AND id NOT IN (
             SELECT id FROM dev_ai_message_artifacts
             WHERE thread_id = ?
             ORDER BY created_at DESC
             LIMIT ?
           )`,
        params.threadId,
        params.threadId,
        maxArtifacts
      );
      await db.run(
        `DELETE FROM dev_ai_messages
         WHERE owner_actor = ? AND thread_id = ?
           AND id NOT IN (
             SELECT id FROM dev_ai_messages
             WHERE owner_actor = ? AND thread_id = ?
             ORDER BY created_at DESC
             LIMIT ?
           )
           AND (? IS NULL OR id <> ?)`,
        params.ownerActor,
        params.threadId,
        params.ownerActor,
        params.threadId,
        maxMessages,
        thread.summaryMessageId,
        thread.summaryMessageId
      );
    },

    async pruneActorThreads(params) {
      const db = await getDb();
      const nowMs = Date.parse(params.now);
      if (!Number.isFinite(nowMs)) return;
      const activeRetentionMs = Math.max(0, params.activeRetentionDays) * 24 * 60 * 60 * 1000;
      const archivedRetentionMs = Math.max(0, params.archivedRetentionDays) * 24 * 60 * 60 * 1000;
      if (archivedRetentionMs > 0) {
        await db.run(
          `DELETE FROM dev_ai_threads
           WHERE owner_actor = ?
             AND archived_at IS NOT NULL
             AND archived_at < ?`,
          params.ownerActor,
          new Date(nowMs - archivedRetentionMs).toISOString()
        );
      }
      if (activeRetentionMs > 0) {
        await db.run(
          `DELETE FROM dev_ai_threads
           WHERE owner_actor = ?
             AND archived_at IS NULL
             AND updated_at < ?`,
          params.ownerActor,
          new Date(nowMs - activeRetentionMs).toISOString()
        );
      }
      const maxThreads = Math.max(1, Math.trunc(params.maxThreads));
      await db.run(
        `DELETE FROM dev_ai_threads
         WHERE owner_actor = ?
           AND id NOT IN (
             SELECT id FROM dev_ai_threads
             WHERE owner_actor = ?
             ORDER BY archived_at IS NULL DESC, updated_at DESC
             LIMIT ?
           )`,
        params.ownerActor,
        params.ownerActor,
        maxThreads
      );
    },

    async close() {
      if (!dbPromise) return;
      const db = await dbPromise;
      dbPromise = null;
      await db.close();
    },
  };
}

export const devAiThreadRepository = createDevAiThreadRepository();
