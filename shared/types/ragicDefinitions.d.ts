/**
 * dev 公式跨版本連動（siblings）API 的 wire 型別。
 * BE（ragicFormulaSiblingsService）與 FE（api/devRagicDefinitions）共用此單一定義，
 * 避免兩邊手抄造成型別漂移。純型別、無 runtime。
 */

export interface RagicFormulaSiblingTranslationMappingItem {
  from: string;
  to: string;
  fieldId: string;
  fieldName: string;
}

export interface RagicFormulaSiblingTranslationUntranslatableItem {
  token: string;
  reason: string;
}

export interface RagicFormulaSiblingTranslation {
  translated: string | null;
  mapping: RagicFormulaSiblingTranslationMappingItem[];
  untranslatable: RagicFormulaSiblingTranslationUntranslatableItem[];
}

export interface RagicFormulaSiblingFreshness {
  checked: boolean;
  fresh: boolean;
  baselinePosition: string | null;
  actualPosition: string | null;
  baselineFormula: string | null;
  actualFormula: string | null;
  staleReasons: string[];
  warnings: string[];
}

export interface RagicFormulaSiblingInfo {
  formPath: string;
  formName: string;
  /** 同 fieldId 欄位存在於該版本表單（不存在 = 列出但不可連動） */
  hasField: boolean;
  /** 該表同 fieldId + formulaKind 的現行公式；無公式或 definitions 缺檔為 null */
  currentFormula: string | null;
  currentNuiFormula: string | null;
  /** 同 fieldId 欄位在該表的位置（hasField=false 時為 null） */
  fieldPosition: string | null;
  /** definitions 缺這張表的匯出檔時為 true（提示先重新匯入） */
  definitionsMissing: boolean;
  /** live .nui 與 definitions baseline 是否一致；不寫檔、不 re-export */
  freshness: RagicFormulaSiblingFreshness;
  /** request 帶 newFormula 且該表 hasField 時才有值 */
  translation: RagicFormulaSiblingTranslation | null;
}

export interface RagicFormulaSiblingsResult {
  siblings: RagicFormulaSiblingInfo[];
}

/**
 * dev definitions 讀取 API（state / forms / form / search）的 wire 型別。
 * 權威來源為 BE ragicDefinitionsReadService；FE api/devRagicDefinitions 共用同一份。
 */

export interface RagicDefinitionManifest {
  schemaVersion: number;
  namespaceFilter?: {
    mode: "all" | "include";
    namespaces?: string[];
  };
  counts: {
    forms: number;
    fields: number;
    formulas: number;
    workflows: number;
  };
}

export interface RagicDefinitionGitStatus {
  available: boolean;
  clean: boolean;
  entries: string[];
  error: string | null;
}

export interface RagicDefinitionsState {
  definitionsRoot: string;
  exists: boolean;
  manifest: RagicDefinitionManifest | null;
  gitStatus: RagicDefinitionGitStatus;
}

export interface RagicDefinitionForm {
  schemaVersion: number;
  formPath: string;
  formName: string;
  nuiFile: string;
  sourceEncoding: string;
  sourceRelativePath: string;
  counts: {
    fields: number;
    formulas: number;
    workflows: number;
  };
}

export interface RagicDefinitionField {
  fieldId: string;
  fieldName: string;
  kind: string;
  position: string;
  sourceLine: number;
  attrs: Record<string, string>;
}

export interface RagicDefinitionFormula {
  fieldId: string;
  fieldName: string;
  position: string;
  formulaKind: "formula" | "defaultFormula";
  nuiFormula: string;
  displayFormula: string;
  sourceLine: number;
}

export interface RagicDefinitionWorkflow {
  scope: string;
  fileName: string;
  content: string;
  charCount: number;
}

export interface RagicDefinitionFormDetail {
  form: RagicDefinitionForm;
  fields: RagicDefinitionField[];
  formulas: RagicDefinitionFormula[];
  workflows: RagicDefinitionWorkflow[];
}

export interface RagicDefinitionSearchItem {
  type: "field" | "formula";
  formPath: string;
  formName: string;
  sourceRelativePath: string;
  fieldId: string;
  fieldName: string;
  kind: string | null;
  position: string | null;
  sourceLine: number;
  formulaKind: RagicDefinitionFormula["formulaKind"] | null;
  nuiFormula: string | null;
  displayFormula: string | null;
}

/**
 * dev 公式 patch（dry-run / apply / batch）API 的 wire 回傳型別。
 * 權威來源為 BE ragicFormulaPatchDryRunService / ragicFormulaPatchApplyService。
 */

// 被業務 blocker 擋住（如 baseline 找不到公式）時 dry-run 仍回 200 + 部分欄位 null，
// 故大量欄位為 nullable；allowed=false 時看 blockers。
export interface RagicFormulaPatchDryRunResult {
  allowed: boolean;
  mode: "dry-run";
  formPath: string;
  formName: string | null;
  fieldId: string;
  fieldName: string | null;
  position: string | null;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  sourceRelativePath: string | null;
  builderFilePath: string | null;
  sourceLine: number | null;
  oldFormula: string | null;
  newFormula: string;
  oldLinePreview: string | null;
  newLinePreview: string | null;
  gitClean: boolean | null;
  warnings: string[];
  blockers: string[];
}

/**
 * dev AI 公式助手 wire 型別。AI 只產生公式草案並接 dry-run；不得直接 apply。
 */

export type RagicFormulaAiConfidence = "low" | "medium" | "high";

export interface RagicFormulaAiSuggestRequest {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  objective: string;
  userNotes?: string;
  includeSiblings?: boolean;
  includeSimilarFormulas?: boolean;
}

export interface RagicFormulaAiReferencedField {
  fieldId: string;
  position: string;
  name: string;
  reason: string;
}

export interface RagicFormulaAiContextPreview {
  fields: number;
  formulas: number;
  siblings: number;
  similarItems: number;
  chars: number;
}

export interface RagicFormulaAiSuggestResult {
  suggestionId: string;
  provider: "google";
  model: string;
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  proposedFormula: string;
  explanation: string;
  assumptions: string[];
  referencedFields: RagicFormulaAiReferencedField[];
  risks: string[];
  confidence: RagicFormulaAiConfidence;
  dryRun: RagicFormulaPatchDryRunResult;
  contextPreview: RagicFormulaAiContextPreview;
}

export type DevAiChatMode = "general" | "definitions";
export type DevAiSpeedMode = "fast" | "balanced" | "deep";

export interface DevAiChatRequest {
  question: string;
  mode?: DevAiChatMode;
  speedMode?: DevAiSpeedMode;
  formPath?: string;
  includeDefinitions?: boolean;
  includeKnowledge?: boolean;
  maxSources?: number;
}

export interface DevAiKnowledgeSource {
  sourceId: string;
  title: string;
  kind: "curated" | "official" | "definitions";
  excerpt: string;
  score: number;
  path?: string;
}

export interface DevAiChatContextPreview {
  knowledgeItems: number;
  definitionItems: number;
  chars: number;
}

export interface DevAiChatResult {
  chatId: string;
  provider: "google";
  model: string;
  mode: DevAiChatMode;
  speedMode: DevAiSpeedMode;
  answer: string;
  assumptions: string[];
  followUps: string[];
  sources: DevAiKnowledgeSource[];
  contextPreview: DevAiChatContextPreview;
  latencyMs: number;
}

export type DevAiFeedbackKind = "chat-answer" | "formula-suggestion";

export interface DevAiFeedbackRequest {
  kind: DevAiFeedbackKind;
  question?: string;
  answer?: string;
  objective?: string;
  proposedFormula?: string;
  explanation?: string;
  formPath?: string;
  fieldId?: string;
  formulaKind?: RagicDefinitionFormula["formulaKind"];
  notes?: string;
  sourceIds?: string[];
}

export interface DevAiFeedbackResult {
  feedbackId: string;
  stored: true;
  knowledgePath: string;
  title: string;
  compiled?: DevAiKnowledgeCompileResult;
}

export interface DevAiCompiledKnowledgeFile {
  kind: "chat-answer" | "formula-suggestion";
  path: string;
  entries: number;
  bytes: number;
}

export interface DevAiKnowledgeStatusResult {
  enabled: boolean;
  approvedExamplesPath: string;
  compiledDir: string;
  approvedExamples: {
    exists: boolean;
    total: number;
    chatAnswers: number;
    formulaSuggestions: number;
    malformed: number;
    bytes: number;
    updatedAt: string | null;
  };
  compiled: {
    exists: boolean;
    needsCompile: boolean;
    files: DevAiCompiledKnowledgeFile[];
    totalBytes: number;
    lastCompiledAt: string | null;
  };
}

export interface DevAiKnowledgeCompileResult {
  compiledAt: string;
  approvedExamplesPath: string;
  compiledDir: string;
  wroteFiles: DevAiCompiledKnowledgeFile[];
  skippedMalformed: number;
  status: DevAiKnowledgeStatusResult;
}

export type DevAiThreadMode = "auto" | "formula" | "definitions" | "general";
export type DevAiMessageRole = "user" | "assistant" | "system";
export type DevAiMessageIntent = "formula" | "definitions" | "general" | "clarify";

export interface DevAiThreadContext {
  formPath?: string;
  fieldId?: string;
  formulaKind?: RagicDefinitionFormula["formulaKind"];
}

export interface DevAiThread {
  id: string;
  ownerActor: string;
  title: string;
  mode: DevAiThreadMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  context: DevAiThreadContext;
  lastMessagePreview: string;
  summary: string | null;
  summaryUpdatedAt: string | null;
  summaryMessageId: string | null;
}

export interface DevAiThreadMessage {
  id: string;
  threadId: string;
  role: DevAiMessageRole;
  content: string;
  intent: DevAiMessageIntent | null;
  model: string | null;
  status: "completed" | "failed";
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface DevAiThreadArtifact {
  id: string;
  messageId: string;
  threadId: string;
  type:
    | "chat-result"
    | "formula-suggestion"
    | "dry-run"
    | "sources"
    | "knowledge-compile"
    | "knowledge-candidate";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DevAiThreadDetail {
  thread: DevAiThread;
  messages: DevAiThreadMessage[];
  artifacts: DevAiThreadArtifact[];
  summaryUsed?: boolean;
}

export interface DevAiCreateThreadRequest {
  title?: string;
  mode?: DevAiThreadMode;
  context?: DevAiThreadContext;
}

export interface DevAiSendMessageRequest {
  message: string;
  mode?: DevAiThreadMode;
  speedMode?: DevAiSpeedMode;
  context?: DevAiThreadContext;
  includeKnowledge?: boolean;
  includeDefinitions?: boolean;
}

export interface DevAiSendMessageResult {
  thread: DevAiThread;
  userMessage: DevAiThreadMessage;
  assistantMessage: DevAiThreadMessage;
  artifacts: DevAiThreadArtifact[];
  intent: DevAiMessageIntent;
  chat?: DevAiChatResult;
  formula?: RagicFormulaAiSuggestResult;
  summaryUsed?: boolean;
}

export interface RagicFormulaPatchApplyResult {
  applied: boolean;
  mode: "apply";
  dryRun: RagicFormulaPatchDryRunResult;
  backupFilePath: string | null;
  auditFilePath: string | null;
  exportOutput: string | null;
  verifiedFormula: RagicDefinitionFormula | null;
  rolledBack: boolean;
  warnings: string[];
  blockers: string[];
}

export interface RagicFormulaPatchBatchTargetResult {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  newFormula: string;
  dryRun: RagicFormulaPatchDryRunResult;
  applied: boolean;
  verifiedFormula: RagicDefinitionFormula | null;
  blockers: string[];
  warnings: string[];
}

export interface RagicFormulaPatchBatchApplyResult {
  /** 全部 targets 都套用成功才為 true（all-or-nothing） */
  applied: boolean;
  mode: "apply-batch";
  results: RagicFormulaPatchBatchTargetResult[];
  rolledBack: boolean;
  exportOutput: string | null;
  auditFilePath: string | null;
}

export interface RagicFormulaPatchRollbackTarget {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  builderFilePath: string;
  backupFilePath: string;
  safetyBackupFilePath: string | null;
  restored: boolean;
  blockers: string[];
  warnings: string[];
}

export interface RagicFormulaPatchRollbackLatestResult {
  rolledBack: boolean;
  mode: "rollback-latest";
  auditFilePath: string;
  exportOutput: string | null;
  restoredCount: number;
  targets: RagicFormulaPatchRollbackTarget[];
  state: RagicDefinitionsState;
  versionStatus: RagicDefinitionsVersionControlStatus;
  blockers: string[];
  warnings: string[];
}

/**
 * dev definitions 版控（status / commit / push）API 的 wire 型別。
 * 權威來源為 BE ragicDefinitionsVersionControlService。
 */

export interface RagicDefinitionsGitEntry {
  raw: string;
  status: string;
  path: string;
  inDefinitions: boolean;
  formPath: string | null;
}

export interface RagicDefinitionsVersionControlStatus {
  gitAvailable: boolean;
  repoRoot: string;
  definitionsRoot: string;
  definitionsPathspec: string;
  branch: string | null;
  lastCommit: string | null;
  remoteTrackingBranch: string | null;
  ahead: number | null;
  behind: number | null;
  clean: boolean;
  definitionsClean: boolean;
  canCommit: boolean;
  canPush: boolean;
  /** 本地與 origin/main 分叉，但工作樹乾淨，可由 push 流程先 rebase 再推送。 */
  canAutoSyncPush: boolean;
  entries: RagicDefinitionsGitEntry[];
  definitionsEntries: RagicDefinitionsGitEntry[];
  outsideEntries: RagicDefinitionsGitEntry[];
  blockers: string[];
  warnings: string[];
  error: string | null;
}

export interface RagicDefinitionsVersionControlCommitResult {
  committed: boolean;
  commit: string | null;
  message: string;
  scopedFormPaths?: string[];
  committedDefinitionsEntries?: RagicDefinitionsGitEntry[];
  retainedDefinitionsEntries?: RagicDefinitionsGitEntry[];
  stdout: string;
  stderr: string;
  status: RagicDefinitionsVersionControlStatus;
  blockers: string[];
  warnings: string[];
}

export interface RagicDefinitionsVersionControlPushResult {
  pushed: boolean;
  stdout: string;
  stderr: string;
  status: RagicDefinitionsVersionControlStatus;
  blockers: string[];
  warnings: string[];
}
