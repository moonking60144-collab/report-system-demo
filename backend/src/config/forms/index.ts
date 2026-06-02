import { FormConfig } from "../../types/formConfig";
import { HttpError } from "../../utils/httpError";
import { FORM_104_CONFIG } from "./form-104";
import { FORM_105_CONFIG } from "./form-105";

const FORM_CONFIGS: Record<string, FormConfig> = {
  "104": FORM_104_CONFIG,
  "105": FORM_105_CONFIG,
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
