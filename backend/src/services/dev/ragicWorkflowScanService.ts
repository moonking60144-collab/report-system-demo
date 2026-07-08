/**
 * 直讀 Ragic Builder 本地 .nui 檔，抽 workflow 依賴寫進 ragic_workflow_edge——全自動、零認證。
 *
 * 前提：backend 與 Ragic 同一台，RAGIC_BUILDER_PATH 指向 cust/def/app 根。
 * 每張表的 .nui（整張 sheet 定義，含 workflow JS）直接 readFile 當文字跑 parseFile regex；
 * getAPIQuery / setFieldValue 只出現在 workflow JS，掃整檔不會誤中欄位/按鈕設定
 * （已實測 .nui 直讀結果與 txtedit 撈的完全一致）。比 HTTP 撈快幾百倍、不需 cookie/session。
 *
 * in-memory 狀態（button 觸發、單一執行）：前端 poll getWorkflowScanState() 看進度。
 */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { env } from "../../config/env";
import { sqliteClient, withWriteTransaction } from "../../storage/sqlite/sqliteClient";
import { ensureRagicFieldIndexSchema } from "../../storage/sqlite/ragicFieldIndexSchema";
import {
  parseFile,
  rebuildWorkflowEdges,
  rebuildWorkflowSources,
  type ParsedFile,
} from "./ragicWorkflowAnalyze";

export interface WorkflowScanProgress {
  scannedForms: number;
  totalForms: number;
  foundFiles: number;
}

export interface WorkflowScanState {
  status: "idle" | "running" | "done" | "error";
  progress: WorkflowScanProgress | null;
  message: string | null;
  lastResult: {
    edges: number;
    formsWithWorkflow: number;
    missingFiles: number;
    refreshedAt: string;
  } | null;
}

let state: WorkflowScanState = {
  status: "idle",
  progress: null,
  message: null,
  lastResult: null,
};
let running = false;

export function getWorkflowScanState(): WorkflowScanState {
  return state;
}

export function isWorkflowScanConfigured(): boolean {
  const root = env.RAGIC_BUILDER_PATH.trim();
  // 本機沒這目錄 → 視為停用（此功能只在 backend 與 Ragic 同台的 server 可用）
  return root.length > 0 && existsSync(root);
}

// 正常 .nui ~300KB；超過 5MB 視為異常，跳過避免 readFile OOM
const MAX_NUI_BYTES = 5 * 1024 * 1024;

/**
 * form_path → .nui 檔絕對路徑：default/forms8/71 → <root>/default/forms8/71_Sheet71_index.nui
 * 縱深防禦：form_path 來自 DB（非前端可控），但仍嚴格驗證——拒絕 .. / . / 含路徑分隔或特殊字元的段，
 * 並確認 resolve 後仍落在 root 內（擋 path traversal）。不合法回 null，呼叫端 skip。
 */
function nuiPathFor(formPath: string): string | null {
  const parts = formPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.some((p) => p === ".." || p === "." || /[\\/:*?"<>|]/.test(p))) return null;
  const id = parts[parts.length - 1]!;
  const root = resolve(env.RAGIC_BUILDER_PATH);
  const full = resolve(join(root, ...parts.slice(0, -1), `${id}_Sheet${id}_index.nui`));
  if (full !== root && !full.startsWith(root + sep)) return null; // 解析後跳出 root → 拒絕
  return full;
}

// 遮罩明文 secret：含 key 的 GCONST 已被 SCRIPT_START 切點排除，但 workflow JS body 本身也可能
// hardcode（實測 devtest/32 有 Google key），所以存 / 顯示前一律掃過遮罩。
function maskSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***REDACTED***")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza***REDACTED***")
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, "***REDACTED-KEY***"); // 長 base64（Ragic 等 key 樣式）
}

const WORKFLOW_SOURCE_MARKERS = new Set([
  "PRE_WORKFLOW_START",
  "SCRIPT_START",
  "APPROVAL_START",
  "SHEET_SCOPE_START",
]);

// .nui 是 CSV-like「TYPE,data」每行；workflow JS 可能存在 pre / post / approval / sheet-scope
// 四種 marker。source viewer 的 all scope 需保留四段，避免 audit 時只看得到 post workflow。
export function extractWorkflowJs(nuiContent: string): string {
  const out: string[] = [];
  let currentMarker: string | null = null;
  const flushMarker = (marker: string): void => {
    if (out.length) out.push("");
    out.push(`// ${marker}`);
  };
  for (const line of nuiContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (WORKFLOW_SOURCE_MARKERS.has(trimmed)) {
      currentMarker = trimmed;
      flushMarker(trimmed);
      continue;
    }
    if (!currentMarker) continue;
    if (/^(PRE_WORKFLOW_END|SCRIPT_END|APPROVAL_END|SHEET_SCOPE_END)\b/.test(trimmed)) {
      currentMarker = null;
      continue;
    }
    if (/^[A-Z][A-Z0-9_]*,/.test(trimmed)) {
      currentMarker = null;
      continue;
    }
    out.push(line);
  }
  return maskSecrets(out.join("\n").trim());
}

export async function scanWorkflows(options?: { signal?: AbortSignal }): Promise<void> {
  if (running) throw new Error("workflow 掃描已在進行中");
  if (!isWorkflowScanConfigured()) {
    throw new Error("未設定 RAGIC_BUILDER_PATH（只有 backend 與 Ragic 同台時可直讀 .nui）");
  }
  running = true;
  state = {
    status: "running",
    progress: { scannedForms: 0, totalForms: 0, foundFiles: 0 },
    message: null,
    lastResult: null,
  };
  try {
    const db = await sqliteClient.getDb();
    await ensureRagicFieldIndexSchema(db);
    const forms = await db.all<Array<{ form_path: string }>>(
      "SELECT DISTINCT form_path FROM ragic_field_index_active ORDER BY form_path"
    );
    const knownPaths = new Set(forms.map((f) => f.form_path));
    const total = forms.length;

    const parsed: ParsedFile[] = [];
    const sources: Array<{ formPath: string; scope: string; js: string }> = [];
    let found = 0;
    for (let i = 0; i < forms.length; i += 1) {
      if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const formPath = forms[i]!.form_path;
      const nui = nuiPathFor(formPath);
      // nui=null（form_path 不合法 / 跳出 root）或檔不存在 → skip；超大檔也 skip 防 OOM
      if (nui && existsSync(nui) && statSync(nui).size <= MAX_NUI_BYTES) {
        // utf-8 讀；getAPIQuery / setFieldValue 是 ASCII，即使 .nui 中文是別的編碼也不影響抽取
        const content = await readFile(nui, "utf-8");
        parsed.push(parseFile(content, formPath, "all"));
        const js = extractWorkflowJs(content); // 切 SCRIPT 段 + 遮罩 secret，供「看原始碼」
        if (js) sources.push({ formPath, scope: "all", js });
        found += 1;
      }
      state.progress = { scannedForms: i + 1, totalForms: total, foundFiles: found };
    }

    const refreshedAt = new Date().toISOString();
    const edges = await withWriteTransaction(async (writeDb) => {
      const rebuiltEdges = await rebuildWorkflowEdges(writeDb, parsed, knownPaths, refreshedAt);
      await rebuildWorkflowSources(writeDb, sources, refreshedAt); // 填原文（已切 SCRIPT 段 + 遮罩）
      return rebuiltEdges;
    });
    state = {
      status: "done",
      progress: { scannedForms: total, totalForms: total, foundFiles: found },
      message: null,
      lastResult: { edges, formsWithWorkflow: parsed.length, missingFiles: total - found, refreshedAt },
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    state = {
      status: isAbort ? "idle" : "error",
      progress: null,
      message: error instanceof Error ? error.message : String(error),
      lastResult: null,
    };
    if (!isAbort) throw error;
  } finally {
    running = false;
  }
}
