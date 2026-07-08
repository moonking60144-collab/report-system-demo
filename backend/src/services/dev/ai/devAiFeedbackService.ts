import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { HttpError } from "../../../utils/httpError";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { createDevAiKnowledgeCompilerService } from "./devAiKnowledgeCompilerService";
import type {
  DevAiFeedbackRequest,
  DevAiFeedbackResult,
} from "@shared-types/ragicDefinitions";

const log = createLogger("dev-ai-feedback");

export interface DevAiFeedbackOptions {
  actor?: string | null;
  clientId?: string | null;
  tabId?: string | null;
}

export interface DevAiFeedbackServiceDeps {
  enabled?: boolean;
  filePath?: string;
  compiledKnowledgeDir?: string;
  feedbackIdFactory?: () => string;
  now?: () => Date;
  onStored?: (options: DevAiFeedbackOptions) => void | Promise<DevAiFeedbackResult["compiled"]>;
}

export interface DevAiFeedbackService {
  store(
    request: DevAiFeedbackRequest,
    options?: DevAiFeedbackOptions
  ): Promise<DevAiFeedbackResult>;
}

function compactText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function compactSourceIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
}

function normalizeRequest(request: DevAiFeedbackRequest): DevAiFeedbackRequest {
  if (request.kind !== "chat-answer" && request.kind !== "formula-suggestion") {
    throw new HttpError(400, "feedback kind 不合法", "DEV_AI_FEEDBACK_BAD_KIND");
  }
  const normalized: DevAiFeedbackRequest = {
    kind: request.kind,
    ...(compactText(request.question, 1_500) ? { question: compactText(request.question, 1_500) } : {}),
    ...(compactText(request.answer, 8_000) ? { answer: compactText(request.answer, 8_000) } : {}),
    ...(compactText(request.objective, 1_500) ? { objective: compactText(request.objective, 1_500) } : {}),
    ...(compactText(request.proposedFormula, 4_000)
      ? { proposedFormula: compactText(request.proposedFormula, 4_000) }
      : {}),
    ...(compactText(request.explanation, 4_000) ? { explanation: compactText(request.explanation, 4_000) } : {}),
    ...(compactText(request.formPath, 500) ? { formPath: compactText(request.formPath, 500) } : {}),
    ...(compactText(request.fieldId, 120) ? { fieldId: compactText(request.fieldId, 120) } : {}),
    ...(request.formulaKind === "formula" || request.formulaKind === "defaultFormula"
      ? { formulaKind: request.formulaKind }
      : {}),
    ...(compactText(request.notes, 2_000) ? { notes: compactText(request.notes, 2_000) } : {}),
    sourceIds: compactSourceIds(request.sourceIds),
  };
  if (normalized.kind === "chat-answer" && (!normalized.question || !normalized.answer)) {
    throw new HttpError(
      400,
      "收錄問答範例需要 question 與 answer",
      "DEV_AI_FEEDBACK_MISSING_CHAT_CONTENT"
    );
  }
  if (normalized.kind === "formula-suggestion" && (!normalized.objective || !normalized.proposedFormula)) {
    throw new HttpError(
      400,
      "收錄公式範例需要 objective 與 proposedFormula",
      "DEV_AI_FEEDBACK_MISSING_FORMULA_CONTENT"
    );
  }
  return normalized;
}

function buildKnowledgeEntry(params: {
  feedbackId: string;
  createdAt: string;
  actor?: string | null;
  clientId?: string | null;
  tabId?: string | null;
  request: DevAiFeedbackRequest;
}): { title: string; content: string; metadata: Record<string, unknown> } {
  const request = params.request;
  const title =
    request.kind === "chat-answer"
      ? `Approved chat answer: ${compactText(request.question, 80)}`
      : `Approved formula example: ${request.formPath ?? "unknown"} ${request.fieldId ?? ""}`.trim();
  const content =
    request.kind === "chat-answer"
      ? [
          "類型：Funda Dev AI approved chat answer",
          `問題：${request.question}`,
          `回答：${request.answer}`,
          request.notes ? `備註：${request.notes}` : "",
          request.sourceIds?.length ? `原始來源：${request.sourceIds.join(", ")}` : "",
        ].filter(Boolean).join("\n")
      : [
          "類型：Funda Dev AI approved formula example",
          request.formPath ? `表單：${request.formPath}` : "",
          request.fieldId ? `欄位：${request.fieldId}` : "",
          request.formulaKind ? `公式類型：${request.formulaKind}` : "",
          `需求：${request.objective}`,
          `建議公式：${request.proposedFormula}`,
          request.explanation ? `說明：${request.explanation}` : "",
          request.notes ? `備註：${request.notes}` : "",
        ].filter(Boolean).join("\n");
  return {
    title: maskSecrets(title),
    content: maskSecrets(content),
    metadata: {
      feedbackId: params.feedbackId,
      kind: request.kind,
      createdAt: params.createdAt,
      actor: params.actor ?? null,
      clientId: params.clientId ?? null,
      tabId: params.tabId ?? null,
      formPath: request.formPath ?? null,
      fieldId: request.fieldId ?? null,
      formulaKind: request.formulaKind ?? null,
    },
  };
}

export function createDevAiFeedbackService(
  deps: DevAiFeedbackServiceDeps = {}
): DevAiFeedbackService {
  const enabled = deps.enabled ?? env.DEV_AI_ENABLED;
  const filePath = path.resolve(deps.filePath ?? env.DEV_AI_APPROVED_EXAMPLES_FILE);
  const feedbackIdFactory = deps.feedbackIdFactory ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const compiler =
    deps.onStored === undefined
      ? createDevAiKnowledgeCompilerService({
          enabled,
          approvedExamplesFile: filePath,
          compiledKnowledgeDir:
            deps.compiledKnowledgeDir ??
            (deps.filePath ? path.join(path.dirname(filePath), "compiled") : undefined),
        })
      : null;
  const onStored =
    deps.onStored ??
    ((options: DevAiFeedbackOptions) => compiler?.compile(options));
  let writeChain = Promise.resolve();

  return {
    async store(request, options = {}) {
      if (!enabled) throw new HttpError(403, "Dev AI 未啟用", "DEV_AI_DISABLED");
      const normalized = normalizeRequest(request);
      const feedbackId = feedbackIdFactory();
      const createdAt = now().toISOString();
      const entry = buildKnowledgeEntry({
        feedbackId,
        createdAt,
        actor: options.actor,
        clientId: options.clientId,
        tabId: options.tabId,
        request: normalized,
      });
      await mkdir(path.dirname(filePath), { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const write = writeChain.then(() => appendFile(filePath, line, "utf8"));
      writeChain = write.catch(() => undefined);
      await write;
      const compiled = await onStored(options);
      log.info({
        event: "feedback-stored",
        feedbackId,
        kind: normalized.kind,
        actor: options.actor ?? null,
        clientId: options.clientId ?? null,
        tabId: options.tabId ?? null,
        knowledgePath: filePath,
      });
      return {
        feedbackId,
        stored: true,
        knowledgePath: filePath,
        title: entry.title,
        ...(compiled ? { compiled } : {}),
      };
    },
  };
}

export const devAiFeedbackService = createDevAiFeedbackService();
