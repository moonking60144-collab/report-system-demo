import { FormConfig } from "../../types/formConfig";
import { HttpError } from "../../utils/httpError";
import { FORM_901_CONFIG } from "./form-901";
import { FORM_902_CONFIG } from "./form-902";

const FORM_CONFIGS: Record<string, FormConfig> = {
  "901": FORM_901_CONFIG,
  "902": FORM_902_CONFIG,
};

export function getFormConfig(formId: string): FormConfig {
  const config = FORM_CONFIGS[formId];
  if (!config) {
    throw new HttpError(400, `不支援的表單編號：${formId}`, "FORM_NOT_SUPPORTED");
  }

  if (!config.ragicPath.trim()) {
    throw new HttpError(
      500,
      `表單 ${formId} 尚未完成設定（缺少 RAGIC_FORM_${formId}_PATH）`,
      "FORM_NOT_CONFIGURED"
    );
  }

  return config;
}

export function listFormConfigs(): FormConfig[] {
  return Object.values(FORM_CONFIGS);
}
