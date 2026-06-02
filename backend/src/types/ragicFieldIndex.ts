export type RagicFieldScope = "main" | "subtable";

export interface RagicFieldIndexEntry {
  id: number;
  formPath: string;
  formName: string;
  scope: RagicFieldScope;
  subtableName: string | null;
  subtableKey: string | null;
  fieldPos: string | null;
  fieldName: string;
  fieldId: string;
  fieldType: string | null;
  fieldNote: string | null;
  refreshedAt: string;
}

export type RagicFieldIndexStatus = "idle" | "refreshing" | "ready" | "error";

export type RagicFieldRefreshPhase = "downloading" | "parsing" | "writing";

export interface RagicFieldRefreshProgress {
  phase: RagicFieldRefreshPhase;
  downloadedBytes: number;
  /** null 表示 server 沒回 Content-Length，UI 應顯示 indeterminate */
  totalBytes: number | null;
  startedAt: string;
}

export interface RagicFieldIndexState {
  status: RagicFieldIndexStatus;
  refreshedAt: string | null;
  totalForms: number;
  totalFields: number;
  message: string | null;
  updatedAt: string;
  /** 僅 refreshing 期間有值；其他時候為 null */
  progress: RagicFieldRefreshProgress | null;
}

/** Parser 中間產物：尚未進 SQLite 的純資料 */
export interface ParsedRagicForm {
  formPath: string;
  formName: string;
  mainKey: string | null;
  mainFields: ParsedRagicField[];
  subtables: ParsedRagicSubtable[];
}

export interface ParsedRagicSubtable {
  name: string;
  key: string | null;
  fields: ParsedRagicField[];
}

export interface ParsedRagicField {
  pos: string | null;
  name: string;
  id: string;
  type: string | null;
  note: string | null;
}
