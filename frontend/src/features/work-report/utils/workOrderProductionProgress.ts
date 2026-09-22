import type { WorkReportItem } from "../../../api/workReport";
import { toSortableNumber } from "./valueUtils";

export type WorkOrderProductionProgressStatus =
  | "unavailable"
  | "below-target"
  | "target-met";

export interface WorkOrderProductionProgress {
  status: WorkOrderProductionProgressStatus;
  cumulativeQty: number | null;
  targetQty: number | null;
  shortfallQty: number | null;
  progressPercent: number | null;
}

export function resolveWorkOrderProductionProgress(
  cumulativeQtyValue: unknown,
  targetQtyValue: unknown
): WorkOrderProductionProgress {
  const cumulativeQty = toSortableNumber(cumulativeQtyValue);
  const targetQty = toSortableNumber(targetQtyValue);

  if (cumulativeQty === null || targetQty === null || targetQty <= 0) {
    return {
      status: "unavailable",
      cumulativeQty,
      targetQty,
      shortfallQty: null,
      progressPercent: null,
    };
  }

  const normalizedCumulativeQty = Math.max(0, cumulativeQty);
  const shortfallQty = Math.max(0, targetQty - normalizedCumulativeQty);

  return {
    status: shortfallQty > 0 ? "below-target" : "target-met",
    cumulativeQty: normalizedCumulativeQty,
    targetQty,
    shortfallQty,
    progressPercent: Math.max(
      0,
      Math.min(100, (normalizedCumulativeQty / targetQty) * 100)
    ),
  };
}

export function resolveLatestWorkOrderProductionProgress(
  detailRows: ReadonlyArray<Pick<WorkReportItem, "rowId" | "cumulativeQty">>,
  targetQtyValue: unknown
): WorkOrderProductionProgress {
  let latestRow: Pick<WorkReportItem, "rowId" | "cumulativeQty"> | null = null;
  let latestNumericRowId = Number.NEGATIVE_INFINITY;

  for (const [index, row] of detailRows.entries()) {
    const numericRowId = toSortableNumber(row.rowId);
    const rowOrder = numericRowId ?? index;
    if (rowOrder >= latestNumericRowId) {
      latestNumericRowId = rowOrder;
      latestRow = row;
    }
  }

  return resolveWorkOrderProductionProgress(
    latestRow ? latestRow.cumulativeQty : null,
    targetQtyValue
  );
}
