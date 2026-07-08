import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { randomUUID } from "crypto";
import { HttpError } from "../utils/httpError";
import { createKeyedSerialQueue } from "../utils/keyedSerialQueue";
import {
  CURRENT_IT_SOP_TEMPLATE_VERSION,
  createDefaultItSopDocument,
} from "./itSopDefaultDocument";

export type ItSopSectionKind = "text" | "table" | "code" | "checklist";

export interface ItSopTableRow {
  id: string;
  cells: string[];
}

export interface ItSopChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ItSopSection {
  id: string;
  title: string;
  kind: ItSopSectionKind;
  text: string;
  rows: ItSopTableRow[];
  items: ItSopChecklistItem[];
  collapsed: boolean;
}

export interface ItSopDocument {
  id: string;
  title: string;
  summary: string;
  templateVersion: number;
  sections: ItSopSection[];
  updatedAt: string;
  updatedByLabel: string | null;
}

const DOCUMENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_SECTIONS = 80;
const MAX_SECTION_TITLE_LENGTH = 160;
const MAX_SECTION_TEXT_LENGTH = 24000;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 8;
const MAX_TABLE_CELL_LENGTH = 2000;
const MAX_CHECKLIST_ITEMS = 200;
const MAX_CHECKLIST_TEXT_LENGTH = 1000;
const MAX_DOCUMENT_JSON_BYTES = 512 * 1024;
const GOSHEN_REMOVAL_TEMPLATE_VERSION = 3;
const GENERIC_NEW_PC_TEMPLATE_VERSION = 4;

function defaultSopRoot(): string {
  return resolve(process.cwd(), ".data", "sop-documents");
}

function assertDocumentId(documentId: string): string {
  const id = String(documentId ?? "").trim();
  if (!DOCUMENT_ID_RE.test(id)) {
    throw new HttpError(400, "invalid SOP document id", "IT_SOP_DOCUMENT_ID_INVALID");
  }
  return id;
}

function normalizeText(value: unknown, maxLength: number, fieldName: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string`, "IT_SOP_PAYLOAD_INVALID");
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `${fieldName} too long`, "IT_SOP_PAYLOAD_TOO_LARGE");
  }
  return value;
}

function normalizeId(value: unknown, fallbackPrefix: string): string {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    return value;
  }
  return `${fallbackPrefix}-${randomUUID()}`;
}

function normalizeSectionKind(value: unknown): ItSopSectionKind {
  if (value === "text" || value === "table" || value === "code" || value === "checklist") {
    return value;
  }
  throw new HttpError(400, "section kind invalid", "IT_SOP_PAYLOAD_INVALID");
}

function normalizeTableRows(value: unknown): ItSopTableRow[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "section rows must be an array", "IT_SOP_PAYLOAD_INVALID");
  }
  if (value.length > MAX_TABLE_ROWS) {
    throw new HttpError(400, "too many table rows", "IT_SOP_PAYLOAD_TOO_LARGE");
  }
  return value.map((rowInput, rowIndex) => {
    if (!rowInput || typeof rowInput !== "object" || Array.isArray(rowInput)) {
      throw new HttpError(400, "table row invalid", "IT_SOP_PAYLOAD_INVALID");
    }
    const row = rowInput as Record<string, unknown>;
    if (!Array.isArray(row.cells)) {
      throw new HttpError(400, "table row cells must be an array", "IT_SOP_PAYLOAD_INVALID");
    }
    if (row.cells.length > MAX_TABLE_CELLS) {
      throw new HttpError(400, "too many table cells", "IT_SOP_PAYLOAD_TOO_LARGE");
    }
    return {
      id: normalizeId(row.id, `row-${rowIndex}`),
      cells: row.cells.map((cell, cellIndex) =>
        normalizeText(cell, MAX_TABLE_CELL_LENGTH, `row.cells[${cellIndex}]`)
      ),
    };
  });
}

function normalizeChecklistItems(value: unknown): ItSopChecklistItem[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "section items must be an array", "IT_SOP_PAYLOAD_INVALID");
  }
  if (value.length > MAX_CHECKLIST_ITEMS) {
    throw new HttpError(400, "too many checklist items", "IT_SOP_PAYLOAD_TOO_LARGE");
  }
  return value.map((itemInput, index) => {
    if (!itemInput || typeof itemInput !== "object" || Array.isArray(itemInput)) {
      throw new HttpError(400, "checklist item invalid", "IT_SOP_PAYLOAD_INVALID");
    }
    const item = itemInput as Record<string, unknown>;
    return {
      id: normalizeId(item.id, `item-${index}`),
      text: normalizeText(item.text, MAX_CHECKLIST_TEXT_LENGTH, `items[${index}].text`),
      checked: item.checked === true,
    };
  });
}

function normalizeSection(input: unknown, index: number): ItSopSection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "section invalid", "IT_SOP_PAYLOAD_INVALID");
  }
  const section = input as Record<string, unknown>;
  const kind = normalizeSectionKind(section.kind);
  return {
    id: normalizeId(section.id, `section-${index}`),
    title: normalizeText(section.title, MAX_SECTION_TITLE_LENGTH, `sections[${index}].title`),
    kind,
    text:
      kind === "text" || kind === "code"
        ? normalizeText(section.text ?? "", MAX_SECTION_TEXT_LENGTH, `sections[${index}].text`)
        : "",
    rows: kind === "table" ? normalizeTableRows(section.rows) : [],
    items: kind === "checklist" ? normalizeChecklistItems(section.items) : [],
    collapsed: section.collapsed === true,
  };
}

function normalizeTemplateVersion(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function normalizeDocument(documentId: string, input: unknown): ItSopDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "SOP payload invalid", "IT_SOP_PAYLOAD_INVALID");
  }
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) {
    throw new HttpError(400, "sections must be an array", "IT_SOP_PAYLOAD_INVALID");
  }
  if (raw.sections.length > MAX_SECTIONS) {
    throw new HttpError(400, "too many sections", "IT_SOP_PAYLOAD_TOO_LARGE");
  }

  const normalized: ItSopDocument = {
    id: documentId,
    title: normalizeText(raw.title, MAX_TITLE_LENGTH, "title"),
    summary: normalizeText(raw.summary ?? "", MAX_SUMMARY_LENGTH, "summary"),
    templateVersion: normalizeTemplateVersion(raw.templateVersion),
    sections: raw.sections.map((section, index) => normalizeSection(section, index)),
    updatedAt: new Date().toISOString(),
    updatedByLabel: null,
  };
  const size = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (size > MAX_DOCUMENT_JSON_BYTES) {
    throw new HttpError(400, "SOP document too large", "IT_SOP_PAYLOAD_TOO_LARGE");
  }
  return normalized;
}

function resolveExpectedUpdatedAt(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "SOP payload invalid", "IT_SOP_PAYLOAD_INVALID");
  }
  const value = String((input as Record<string, unknown>).updatedAt ?? "").trim();
  if (!value) {
    throw new HttpError(
      400,
      "updatedAt required for SOP optimistic concurrency",
      "IT_SOP_EXPECTED_UPDATED_AT_REQUIRED"
    );
  }
  return value;
}

function includesRemovedGoshenContent(value: string): boolean {
  return value.includes("GOSHEN");
}

function removeRemovedGoshenSentences(value: string): string {
  return value
    .replace(/[^。]*GOSHEN[^。]*(?:。|$)/g, "")
    .replace(/LINE、MIS、/g, "LINE、MIS")
    .trim();
}

function isLegacySingleMachineNewPcDocument(
  document: ItSopDocument,
  hadLegacyRecordTitle: boolean
): boolean {
  const serialized = JSON.stringify(document);
  const sectionIds = new Set(document.sections.map((section) => section.id));
  return (
    hadLegacyRecordTitle ||
    serialized.includes("WK-E-PC-001") ||
    serialized.includes("WK-E-PC-002") ||
    serialized.includes("192.168.1.181") ||
    serialized.includes("34-5A-60-E1-25-C5") ||
    serialized.includes("FDS\\FD0287") ||
    sectionIds.has("key-findings") ||
    sectionIds.has("asset-profile") ||
    sectionIds.has("profile-follow-up")
  );
}

function replaceWithGenericNewPcTemplate(document: ItSopDocument): void {
  const replacement = createDefaultItSopDocument(document.id);
  document.title = replacement.title;
  document.summary = replacement.summary;
  document.sections = replacement.sections;
}

function migrateDocumentTemplate(document: ItSopDocument, fromTemplateVersion: number): void {
  const hadLegacyRecordTitle = document.title === "WK-E-PC-001 新電腦建置紀錄 / index";
  if (
    fromTemplateVersion < GOSHEN_REMOVAL_TEMPLATE_VERSION &&
    hadLegacyRecordTitle
  ) {
    document.title = "新電腦配置";
  }
  if (fromTemplateVersion < GOSHEN_REMOVAL_TEMPLATE_VERSION) {
    document.summary = removeRemovedGoshenSentences(document.summary);
    document.sections = document.sections
      .filter(
        (section) =>
          section.id !== "goshen-status" &&
          section.id !== "goshen-command" &&
          !includesRemovedGoshenContent(section.title)
      )
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) =>
          row.cells.every((cell) => !includesRemovedGoshenContent(cell))
        ),
        items: section.items.filter((item) => !includesRemovedGoshenContent(item.text)),
      }));
  }
  if (
    fromTemplateVersion < GENERIC_NEW_PC_TEMPLATE_VERSION &&
    isLegacySingleMachineNewPcDocument(document, hadLegacyRecordTitle)
  ) {
    replaceWithGenericNewPcTemplate(document);
  }
}

export class ItSopDocumentService {
  private readonly writeQueue = createKeyedSerialQueue();

  constructor(private readonly root = defaultSopRoot()) {}

  async getDocument(documentIdInput: string): Promise<ItSopDocument> {
    const documentId = assertDocumentId(documentIdInput);
    try {
      const raw = await readFile(this.documentPath(documentId), "utf8");
      return normalizeStoredDocument(documentId, JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return createDefaultItSopDocument(documentId);
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "failed to read SOP document", "IT_SOP_READ_FAILED");
    }
  }

  async saveDocument(
    documentIdInput: string,
    payload: unknown,
    actorLabel: string | null
  ): Promise<ItSopDocument> {
    const documentId = assertDocumentId(documentIdInput);
    let savedDocument: ItSopDocument | null = null;
    await this.writeQueue.enqueue(documentId, async () => {
      savedDocument = await this.saveDocumentUnlocked(documentId, payload, actorLabel);
    });
    if (!savedDocument) {
      throw new HttpError(500, "failed to save SOP document", "IT_SOP_WRITE_FAILED");
    }
    return savedDocument;
  }

  private documentPath(documentId: string): string {
    return join(this.root, `${documentId}.json`);
  }

  private async saveDocumentUnlocked(
    documentId: string,
    payload: unknown,
    actorLabel: string | null
  ): Promise<ItSopDocument> {
    const expectedUpdatedAt = resolveExpectedUpdatedAt(payload);
    const currentDocument = await this.getDocument(documentId);
    if (currentDocument.updatedAt !== expectedUpdatedAt) {
      throw new HttpError(
        409,
        "SOP 文件已被其他人更新，請先重新載入後再儲存。",
        "IT_SOP_VERSION_CONFLICT"
      );
    }

    const fromTemplateVersion = normalizeTemplateVersion(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).templateVersion
        : 0
    );
    const document = normalizeDocument(documentId, payload);
    migrateDocumentTemplate(document, fromTemplateVersion);
    document.templateVersion = CURRENT_IT_SOP_TEMPLATE_VERSION;
    document.updatedByLabel = actorLabel;
    await mkdir(dirname(this.documentPath(documentId)), { recursive: true });
    const tempPath = `${this.documentPath(documentId)}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(tempPath, this.documentPath(documentId));
    return document;
  }
}

function normalizeStoredDocument(documentId: string, payload: unknown): ItSopDocument {
  const normalized = normalizeDocument(documentId, payload);
  const raw = payload as Record<string, unknown>;
  const storedTemplateVersion = normalizeTemplateVersion(raw.templateVersion);
  normalized.templateVersion = storedTemplateVersion;
  normalized.updatedAt =
    typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : normalized.updatedAt;
  normalized.updatedByLabel =
    typeof raw.updatedByLabel === "string" && raw.updatedByLabel.trim()
      ? raw.updatedByLabel.trim()
      : null;
  if (storedTemplateVersion < CURRENT_IT_SOP_TEMPLATE_VERSION) {
    migrateDocumentTemplate(normalized, storedTemplateVersion);
    normalized.templateVersion = CURRENT_IT_SOP_TEMPLATE_VERSION;
  }
  return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export const itSopDocumentService = new ItSopDocumentService();
