import type { DevAiKnowledgeSource } from "@shared-types/ragicDefinitions";

export interface RagicOfficialKnowledgeSeed {
  sourceId: string;
  title: string;
  path: string;
  kind: Extract<DevAiKnowledgeSource["kind"], "official">;
  content: string;
}

export const RAGIC_OFFICIAL_KNOWLEDGE_SEEDS: RagicOfficialKnowledgeSeed[] = [
  {
    sourceId: "official:ragic-formulas",
    title: "Ragic 官方公式設計重點",
    path: "https://www.ragic.com/intl/zh-TW/doc/26/formulas",
    kind: "official",
    content: [
      "# Ragic 官方公式設計重點",
      "source: https://www.ragic.com/intl/zh-TW/doc/26/formulas",
      "domain: Ragic formula formulas 公式 ISBLANK IF SUMIF SUMIFS UPDATEIF 子表格 多選欄位 公式重算 dry-run",
      "",
      "- Ragic 公式不是 Excel 相容層；只能使用 Ragic 官方支援的公式與語法。",
      "- 公式參照的是欄位標頭所在位置，例如 A6、C9；不能憑欄位名稱或不存在的位置猜測。",
      "- 若使用者要求引用某欄位，但 definitions context 找不到該欄位或位置，應回報 blocker，不要發明 fallback 欄位。",
      "- 套用公式的欄位種類要符合輸出，例如數值運算結果應放在數值或金額欄位，日期公式應放在日期欄位。",
      "- 字串常數需要加引號；單引號與雙引號皆可，但輸出給 .nui / dry-run 時要維持一致且可解析。",
      "- 公式函數名稱使用大寫，例如 IF、ISBLANK、SUM、SUMIF、SUMIFS、AND、OR、NOT。",
      "- ISBLANK 可檢查欄位空值，常見寫法：IF(ISBLANK(A2), 'Y', 'N')。",
      "- Ragic 不支援用冒號做範圍加總；需要依 Ragic 支援的 SUM / SUMIF / SUMIFS / 子表格公式規則處理。",
      "- 公式修改不會自動重算既有資料；公式設計變更後若要套用歷史資料，需要走 Ragic 的公式重算或 workflow 重算流程。",
      "- AI 產生的公式只可作為草案，必須經 dry-run、人工檢查與實測，不能直接 apply。",
    ].join("\n"),
  },
  {
    sourceId: "official:ragic-workflow-es5",
    title: "Ragic 官方 Workflow / Nashorn ES5.1 重點",
    path: "https://www.ragic.com/docs/workflow/zh-TW/",
    kind: "official",
    content: [
      "# Ragic 官方 Workflow / Nashorn ES5.1 重點",
      "source: https://www.ragic.com/docs/workflow/zh-TW/",
      "domain: Ragic workflow JavaScript Nashorn ECMAScript 5.1 pre workflow post workflow action button global workflow getNewValue setIfExecuteWorkflow",
      "",
      "- Ragic workflow 是伺服器端 JavaScript，引擎基於 Nashorn，支援 ECMAScript 5.1；不要產生 ES6+ 語法。",
      "- 不能使用瀏覽器 API，例如 document、alert、setTimeout、setInterval；除錯以 log.setToConsole(true) / log.println(...) 或 log.info(...) 為主。",
      "- workflow 類型包含動作按鈕、Post workflow、Pre workflow、Daily workflow、Approval workflow；Global workflow 用來放共用函式。",
      "- 動作按鈕可用 {id} 傳入目前記錄 ID；動作按鈕不支援 response.setStatus('CONFIRM')。",
      "- Pre/Post workflow 使用 param 取得上下文；Pre workflow 驗證提交值時優先用 param.getNewValue(fieldId)、param.getOldValue(fieldId)、param.getOperationType(fieldId)。",
      "- Post workflow 可用 param.getUpdatedEntry() / param.getEntry() 取得已儲存項目。",
      "- response.setStatus('INVALID') 或 ERROR 會阻止儲存；WARN 允許繼續；訊息用 response.setMessage(...)。",
      "- Java 傳入的陣列不一定可直接使用 join/map；需要先轉成 JavaScript array 再操作。",
      "- 跨表單寫入或 entry.save() 類流程要明確處理 workflow 觸發語意；若需要連動 workflow，應檢查是否要呼叫 entry.setIfExecuteWorkflow(true)。",
      "- 產生 workflow 建議時必須先確認實際 workflow type、可用物件與欄位 ID；不能把 browser JS 或 Node.js API 放進 Ragic workflow。",
    ].join("\n"),
  },
];
