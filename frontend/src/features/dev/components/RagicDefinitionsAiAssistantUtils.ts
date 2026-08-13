import type {
  RagicFormulaAiSuggestResult,
  RagicFormulaPatchDryRunInput,
} from "../../../api/devRagicDefinitions";
import type {
  DevAiKnowledgeSource,
  DevAiSpeedMode,
} from "@shared-types/ragicDefinitions";

export function isAiSuggestionForDraft(
  result: Pick<RagicFormulaAiSuggestResult, "formPath" | "fieldId" | "formulaKind"> | null,
  draft: Pick<RagicFormulaPatchDryRunInput, "formPath" | "fieldId" | "formulaKind">
): boolean {
  return Boolean(
    result &&
      result.formPath === draft.formPath.trim() &&
      result.fieldId === draft.fieldId.trim() &&
      result.formulaKind === draft.formulaKind
  );
}

export interface DevAiContextStatusInput {
  formPath?: string;
  fieldId?: string;
  includeKnowledge: boolean;
  includeDefinitions: boolean;
  speedMode: DevAiSpeedMode;
}

export function shouldDefaultIncludeDefinitions(formPath: string | undefined): boolean {
  return Boolean(formPath?.trim());
}

export function devAiContextStatusLabel(input: DevAiContextStatusInput): string {
  const speed = input.speedMode === "deep"
    ? "Deep"
    : input.speedMode === "balanced"
      ? "Balanced"
      : "Fast";
  const scope = input.formPath?.trim()
    ? input.fieldId?.trim()
      ? "已帶入目前欄位"
      : "已帶入目前表單"
    : "自動選擇脈絡";
  const sources = [
    input.includeKnowledge ? "本地知識" : "不查知識",
    input.includeDefinitions || input.formPath?.trim() ? "definitions" : "需要時查 definitions",
  ];
  return `${speed} · ${scope} · ${sources.join(" + ")}`;
}

export function devAiKnowledgeSourceLabel(source: DevAiKnowledgeSource): string {
  const kind = source.kind === "official"
    ? "Ragic 官方"
    : source.kind === "definitions"
      ? "Definitions"
      : "Knowledge";
  const evidence = [
    source.formPath,
    source.fieldId ? `Field ${source.fieldId}` : "",
    source.sourceType === "field"
      ? "欄位"
      : source.sourceType === "formula"
        ? "公式"
        : source.sourceType === "workflow"
          ? "Workflow"
          : "",
    source.revision ? `rev ${source.revision.replace(/^sha256:/, "").slice(0, 8)}` : "",
  ].filter(Boolean).join(" · ");
  return `${kind} · ${source.title}${evidence ? ` [${evidence}]` : ""}：${source.excerpt}`;
}

export function devAiKnowledgeSourcesFromUnknown(value: unknown): DevAiKnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DevAiKnowledgeSource => {
    if (typeof item !== "object" || item === null) return false;
    const source = item as Record<string, unknown>;
    return (
      typeof source.sourceId === "string" &&
      typeof source.title === "string" &&
      typeof source.excerpt === "string" &&
      typeof source.score === "number" &&
      (source.kind === "curated" ||
        source.kind === "official" ||
        source.kind === "definitions")
    );
  });
}

export interface DevAiLauncherPosition {
  x: number;
  y: number;
}

export const DEV_AI_LAUNCHER_POSITION_STORAGE_KEY =
  "ragic-report:dev-ai-launcher-position:v1";

interface DevAiLauncherPositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type DevAiLauncherPositionStorageProvider = () => DevAiLauncherPositionStorage;

const getBrowserStorage: DevAiLauncherPositionStorageProvider = () => window.localStorage;

interface DevAiLauncherViewport {
  width: number;
  height: number;
}

interface DevAiLauncherSize {
  width: number;
  height: number;
}

export function clampDevAiLauncherPosition(
  position: DevAiLauncherPosition,
  viewport: DevAiLauncherViewport,
  launcher: DevAiLauncherSize,
  margin: number
): DevAiLauncherPosition {
  const availableX = Math.max(0, viewport.width - launcher.width);
  const availableY = Math.max(0, viewport.height - launcher.height);
  const minX = Math.min(margin, availableX);
  const minY = Math.min(margin, availableY);
  const maxX = Math.max(minX, availableX - margin);
  const maxY = Math.max(minY, availableY - margin);

  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y)),
  };
}

export function getDevAiPanelPosition(
  launcherPosition: DevAiLauncherPosition,
  viewport: DevAiLauncherViewport,
  launcher: DevAiLauncherSize,
  panel: DevAiLauncherSize,
  margin: number,
  gap: number
): DevAiLauncherPosition {
  const launcherCenterX = launcherPosition.x + launcher.width / 2;
  const launcherCenterY = launcherPosition.y + launcher.height / 2;
  const preferredX = launcherCenterX > viewport.width / 2
    ? launcherPosition.x + launcher.width - panel.width
    : launcherPosition.x;
  const preferredY = launcherCenterY > viewport.height / 2
    ? launcherPosition.y - gap - panel.height
    : launcherPosition.y + launcher.height + gap;

  return clampDevAiLauncherPosition(
    { x: preferredX, y: preferredY },
    viewport,
    panel,
    margin
  );
}

export function parseDevAiLauncherPosition(value: string | null): DevAiLauncherPosition | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const position = parsed as Record<string, unknown>;
    if (
      typeof position.x !== "number" ||
      !Number.isFinite(position.x) ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.y)
    ) {
      return null;
    }
    return { x: position.x, y: position.y };
  } catch {
    return null;
  }
}

export function readDevAiLauncherPosition(
  getStorage: DevAiLauncherPositionStorageProvider = getBrowserStorage
): DevAiLauncherPosition | null {
  try {
    const storage = getStorage();
    return parseDevAiLauncherPosition(storage.getItem(DEV_AI_LAUNCHER_POSITION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeDevAiLauncherPosition(
  position: DevAiLauncherPosition,
  getStorage: DevAiLauncherPositionStorageProvider = getBrowserStorage
): void {
  try {
    const storage = getStorage();
    storage.setItem(DEV_AI_LAUNCHER_POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // localStorage 不可用時只保留本次畫面狀態。
  }
}
