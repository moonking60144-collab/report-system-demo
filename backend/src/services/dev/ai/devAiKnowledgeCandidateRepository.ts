import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../../config/env";
import type {
  DevAiFeedbackKind,
  DevAiFeedbackRequest,
  DevAiKnowledgeCandidate,
  DevAiKnowledgeCandidateListResult,
  DevAiKnowledgeCandidateStatus,
  DevAiKnowledgeDomain,
} from "@shared-types/ragicDefinitions";

interface CandidateRow {
  id: string;
  fingerprint: string;
  kind: DevAiFeedbackKind;
  status: DevAiKnowledgeCandidateStatus;
  domain: DevAiKnowledgeDomain;
  title: string;
  payload_json: string;
  search_text: string;
  source_key: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  approved_feedback_id: string | null;
}

export interface CreateKnowledgeCandidateInput {
  fingerprint: string;
  kind: DevAiFeedbackKind;
  domain: DevAiKnowledgeDomain;
  title: string;
  payload: DevAiFeedbackRequest;
  sourceKey?: string | null;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  createdBy: string;
  now: string;
}

export interface ListKnowledgeCandidatesInput {
  status?: DevAiKnowledgeCandidateStatus;
  kind?: DevAiFeedbackKind;
  query?: string;
  limit: number;
  cursor?: KnowledgeCandidateCursor;
}

export interface KnowledgeCandidateCursor {
  updatedAt: string;
  id: string;
}

export interface KnowledgeCandidateRepositoryListResult {
  items: DevAiKnowledgeCandidate[];
  counts: DevAiKnowledgeCandidateListResult["counts"];
  hasMore: boolean;
  nextCursor: KnowledgeCandidateCursor | null;
}

export interface DevAiKnowledgeCandidateRepository {
  createCandidate(input: CreateKnowledgeCandidateInput): Promise<{
    candidate: DevAiKnowledgeCandidate;
    created: boolean;
  }>;
  listCandidates(input: ListKnowledgeCandidatesInput): Promise<KnowledgeCandidateRepositoryListResult>;
  getCandidate(candidateId: string): Promise<DevAiKnowledgeCandidate | null>;
  updateCandidate(input: {
    candidateId: string;
    fingerprint: string;
    title: string;
    domain: DevAiKnowledgeDomain;
    payload: DevAiFeedbackRequest;
    updatedBy: string;
    updatedAt: string;
  }): Promise<DevAiKnowledgeCandidate | null>;
  beginApproval(input: {
    candidateId: string;
    reviewedBy: string;
    reviewedAt: string;
    reviewNote: string | null;
  }): Promise<DevAiKnowledgeCandidate | null>;
  finalizeApproval(input: {
    candidateId: string;
    approvedFeedbackId: string;
    updatedAt: string;
  }): Promise<DevAiKnowledgeCandidate | null>;
  rejectCandidate(input: {
    candidateId: string;
    reviewedBy: string;
    reviewedAt: string;
    reviewNote: string | null;
  }): Promise<DevAiKnowledgeCandidate | null>;
  close(): Promise<void>;
}

export interface DevAiKnowledgeCandidateRepositoryDeps {
  dbFile?: string;
  idFactory?: () => string;
}

function parsePayload(raw: string): DevAiFeedbackRequest {
  return JSON.parse(raw) as DevAiFeedbackRequest;
}

function candidateSearchText(title: string, payload: DevAiFeedbackRequest): string {
  return [
    title,
    payload.question,
    payload.answer,
    payload.objective,
    payload.proposedFormula,
    payload.explanation,
    payload.formPath,
    payload.fieldId,
    payload.formulaKind,
    payload.notes,
    payload.sourceIds?.join(" "),
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function mapCandidate(row: CandidateRow): DevAiKnowledgeCandidate {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    domain: row.domain,
    title: row.title,
    payload: parsePayload(row.payload_json),
    sourceKey: row.source_key,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by ?? row.created_by,
    updatedAt: row.updated_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    approvedFeedbackId: row.approved_feedback_id,
  };
}

async function initializeSchema(db: Database): Promise<void> {
  await db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS dev_ai_knowledge_candidates (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      domain TEXT NOT NULL DEFAULT 'ragic',
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      source_key TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT,
      approved_feedback_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dev_ai_knowledge_candidates_status_updated
      ON dev_ai_knowledge_candidates(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dev_ai_knowledge_candidates_kind_updated
      ON dev_ai_knowledge_candidates(kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dev_ai_knowledge_candidate_status_summary (
      status TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO dev_ai_knowledge_candidate_status_summary(status, count) VALUES
      ('pending', 0),
      ('publishing', 0),
      ('approved', 0),
      ('rejected', 0);

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_summary_insert
    AFTER INSERT ON dev_ai_knowledge_candidates
    BEGIN
      UPDATE dev_ai_knowledge_candidate_status_summary
      SET count = count + 1
      WHERE status = NEW.status;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_summary_delete
    AFTER DELETE ON dev_ai_knowledge_candidates
    BEGIN
      UPDATE dev_ai_knowledge_candidate_status_summary
      SET count = count - 1
      WHERE status = OLD.status;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_summary_update
    AFTER UPDATE OF status ON dev_ai_knowledge_candidates
    WHEN OLD.status <> NEW.status
    BEGIN
      UPDATE dev_ai_knowledge_candidate_status_summary
      SET count = count - 1
      WHERE status = OLD.status;
      UPDATE dev_ai_knowledge_candidate_status_summary
      SET count = count + 1
      WHERE status = NEW.status;
    END;

  `);
  const columns = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(dev_ai_knowledge_candidates)"
  );
  if (!columns.some((column) => column.name === "updated_by")) {
    await db.exec("ALTER TABLE dev_ai_knowledge_candidates ADD COLUMN updated_by TEXT");
  }
  if (!columns.some((column) => column.name === "search_text")) {
    await db.exec(
      "ALTER TABLE dev_ai_knowledge_candidates ADD COLUMN search_text TEXT NOT NULL DEFAULT ''"
    );
  }
  await db.run(
    "UPDATE dev_ai_knowledge_candidates SET updated_by = created_by WHERE updated_by IS NULL"
  );
  await db.run(
    `UPDATE dev_ai_knowledge_candidates
     SET search_text = trim(
       title || char(10) ||
       COALESCE(json_extract(payload_json, '$.question'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.answer'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.objective'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.proposedFormula'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.explanation'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.formPath'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.fieldId'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.formulaKind'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.notes'), '') || char(10) ||
       COALESCE(json_extract(payload_json, '$.sourceIds'), '')
     )
     WHERE search_text = ''`
  );
  await db.exec(`
    DROP TRIGGER IF EXISTS trg_dev_ai_knowledge_candidates_search_insert;
    DROP TRIGGER IF EXISTS trg_dev_ai_knowledge_candidates_search_delete;
    DROP TRIGGER IF EXISTS trg_dev_ai_knowledge_candidates_search_update;
    DROP TABLE IF EXISTS dev_ai_knowledge_candidates_search;

    CREATE VIRTUAL TABLE IF NOT EXISTS dev_ai_knowledge_candidates_search_v2 USING fts5(
      search_text,
      content='dev_ai_knowledge_candidates',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_search_v2_insert
    AFTER INSERT ON dev_ai_knowledge_candidates
    BEGIN
      INSERT INTO dev_ai_knowledge_candidates_search_v2(rowid, search_text)
      VALUES (NEW.rowid, NEW.search_text);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_search_v2_delete
    AFTER DELETE ON dev_ai_knowledge_candidates
    BEGIN
      INSERT INTO dev_ai_knowledge_candidates_search_v2(
        dev_ai_knowledge_candidates_search_v2, rowid, search_text
      ) VALUES ('delete', OLD.rowid, OLD.search_text);
    END;

    CREATE TRIGGER IF NOT EXISTS trg_dev_ai_knowledge_candidates_search_v2_update
    AFTER UPDATE OF search_text ON dev_ai_knowledge_candidates
    BEGIN
      INSERT INTO dev_ai_knowledge_candidates_search_v2(
        dev_ai_knowledge_candidates_search_v2, rowid, search_text
      ) VALUES ('delete', OLD.rowid, OLD.search_text);
      INSERT INTO dev_ai_knowledge_candidates_search_v2(rowid, search_text)
      VALUES (NEW.rowid, NEW.search_text);
    END;
  `);
  await db.run(
    `UPDATE dev_ai_knowledge_candidate_status_summary
     SET count = (
       SELECT COUNT(*)
       FROM dev_ai_knowledge_candidates
       WHERE dev_ai_knowledge_candidates.status = dev_ai_knowledge_candidate_status_summary.status
     )`
  );
  await db.run(
    "INSERT INTO dev_ai_knowledge_candidates_search_v2(dev_ai_knowledge_candidates_search_v2) VALUES ('rebuild')"
  );
}

function ftsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function createDevAiKnowledgeCandidateRepository(
  deps: DevAiKnowledgeCandidateRepositoryDeps = {}
): DevAiKnowledgeCandidateRepository {
  const rawDbFile = deps.dbFile ?? env.DEV_AI_KNOWLEDGE_DB_FILE;
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
    async createCandidate(input) {
      const db = await getDb();
      const candidateId = idFactory();
      const inserted = await db.run(
        `INSERT OR IGNORE INTO dev_ai_knowledge_candidates (
          id, fingerprint, kind, status, domain, title, payload_json, search_text,
          source_key, source_thread_id, source_message_id,
          created_by, created_at, updated_by, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateId,
        input.fingerprint,
        input.kind,
        input.domain,
        input.title,
        JSON.stringify(input.payload),
        candidateSearchText(input.title, input.payload),
        input.sourceKey ?? null,
        input.sourceThreadId ?? null,
        input.sourceMessageId ?? null,
        input.createdBy,
        input.now,
        input.createdBy,
        input.now
      );
      const row = await db.get<CandidateRow>(
        "SELECT * FROM dev_ai_knowledge_candidates WHERE fingerprint = ?",
        input.fingerprint
      );
      if (!row) throw new Error("Knowledge candidate was not persisted");
      return { candidate: mapCandidate(row), created: inserted.changes === 1 };
    },

    async listCandidates(input) {
      const db = await getDb();
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (input.status) {
        clauses.push("status = ?");
        params.push(input.status);
      }
      if (input.kind) {
        clauses.push("kind = ?");
        params.push(input.kind);
      }
      const query = input.query?.trim();
      if (query) {
        if (Array.from(query).length >= 3) {
          clauses.push(
            `rowid IN (
              SELECT rowid
              FROM dev_ai_knowledge_candidates_search_v2
              WHERE dev_ai_knowledge_candidates_search_v2 MATCH ?
            )`
          );
          params.push(ftsPhrase(query));
        } else {
          clauses.push("instr(lower(search_text), lower(?)) > 0");
          params.push(query);
        }
      }
      if (input.cursor) {
        clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
        params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.all<CandidateRow[]>(
        `SELECT * FROM dev_ai_knowledge_candidates
         ${where}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        ...params,
        input.limit + 1
      );
      const hasMore = rows.length > input.limit;
      const visibleRows = hasMore ? rows.slice(0, input.limit) : rows;
      const countRows = await db.all<Array<{ status: DevAiKnowledgeCandidateStatus; count: number }>>(
        `SELECT status, count
         FROM dev_ai_knowledge_candidate_status_summary`
      );
      const counts: DevAiKnowledgeCandidateListResult["counts"] = {
        total: 0,
        pending: 0,
        publishing: 0,
        approved: 0,
        rejected: 0,
      };
      for (const countRow of countRows) {
        counts[countRow.status] = Number(countRow.count);
        counts.total += Number(countRow.count);
      }
      const lastRow = visibleRows.at(-1);
      return {
        items: visibleRows.map(mapCandidate),
        counts,
        hasMore,
        nextCursor:
          hasMore && lastRow
            ? { updatedAt: lastRow.updated_at, id: lastRow.id }
            : null,
      };
    },

    async getCandidate(candidateId) {
      const db = await getDb();
      const row = await db.get<CandidateRow>(
        "SELECT * FROM dev_ai_knowledge_candidates WHERE id = ?",
        candidateId
      );
      return row ? mapCandidate(row) : null;
    },

    async updateCandidate(input) {
      const db = await getDb();
      const updated = await db.run(
        `UPDATE dev_ai_knowledge_candidates
         SET fingerprint = ?, title = ?, domain = ?, payload_json = ?,
             search_text = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        input.fingerprint,
        input.title,
        input.domain,
        JSON.stringify(input.payload),
        candidateSearchText(input.title, input.payload),
        input.updatedBy,
        input.updatedAt,
        input.candidateId
      );
      return updated.changes === 1 ? this.getCandidate(input.candidateId) : null;
    },

    async beginApproval(input) {
      const db = await getDb();
      const updated = await db.run(
        `UPDATE dev_ai_knowledge_candidates
         SET status = 'publishing', reviewed_by = ?, reviewed_at = ?, review_note = ?,
             updated_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        input.reviewedBy,
        input.reviewedAt,
        input.reviewNote,
        input.reviewedBy,
        input.reviewedAt,
        input.candidateId
      );
      return updated.changes === 1 ? this.getCandidate(input.candidateId) : null;
    },

    async finalizeApproval(input) {
      const db = await getDb();
      const updated = await db.run(
        `UPDATE dev_ai_knowledge_candidates
         SET status = 'approved', approved_feedback_id = ?, updated_at = ?
         WHERE id = ? AND status = 'publishing'`,
        input.approvedFeedbackId,
        input.updatedAt,
        input.candidateId
      );
      return updated.changes === 1 ? this.getCandidate(input.candidateId) : null;
    },

    async rejectCandidate(input) {
      const db = await getDb();
      const updated = await db.run(
        `UPDATE dev_ai_knowledge_candidates
         SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?,
             updated_by = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        input.reviewedBy,
        input.reviewedAt,
        input.reviewNote,
        input.reviewedBy,
        input.reviewedAt,
        input.candidateId
      );
      return updated.changes === 1 ? this.getCandidate(input.candidateId) : null;
    },

    async close() {
      if (!dbPromise) return;
      const db = await dbPromise;
      dbPromise = null;
      await db.close();
    },
  };
}

export const devAiKnowledgeCandidateRepository = createDevAiKnowledgeCandidateRepository();
