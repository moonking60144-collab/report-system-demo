import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { HttpError } from "../../../utils/httpError";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { devAiKnowledgeBaseService } from "./devAiKnowledgeBaseService";
import type {
  DevAiCompiledKnowledgeFile,
  DevAiKnowledgeCompileResult,
  DevAiKnowledgeStatusResult,
} from "@shared-types/ragicDefinitions";

const log = createLogger("dev-ai-knowledge-compiler");

const CHAT_FILE_NAME = "approved-chat-answers.md";
const FORMULA_FILE_NAME = "approved-formula-examples.md";

type ApprovedExampleKind = DevAiCompiledKnowledgeFile["kind"];

interface ApprovedExampleEntry {
  title: string;
  content: string;
  metadata: {
    feedbackId?: string | null;
    kind?: string | null;
    createdAt?: string | null;
    actor?: string | null;
    formPath?: string | null;
    fieldId?: string | null;
    formulaKind?: string | null;
  };
}

interface ParsedApprovedExamples {
  entries: ApprovedExampleEntry[];
  malformed: number;
}

export interface DevAiKnowledgeCompilerOptions {
  actor?: string | null;
  clientId?: string | null;
  tabId?: string | null;
}

export interface DevAiKnowledgeCompilerServiceDeps {
  enabled?: boolean;
  approvedExamplesFile?: string;
  compiledKnowledgeDir?: string;
  now?: () => Date;
  onCompiled?: () => void;
}

export interface DevAiKnowledgeCompilerService {
  getStatus(): Promise<DevAiKnowledgeStatusResult>;
  compile(options?: DevAiKnowledgeCompilerOptions): Promise<DevAiKnowledgeCompileResult>;
}

function toIso(value: Date | number | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readApprovedExamples(filePath: string): Promise<ParsedApprovedExamples> {
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (!raw.trim()) return { entries: [], malformed: 0 };

  let malformed = 0;
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): ApprovedExampleEntry[] => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
        const metadata =
          typeof parsed.metadata === "object" && parsed.metadata !== null
            ? (parsed.metadata as Record<string, unknown>)
            : {};
        const kind = typeof metadata.kind === "string" ? metadata.kind : "";
        if (!title || !content || (kind !== "chat-answer" && kind !== "formula-suggestion")) {
          malformed += 1;
          return [];
        }
        return [{
          title: maskSecrets(title),
          content: maskSecrets(content),
          metadata: {
            feedbackId:
              typeof metadata.feedbackId === "string" ? maskSecrets(metadata.feedbackId) : null,
            kind,
            createdAt: typeof metadata.createdAt === "string" ? metadata.createdAt : null,
            actor: typeof metadata.actor === "string" ? maskSecrets(metadata.actor) : null,
            formPath: typeof metadata.formPath === "string" ? maskSecrets(metadata.formPath) : null,
            fieldId: typeof metadata.fieldId === "string" ? maskSecrets(metadata.fieldId) : null,
            formulaKind:
              typeof metadata.formulaKind === "string" ? maskSecrets(metadata.formulaKind) : null,
          },
        }];
      } catch {
        malformed += 1;
        return [];
      }
    });
  return { entries, malformed };
}

function groupEntries(entries: ApprovedExampleEntry[]): Record<ApprovedExampleKind, ApprovedExampleEntry[]> {
  return {
    "chat-answer": entries
      .filter((entry) => entry.metadata.kind === "chat-answer")
      .sort(compareApprovedEntries),
    "formula-suggestion": entries
      .filter((entry) => entry.metadata.kind === "formula-suggestion")
      .sort(compareApprovedEntries),
  };
}

function compareApprovedEntries(a: ApprovedExampleEntry, b: ApprovedExampleEntry): number {
  return (
    String(a.metadata.createdAt ?? "").localeCompare(String(b.metadata.createdAt ?? "")) ||
    String(a.metadata.feedbackId ?? "").localeCompare(String(b.metadata.feedbackId ?? "")) ||
    a.title.localeCompare(b.title)
  );
}

function renderMarkdown(params: {
  kind: ApprovedExampleKind;
  compiledAt: string;
  sourcePath: string;
  entries: ApprovedExampleEntry[];
}): string {
  const title =
    params.kind === "chat-answer"
      ? "Dev AI Approved Chat Answers"
      : "Dev AI Approved Formula Examples";
  const lines = [
    `# ${title}`,
    "",
    "> 這是 Dev AI Knowledge Compiler 從 approved examples ledger 產生的整理稿。",
    "> RAG 應讀取此整理稿與人工 curated knowledge，不直接吃原始互動紀錄。",
    "",
    `- compiledAt: ${params.compiledAt}`,
    `- source: ${params.sourcePath}`,
    `- entries: ${params.entries.length}`,
    "",
  ];

  if (!params.entries.length) {
    lines.push("目前沒有已核准範例。", "");
    return `${lines.join("\n")}\n`;
  }

  params.entries.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.title}`);
    lines.push("");
    lines.push(`- feedbackId: ${entry.metadata.feedbackId ?? "unknown"}`);
    lines.push(`- createdAt: ${entry.metadata.createdAt ?? "unknown"}`);
    if (entry.metadata.actor) lines.push(`- actor: ${entry.metadata.actor}`);
    if (entry.metadata.formPath) lines.push(`- formPath: ${entry.metadata.formPath}`);
    if (entry.metadata.fieldId) lines.push(`- fieldId: ${entry.metadata.fieldId}`);
    if (entry.metadata.formulaKind) lines.push(`- formulaKind: ${entry.metadata.formulaKind}`);
    lines.push("");
    lines.push("### 整理內容");
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

async function compiledFileInfo(
  compiledDir: string,
  fileName: string,
  kind: ApprovedExampleKind
): Promise<DevAiCompiledKnowledgeFile | null> {
  const filePath = path.join(compiledDir, fileName);
  const fileStat = await safeStat(filePath);
  if (!fileStat) return null;
  const content = await readFile(filePath, "utf8");
  return {
    kind,
    path: path.relative(compiledDir, filePath).replace(/\\/g, "/"),
    entries: countCompiledEntries(content),
    bytes: fileStat.size,
  };
}

async function listCompiledFiles(
  compiledDir: string
): Promise<{ files: DevAiCompiledKnowledgeFile[]; totalBytes: number; lastCompiledAt: string | null }> {
  const files = (
    await Promise.all([
      compiledFileInfo(compiledDir, CHAT_FILE_NAME, "chat-answer"),
      compiledFileInfo(compiledDir, FORMULA_FILE_NAME, "formula-suggestion"),
    ])
  ).filter((file): file is DevAiCompiledKnowledgeFile => file !== null);

  const stats = await Promise.all(files.map((file) => safeStat(path.join(compiledDir, file.path))));
  const lastMtime = stats.reduce<number | null>((max, item) => {
    if (!item) return max;
    return max === null ? item.mtimeMs : Math.max(max, item.mtimeMs);
  }, null);
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    lastCompiledAt: toIso(lastMtime),
  };
}

function countCompiledEntries(content: string): number {
  return content.split(/\r?\n/).filter((line) => /^##\s+\d+\./.test(line)).length;
}

export function createDevAiKnowledgeCompilerService(
  deps: DevAiKnowledgeCompilerServiceDeps = {}
): DevAiKnowledgeCompilerService {
  const enabled = deps.enabled ?? env.DEV_AI_ENABLED;
  const approvedExamplesFile = path.resolve(
    deps.approvedExamplesFile ?? env.DEV_AI_APPROVED_EXAMPLES_FILE
  );
  const compiledKnowledgeDir = path.resolve(
    deps.compiledKnowledgeDir ?? env.DEV_AI_COMPILED_KNOWLEDGE_DIR
  );
  const now = deps.now ?? (() => new Date());
  const onCompiled = deps.onCompiled ?? (() => devAiKnowledgeBaseService.invalidateCache());
  let compileChain = Promise.resolve();

  async function buildStatus(): Promise<DevAiKnowledgeStatusResult> {
    const sourceStat = await safeStat(approvedExamplesFile);
    const parsed = await readApprovedExamples(approvedExamplesFile);
    const grouped = groupEntries(parsed.entries);
    const compiled = await listCompiledFiles(compiledKnowledgeDir);
    const sourceUpdatedAt = sourceStat ? toIso(sourceStat.mtimeMs) : null;
    const compiledUpdatedAt = compiled.lastCompiledAt;
    const needsCompile =
      parsed.entries.length > 0 &&
      (!compiledUpdatedAt ||
        (sourceStat !== null && sourceStat.mtimeMs > new Date(compiledUpdatedAt).getTime()));

    return {
      enabled,
      approvedExamplesPath: approvedExamplesFile,
      compiledDir: compiledKnowledgeDir,
      approvedExamples: {
        exists: sourceStat !== null,
        total: parsed.entries.length,
        chatAnswers: grouped["chat-answer"].length,
        formulaSuggestions: grouped["formula-suggestion"].length,
        malformed: parsed.malformed,
        bytes: sourceStat?.size ?? 0,
        updatedAt: sourceUpdatedAt,
      },
      compiled: {
        exists: compiled.files.length > 0,
        needsCompile,
        files: compiled.files,
        totalBytes: compiled.totalBytes,
        lastCompiledAt: compiledUpdatedAt,
      },
    };
  }

  async function doCompile(
    options: DevAiKnowledgeCompilerOptions = {}
  ): Promise<DevAiKnowledgeCompileResult> {
    if (!enabled) throw new HttpError(403, "Dev AI 未啟用", "DEV_AI_DISABLED");
    const compiledAt = now().toISOString();
    const parsed = await readApprovedExamples(approvedExamplesFile);
    const grouped = groupEntries(parsed.entries);
    await mkdir(compiledKnowledgeDir, { recursive: true });

    const targets: Array<{
      kind: ApprovedExampleKind;
      fileName: string;
      content: string;
      entries: number;
    }> = [
      {
        kind: "chat-answer",
        fileName: CHAT_FILE_NAME,
        entries: grouped["chat-answer"].length,
        content: renderMarkdown({
          kind: "chat-answer",
          compiledAt,
          sourcePath: path.basename(approvedExamplesFile),
          entries: grouped["chat-answer"],
        }),
      },
      {
        kind: "formula-suggestion",
        fileName: FORMULA_FILE_NAME,
        entries: grouped["formula-suggestion"].length,
        content: renderMarkdown({
          kind: "formula-suggestion",
          compiledAt,
          sourcePath: path.basename(approvedExamplesFile),
          entries: grouped["formula-suggestion"],
        }),
      },
    ];

    const wroteFiles: DevAiCompiledKnowledgeFile[] = [];
    for (const target of targets) {
      const filePath = path.join(compiledKnowledgeDir, target.fileName);
      await writeFile(filePath, target.content, "utf8");
      const fileStat = await stat(filePath);
      wroteFiles.push({
        kind: target.kind,
        path: path.relative(compiledKnowledgeDir, filePath).replace(/\\/g, "/"),
        entries: target.entries,
        bytes: fileStat.size,
      });
    }

    onCompiled();
    log.info({
      event: "knowledge-compiled",
      actor: options.actor ?? null,
      clientId: options.clientId ?? null,
      tabId: options.tabId ?? null,
      approvedExamplesPath: approvedExamplesFile,
      compiledDir: compiledKnowledgeDir,
      wroteFiles,
      skippedMalformed: parsed.malformed,
    });

    return {
      compiledAt,
      approvedExamplesPath: approvedExamplesFile,
      compiledDir: compiledKnowledgeDir,
      wroteFiles,
      skippedMalformed: parsed.malformed,
      status: await buildStatus(),
    };
  }

  return {
    async getStatus() {
      return buildStatus();
    },
    async compile(options = {}) {
      const next = compileChain.then(() => doCompile(options));
      compileChain = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}

export const devAiKnowledgeCompilerService = createDevAiKnowledgeCompilerService();
