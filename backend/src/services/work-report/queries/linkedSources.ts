import { ragicClient } from "../../../ragic/client";
import type { RagicReadPriority } from "../../../infra/ragicRequestScheduler";
import { LinkedFieldMapping } from "../../../types/formConfig";
import { mapSourceDataById, SourceDataMap } from "../shared/ragicRowUtils";

/**
 * Priority **必填**，不提供 default。
 * 理由：default="user" 會讓背景路徑 caller 忘記傳時 silently drop 回 user lane
 * （就是我們修過的 silent-priority-drop 類型 bug），型別層直接強制 caller 選。
 */
export async function prepareLinkedSourceMaps(
  linkedFields: LinkedFieldMapping | undefined,
  priority: RagicReadPriority
): Promise<Map<string, SourceDataMap>> {
  const sourceMaps = new Map<string, SourceDataMap>();
  if (!linkedFields) {
    return sourceMaps;
  }

  const cacheBySourcePath = new Map<string, SourceDataMap>();
  for (const [fieldName, linkedConfig] of Object.entries(linkedFields)) {
    if (!linkedConfig.sourceFormPath) {
      continue;
    }

    let sourceMap = cacheBySourcePath.get(linkedConfig.sourceFormPath);
    if (!sourceMap) {
      // 背景 / sync 流程透過 priority 參數隔離 lane；
      // getFormData 預設 user lane，這裡讓 caller 明確指定。
      const sourceRawData = await ragicClient.getFormDataWithOptions(
        linkedConfig.sourceFormPath,
        true,
        { priority }
      );
      sourceMap = mapSourceDataById(sourceRawData, linkedConfig.lookupFieldId);
      cacheBySourcePath.set(linkedConfig.sourceFormPath, sourceMap);
    }
    sourceMaps.set(fieldName, sourceMap);
  }

  return sourceMaps;
}
