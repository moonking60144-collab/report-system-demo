import type { RagicRecord } from "../../../ragic/client";
import type { FormConfig } from "../../../types/formConfig";
import { getFirstFieldValue } from "../shared/subtableUtils";

interface MachineDefaultOption {
  value?: string;
  machineDefault?: {
    machineCode?: string;
    processCode?: string;
    status?: string;
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveFieldValue(
  entry: RagicRecord,
  primaryField: string | undefined,
  fallbackFields: string | undefined
): string {
  const fields = [
    ...(fallbackFields ?? "").split("|"),
    primaryField ?? "",
  ]
    .map((field) => field.trim())
    .filter(Boolean);
  return normalizeText(getFirstFieldValue(entry, fields));
}

export function resolveCreatePayloadProcessCodeDefault(
  config: FormConfig,
  entry: RagicRecord,
  machineOptions: MachineDefaultOption[] = []
): string {
  const entryDefaultProcessCode = resolveFieldValue(
    entry,
    config.mainFields.defaultProcessCode,
    config.mainFieldFallbacks?.defaultProcessCode
  );
  if (entryDefaultProcessCode) {
    return entryDefaultProcessCode;
  }

  const machineCode = resolveFieldValue(
    entry,
    config.mainFields.machineCode,
    config.mainFieldFallbacks?.machineCode
  );
  if (!machineCode) {
    return "";
  }

  const machineOption = machineOptions.find((option) => {
    const optionValue = normalizeText(option.value);
    const optionMachineCode = normalizeText(option.machineDefault?.machineCode);
    return optionValue === machineCode || optionMachineCode === machineCode;
  });
  const status = normalizeText(machineOption?.machineDefault?.status);
  if (status && status !== "使用中") {
    return "";
  }

  return normalizeText(machineOption?.machineDefault?.processCode);
}
