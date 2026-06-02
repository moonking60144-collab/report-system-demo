import type { WorkReportItem } from "../../../api/workReport";
import type { FormState } from "../../../components/report-form/types";

export interface PredictedCumulativeEntry {
  cum: number;
  isPredicted: boolean;
}

export type PredictedCumulativeMap = Map<string, PredictedCumulativeEntry>;

function parseQty(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const num = Number(String(value).trim());
  return Number.isFinite(num) ? num : 0;
}

export interface ComputePredictedCumulativeInput {
  /** 原始資料列（從 Ragic 來的），包含真實 cumulativeQty */
  detailRows: WorkReportItem[];
  /** 正在編輯的既有列 rowId + 該列的 draft（僅關心 productionQty 欄位） */
  editingRowId: string | null;
  editingRowDraft: FormState | null;
  /** 批次新增的 draft：key 是 placeholder rowId，value 是該列 draft */
  batchCreateDraftsByRowId: Record<string, FormState>;
  /** 目前是否處於批次新增模式；非批次模式時忽略 batchCreateDraftsByRowId */
  batchCreateMode: boolean;
  /** 目前畫面上所有的列（含 placeholder），保持顯示順序 */
  displayRows: Array<Pick<WorkReportItem, "rowId"> & { __placeholder?: boolean }>;
}

/**
 * 計算每一列的預估依序累計量。
 *
 * 規則（B）：某列的累計量 = 所有「更早 rowId」的產量加總 + 本列產量。
 * 排序基準：rowId 數字升冪。新增中的 placeholder 視為最後（rowId 無法比較時放尾端）。
 *
 * 只要有任何列的 productionQty 被編輯/新增，從該列起往後的累計值都標 isPredicted=true。
 */
export function computePredictedCumulative(
  input: ComputePredictedCumulativeInput
): PredictedCumulativeMap {
  const { detailRows, editingRowId, editingRowDraft, batchCreateDraftsByRowId, batchCreateMode, displayRows } = input;

  // 決定實際計算順序：顯示順序基本就是 rowId 遞增（既有列先、placeholder 後）
  const orderedRowIds = displayRows.map((r) => String(r.rowId));

  // 把既有列資料索引起來以便查詢原始 productionQty
  const rowById = new Map<string, WorkReportItem>();
  for (const row of detailRows) {
    rowById.set(String(row.rowId), row);
  }

  // 合併所有 draft 成單一 map：editingRowDraft 優先於 batchCreateDraftsByRowId
  // 這樣 ph1 正在編輯時，ph1 的 productionQty 一定來自 editingRowDraft（最新），
  // 而不會因為 useEffect sync 延遲，導致 ph1 用到舊的 batch draft 值
  const draftByRowId: Record<string, FormState> = batchCreateMode
    ? { ...batchCreateDraftsByRowId }
    : {};
  if (editingRowId && editingRowDraft) {
    draftByRowId[editingRowId] = editingRowDraft;
  }

  const result: PredictedCumulativeMap = new Map();
  let runningSum = 0;
  let seenDirty = false;

  for (const rowId of orderedRowIds) {
    const existing = rowById.get(rowId);
    const draft = draftByRowId[rowId];
    let qty: number;
    let rowDirty = false;

    if (draft) {
      qty = parseQty(draft.productionQty);
      const originalQty = parseQty(existing?.productionQty);
      if (qty !== originalQty || !existing) {
        rowDirty = true;
      }
    } else if (existing) {
      qty = parseQty(existing.productionQty);
    } else {
      continue;
    }

    runningSum += qty;
    if (rowDirty) {
      seenDirty = true;
    }
    result.set(rowId, { cum: runningSum, isPredicted: seenDirty });
  }

  return result;
}

/**
 * 給 modal 新增/單筆編輯用：依 Version B 算本筆的「依序累計量」
 * = sum(rowId < selfRowId 的產量) + 當下 draft 產量。
 *
 * @param detailRows 既有 detail rows
 * @param draftProductionQty 當下 draft 的產量字串
 * @param selfRowId 編輯模式傳自己的 rowId；新增模式傳 null（等於 append 到尾端，全加）
 */
export function predictModalCumulative(
  detailRows: WorkReportItem[],
  draftProductionQty: string,
  selfRowId: string | null = null
): number {
  const selfNum = selfRowId !== null ? Number(selfRowId) : Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const row of detailRows) {
    const rowNum = Number(row.rowId);
    if (!Number.isFinite(rowNum)) continue;
    if (rowNum >= selfNum) continue;
    sum += parseQty(row.productionQty);
  }
  return sum + parseQty(draftProductionQty);
}

