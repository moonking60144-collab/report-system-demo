import { readFile, stat } from "node:fs/promises";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import {
  ragicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../../storage/sqlite/ragicFieldIndexRepository";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionsReadService,
} from "./ragicDefinitionsReadService";
import {
  translateFormulaPositions,
  type TranslateFormulaResult,
} from "./ragicFormulaPositionTranslator";
import {
  decodeNuiContent,
  isNuiFormulaInSync,
  formulaAttrKey,
  maskSecrets,
  normalizeFormulaForNuiStorage,
  resolveInside,
} from "./ragicFormulaPatchDryRunService";
import { parseNuiFieldLine } from "./ragicNuiParser";
import type {
  RagicFormulaSiblingFreshness,
  RagicFormulaSiblingInfo,
  RagicFormulaSiblingsResult,
} from "@shared-types/ragicDefinitions";

export type {
  RagicFormulaSiblingFreshness,
  RagicFormulaSiblingInfo,
  RagicFormulaSiblingsResult,
};

const LIVE_NUI_CONTENT_CACHE_MAX_ENTRIES = 128;
const log = createLogger("ragic-formula-siblings");

interface SiblingsQueryTimings {
  siblingFormsMs: number;
  sourceFieldsMs: number;
  targetFieldsMs: number;
  definitionsMs: number;
  freshnessMs: number;
  translationMs: number;
}

interface LiveNuiContentCacheEntry {
  sourceEncoding: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  content: string;
  decodeWarnings: string[];
}

const liveNuiContentCache = new Map<string, LiveNuiContentCacheEntry>();

export function invalidateRagicFormulaSiblingsLiveNuiCache(filePath?: string): void {
  if (filePath) {
    liveNuiContentCache.delete(filePath);
    return;
  }
  liveNuiContentCache.clear();
}

/**
 * 公式跨版本連動的「足跡查詢」：給定一個公式欄位（formPath + fieldId +
 * formulaKind），找出同 mainKey 的多版本兄弟表單、各表上同 fieldId 欄位的
 * 公式現況；帶 newFormula 時順便附上位置翻譯結果（自動推估的建議公式）。
 *
 * 只查不寫：dry-run / apply 仍由前端對勾選的每張表逐張走現有 flow。
 */

export interface RagicFormulaSiblingsRequest {
  formPath: string;
  fieldId: string;
  formulaKind: "formula" | "defaultFormula";
  /** 有值時對每張可譯的兄弟表附 translation（自動推估建議） */
  newFormula?: string;
  /** 預設 true；只判斷家族存在時可關閉，避免額外 live .nui I/O */
  includeFreshness?: boolean;
  /** 預設 false；版本資訊 modal 需要把目前表單也放進同一套 freshness 判定 */
  includeCurrent?: boolean;
  /** client 取消 request 時停止後續 definitions / live .nui 工作 */
  signal?: AbortSignal;
}

export interface RagicFormulaSiblingsServiceDeps {
  fieldIndexRepository?: Pick<
    RagicFieldIndexRepository,
    "listVersionSiblingForms" | "listFormFieldPositions"
  >;
  definitionsService?: Pick<RagicDefinitionsReadService, "readForm">;
  builderRoot?: string;
}

export interface RagicFormulaSiblingsService {
  listSiblings(
    request: RagicFormulaSiblingsRequest
  ): Promise<RagicFormulaSiblingsResult>;
}

export function createRagicFormulaSiblingsService(
  deps: RagicFormulaSiblingsServiceDeps = {}
): RagicFormulaSiblingsService {
  const repository = deps.fieldIndexRepository ?? ragicFieldIndexRepository;
  const definitionsService = deps.definitionsService ?? ragicDefinitionsReadService;
  const builderRoot = deps.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "";

  return {
    async listSiblings(request) {
      throwIfAborted(request.signal);
      const startedAt = Date.now();
      const timings: SiblingsQueryTimings = {
        siblingFormsMs: 0,
        sourceFieldsMs: 0,
        targetFieldsMs: 0,
        definitionsMs: 0,
        freshnessMs: 0,
        translationMs: 0,
      };
      const siblingFormsStartedAt = Date.now();
      const siblingForms = await repository.listVersionSiblingForms(request.formPath);
      throwIfAborted(request.signal);
      timings.siblingFormsMs += Date.now() - siblingFormsStartedAt;
      const forms = [
        ...(request.includeCurrent
          ? [{ formPath: request.formPath, formName: request.formPath }]
          : []),
        ...siblingForms.filter((form) => form.formPath !== request.formPath),
      ];
      if (forms.length === 0) {
        logSlowSiblingsQuery({
          startedAt,
          request,
          formsCount: 0,
          siblingsCount: 0,
          timings,
        });
        return { siblings: [] };
      }

      const newFormula = normalizeFormulaForNuiStorage(request.newFormula ?? "").trim();
      const sourceFieldsStartedAt = Date.now();
      const sourceFields = newFormula
        ? await repository.listFormFieldPositions(request.formPath)
        : [];
      throwIfAborted(request.signal);
      timings.sourceFieldsMs += Date.now() - sourceFieldsStartedAt;
      const sourceMainFields = sourceFields.filter((field) => field.scope === "main");
      const sourceByPosition = new Map(
        sourceMainFields.map((field) => [
          field.position,
          { fieldId: field.fieldId, fieldName: field.fieldName },
        ])
      );

      const includeFreshness = request.includeFreshness !== false;
      const siblings = await Promise.all(forms.map(async (form) => {
        throwIfAborted(request.signal);
        const targetFieldsStartedAt = Date.now();
        const targetFields = await repository.listFormFieldPositions(form.formPath);
        const targetMainFields = targetFields.filter((field) => field.scope === "main");
        throwIfAborted(request.signal);
        timings.targetFieldsMs += Date.now() - targetFieldsStartedAt;
        const targetField = targetMainFields.find(
          (field) => field.fieldId === request.fieldId
        );
        const hasField = Boolean(targetField);

        let currentFormula: string | null = null;
        let currentNuiFormula: string | null = null;
        let freshness = uncheckedFreshness(null, null);
        let definitionsMissing = false;
        let formName = form.formName;
        const definitionsStartedAt = Date.now();
        let definitionsTimingRecorded = false;
        try {
          const detail = await definitionsService.readForm(form.formPath);
          throwIfAborted(request.signal);
          timings.definitionsMs += Date.now() - definitionsStartedAt;
          definitionsTimingRecorded = true;
          formName = detail.form.formName;
          const formulaRecord = detail.formulas.find(
            (formula) =>
              formula.fieldId === request.fieldId &&
              formula.formulaKind === request.formulaKind
          );
          const baselineField = detail.fields.find(
            (field) => field.fieldId === request.fieldId
          );
          const baselinePosition =
            formulaRecord?.position ?? baselineField?.position ?? null;
          currentFormula = formulaRecord?.displayFormula ?? null;
          currentNuiFormula = formulaRecord?.nuiFormula ?? null;
          const freshnessStartedAt = Date.now();
          freshness = includeFreshness
            ? await inspectLiveNuiFreshness({
                builderRoot,
                detail,
                fieldId: request.fieldId,
                formulaKind: request.formulaKind,
                baselinePosition,
                baselineFormula: formulaRecord?.nuiFormula ?? null,
                baselineSourceLine: formulaRecord?.sourceLine ?? baselineField?.sourceLine ?? null,
                signal: request.signal,
              })
            : uncheckedFreshness(baselinePosition, formulaRecord?.nuiFormula ?? null);
          throwIfAborted(request.signal);
          timings.freshnessMs += Date.now() - freshnessStartedAt;
        } catch (error) {
          if (!definitionsTimingRecorded) {
            timings.definitionsMs += Date.now() - definitionsStartedAt;
          }
          // definitions 缺這張表（尚未匯出 / 路徑被 filter 排除）→ 標記提示，
          // 不讓單張缺檔炸掉整個足跡查詢
          if (error instanceof Error && /ENOENT|BAD_FORM_PATH/.test(error.message)) {
            definitionsMissing = true;
          } else {
            throw error;
          }
        }

        let translation: TranslateFormulaResult | null = null;
        if (newFormula && hasField) {
          throwIfAborted(request.signal);
          const translationStartedAt = Date.now();
          translation = translateFormulaPositions({
            formula: newFormula,
            sourceByPosition,
            targetPositionByFieldId: createTargetPositionMap(targetMainFields),
          });
          throwIfAborted(request.signal);
          timings.translationMs += Date.now() - translationStartedAt;
        }

        return {
          formPath: form.formPath,
          formName,
          hasField,
          currentFormula,
          currentNuiFormula,
          fieldPosition: freshness.baselinePosition ?? targetField?.position ?? null,
          definitionsMissing,
          freshness,
          translation,
        };
      }));

      logSlowSiblingsQuery({
        startedAt,
        request,
        formsCount: forms.length,
        siblingsCount: siblings.length,
        timings,
      });
      return { siblings };
    },
  };
}

export const ragicFormulaSiblingsService = createRagicFormulaSiblingsService();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("formula siblings query aborted", "AbortError");
  }
}

function logSlowSiblingsQuery(params: {
  startedAt: number;
  request: RagicFormulaSiblingsRequest;
  formsCount: number;
  siblingsCount: number;
  timings: SiblingsQueryTimings;
}): void {
  const totalMs = Date.now() - params.startedAt;
  if (totalMs < env.RAGIC_FORMULA_SIBLINGS_SLOW_LOG_THRESHOLD_MS) {
    return;
  }

  log.warn({
    event: "list-siblings.slow",
    totalMs,
    formPath: params.request.formPath,
    fieldId: params.request.fieldId,
    formulaKind: params.request.formulaKind,
    includeFreshness: params.request.includeFreshness !== false,
    includeCurrent: params.request.includeCurrent === true,
    hasNewFormula: Boolean(params.request.newFormula?.trim()),
    formsCount: params.formsCount,
    siblingsCount: params.siblingsCount,
    timings: params.timings,
  });
}

function uncheckedFreshness(
  baselinePosition: string | null,
  baselineFormula: string | null
): RagicFormulaSiblingFreshness {
  return {
    checked: false,
    fresh: true,
    baselinePosition,
    actualPosition: null,
    baselineFormula,
    actualFormula: null,
    staleReasons: [],
    warnings: [],
  };
}

async function inspectLiveNuiFreshness(params: {
  builderRoot: string;
  detail: Awaited<ReturnType<RagicDefinitionsReadService["readForm"]>>;
  fieldId: string;
  formulaKind: RagicFormulaSiblingsRequest["formulaKind"];
  baselinePosition: string | null;
  baselineFormula: string | null;
  baselineSourceLine: number | null;
  signal?: AbortSignal;
}): Promise<RagicFormulaSiblingFreshness> {
  const result = uncheckedFreshness(params.baselinePosition, params.baselineFormula);
  const warnings = result.warnings;
  throwIfAborted(params.signal);

  if (!params.builderRoot.trim()) {
    warnings.push("未設定 RAGIC_BUILDER_PATH，無法檢查 live .nui 是否與 definitions 同步");
    return result;
  }

  const builderFilePath = resolveInside(
    params.builderRoot,
    params.detail.form.sourceRelativePath
  );
  if (!builderFilePath) {
    warnings.push("sourceRelativePath 超出 RAGIC_BUILDER_PATH 範圍，無法檢查 live .nui");
    return result;
  }

  throwIfAborted(params.signal);
  const content = await readLiveNuiContent(
    builderFilePath,
    params.detail.form.sourceEncoding,
    warnings,
    params.signal
  );
  throwIfAborted(params.signal);
  if (content === null) {
    return result;
  }

  result.checked = true;
  if (params.baselineSourceLine === null) {
    result.fresh = false;
    result.staleReasons.push(
      `baseline fields.json 找不到欄位 ${params.fieldId}，無法定位 live .nui`
    );
    return result;
  }

  const lines = content.split(/\r?\n/);
  const oldLine = lines[params.baselineSourceLine - 1];
  if (oldLine === undefined) {
    result.fresh = false;
    result.staleReasons.push(
      `live .nui 沒有第 ${params.baselineSourceLine} 行；definitions 可能已過期`
    );
    return result;
  }

  const liveField = parseNuiFieldLine(oldLine, params.baselineSourceLine);
  if (!liveField) {
    result.fresh = false;
    result.staleReasons.push("sourceLine 不是可解析的 .nui 欄位行");
    return result;
  }
  if (liveField.fieldId !== params.fieldId) {
    result.fresh = false;
    result.actualPosition = liveField.position;
    result.staleReasons.push(
      `sourceLine fieldId 不一致：baseline=${params.fieldId}，actual=${liveField.fieldId}`
    );
    return result;
  }

  result.actualPosition = liveField.position;
  if (params.baselinePosition !== null && liveField.position !== params.baselinePosition) {
    result.fresh = false;
    result.staleReasons.push(
      `欄位位置不同步：baseline=${params.baselinePosition}，live=${liveField.position}`
    );
  }

  const attrKey = formulaAttrKey(params.formulaKind);
  const liveAttr = liveField.attrs.find((attr) => attr.key === attrKey);
  const liveFormula = liveAttr?.decodedValue ?? null;
  const liveFormulaRaw = liveAttr?.rawValue ?? null;
  const maskedLiveFormula = liveFormula === null ? null : maskSecrets(liveFormula);
  result.actualFormula = maskedLiveFormula;
  const redactionAffected =
    (params.baselineFormula ?? "").includes("***REDACTED***") ||
    (liveFormula !== null && maskedLiveFormula !== liveFormula);
  if (redactionAffected) {
    result.fresh = false;
    result.staleReasons.push(
      "公式含已遮蔽敏感片段，無法可靠判定 live .nui 與 definitions 是否一致"
    );
    return result;
  }
  if (params.baselineFormula !== null && maskedLiveFormula !== null) {
    if (
      !isNuiFormulaInSync({
        baselineFormula: params.baselineFormula,
        liveFormula: maskedLiveFormula,
        sourceEncoding: params.detail.form.sourceEncoding,
        liveRawFormula: liveFormulaRaw,
      })
    ) {
      result.fresh = false;
      result.staleReasons.push(
        `公式不同步：baseline=${params.baselineFormula ?? "（無）"}，live=${maskedLiveFormula ?? "（無）"}`
      );
    }
  } else if (params.baselineFormula !== maskedLiveFormula) {
    result.fresh = false;
    result.staleReasons.push(
      `公式不同步：baseline=${params.baselineFormula ?? "（無）"}，live=${maskedLiveFormula ?? "（無）"}`
    );
  }

  return result;
}

async function readLiveNuiContent(
  filePath: string,
  sourceEncoding: string,
  warnings: string[],
  signal?: AbortSignal
): Promise<string | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    throwIfAborted(signal);
    fileStat = await stat(filePath);
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      warnings.push(`找不到 live .nui：${filePath}`);
    } else {
      warnings.push(
        `無法讀取 live .nui metadata：${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }
  if (!fileStat.isFile()) {
    warnings.push(`live .nui 不是檔案：${filePath}`);
    return null;
  }

  const cached = liveNuiContentCache.get(filePath);
  if (
    cached &&
    cached.sourceEncoding === sourceEncoding &&
    cached.size === fileStat.size &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.ctimeMs === fileStat.ctimeMs
  ) {
    liveNuiContentCache.delete(filePath);
    liveNuiContentCache.set(filePath, cached);
    warnings.push(...cached.decodeWarnings);
    return cached.content;
  }

  let bytes: Buffer;
  try {
    throwIfAborted(signal);
    bytes = await readFile(filePath, { signal });
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    warnings.push(
      `無法讀取 live .nui：${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const decodeWarnings: string[] = [];
  const content = decodeNuiContent(bytes, sourceEncoding, decodeWarnings);
  warnings.push(...decodeWarnings);
  liveNuiContentCache.set(filePath, {
    sourceEncoding,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    content,
    decodeWarnings,
  });
  while (liveNuiContentCache.size > LIVE_NUI_CONTENT_CACHE_MAX_ENTRIES) {
    const oldestKey = liveNuiContentCache.keys().next().value;
    if (!oldestKey) break;
    liveNuiContentCache.delete(oldestKey);
  }
  return content;
}

function createTargetPositionMap(
  fields: Awaited<ReturnType<RagicFieldIndexRepository["listFormFieldPositions"]>>
): Map<string, { position: string; fieldName: string; ambiguous?: boolean; positions?: string[] }> {
  const byFieldId = new Map<string, Array<{ position: string; fieldName: string }>>();
  for (const field of fields) {
    const current = byFieldId.get(field.fieldId);
    const item = { position: field.position, fieldName: field.fieldName };
    if (current) {
      current.push(item);
    } else {
      byFieldId.set(field.fieldId, [item]);
    }
  }

  const result = new Map<
    string,
    { position: string; fieldName: string; ambiguous?: boolean; positions?: string[] }
  >();
  for (const [fieldId, matches] of byFieldId) {
    if (matches.length === 1) {
      result.set(fieldId, matches[0]);
      continue;
    }
    result.set(fieldId, {
      position: matches[0].position,
      fieldName: matches[0].fieldName,
      ambiguous: true,
      positions: matches.map((match) => match.position),
    });
  }
  return result;
}
