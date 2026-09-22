import type { FormConfig } from "../../../types/formConfig";
import type { RagicRecord } from "../../../ragic/client";
import { resolveCandidateFieldKeys } from "../queries/rowTransform";
import { getFirstFieldValue } from "./subtableUtils";

export const CLOSED_WORK_ORDER_STATUS = "已結案";

export function isWorkOrderClosedEntry(
  entry: RagicRecord,
  config: FormConfig
): boolean {
  const status = String(
    getFirstFieldValue(
      entry,
      resolveCandidateFieldKeys(
        config.mainFields.status ?? "",
        config.mainFieldFallbacks?.status
      )
    ) ?? ""
  ).trim();
  return status === CLOSED_WORK_ORDER_STATUS;
}
