import type { DevAiKnowledgeSource, RagicDefinitionFormDetail } from "@shared-types/ragicDefinitions";
import { knowledgeEvidenceForRanges } from "./devAiKnowledgeEvidence";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { asksForWorkflow } from "./devAiFormContext";

export function formEvidence(detail: RagicDefinitionFormDetail, question: string): DevAiKnowledgeSource[] {
  const formPath = detail.form.formPath;
  const workflowRequested = asksForWorkflow(question);
  const overview = [
    `表單：${detail.form.formName}；路徑：${formPath}`,
    `欄位 ${detail.fields.length}；公式 ${detail.formulas.length}；Workflow ${detail.workflows.length}`,
    `欄位摘要（前 24 個）：${detail.fields.slice(0, 24).map(field =>
      `${field.fieldName} [${field.fieldId}] 位置=${field.position} 設定=${JSON.stringify(field.attrs)}`).join("；")}`,
    `Workflow 檔案：${detail.workflows.map(workflow => `${workflow.fileName} (${workflow.scope}, ${workflow.charCount} chars)`).join("；")}`,
    "以上為公開 Demo 的合成 definitions，並非正式 Ragic 即時紀錄；這份樣本沒有主表／子表歸屬或按鈕綁定，不能推導必填條件或業務步驟的先後順序。",
  ].join("\n");
  const result: DevAiKnowledgeSource[] = [{ sourceId: `definitions:${formPath}:overview`, title: detail.form.formName,
    kind: "definitions", formPath, path: formPath, score: 20,
    ...knowledgeEvidenceForRanges(overview, [{ start: 0, end: overview.length }]) }];
  const positions = new Set((question.match(/\b[A-Z]+\d+\b/gi) ?? []).map(position => position.toUpperCase()));
  const matchingFields = detail.fields.filter(field =>
    (field.position && positions.has(field.position.toUpperCase())) ||
    (field.fieldName.length > 1 && question.includes(field.fieldName)));
  for (const field of matchingFields.slice(0, 4)) {
    const formulas = detail.formulas.filter(formula => formula.fieldId === field.fieldId && formula.position === field.position);
    const content = maskSecrets(JSON.stringify({ formPath, field, formulas }));
    result.push({ sourceId: `definitions:${formPath}:field:${field.fieldId}:${field.position}`, title: `${detail.form.formName} · ${field.fieldName} · ${field.position}`,
      kind: "definitions", sourceType: "field", formPath, fieldId: field.fieldId, path: `forms/${formPath}/fields.json`, score: 30,
      ...knowledgeEvidenceForRanges(content, [{ start: 0, end: Math.min(content.length, 4000) }]) });
  }
  if (workflowRequested) for (const workflow of detail.workflows.slice(0, 5)) {
    const content = maskSecrets(workflow.content);
    const terms = question.match(/[A-Za-z_$][\w$]{3,}/g)?.filter(term => !/^(workflow|javascript|https|default|forms\d*)$/i.test(term)) ?? [];
    const declaration = terms.map(term => content.search(new RegExp(`\\bfunction\\s+${term.replace(/\$/g, "\\$")}\\s*\\(`))).find(index => index >= 0);
    const offset = declaration ?? terms.map(term => content.indexOf(term)).find(index => index >= 0) ?? 0;
    const start = Math.max(0, offset - 150);
    const end = Math.min(content.length, start + 2400);
    const line = content.slice(0, start).split("\n").length;
    result.push({ sourceId: `definitions:${formPath}:workflow:${workflow.fileName}`, title: `${detail.form.formName} · ${workflow.fileName}（第 ${line} 行起節錄，非完整程式）`,
      kind: "definitions", sourceType: "workflow", formPath, path: `forms/${formPath}/workflows/${workflow.fileName}`, score: 18,
      ...knowledgeEvidenceForRanges(content, [{ start, end }]) });
  }
  return result;
}
