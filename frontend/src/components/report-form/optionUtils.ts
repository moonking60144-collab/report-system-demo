import type { FormOptionItem } from "../../api/workReport";

/** Ragic 機台表「狀態」欄位的可選機台 token（使用中）。
 *  報廢 / 售出 這些不讓使用者重新指派（只保留作為舊資料的顯示值）。 */
const ACTIVE_MACHINE_STATUS = "使用中";

export function withCurrentValue(
  options: FormOptionItem[] | undefined,
  currentValue: string
): FormOptionItem[] {
  if (!currentValue.trim()) {
    return options ?? [];
  }

  const base = options ?? [];
  if (base.some((item) => item.value === currentValue)) {
    return base;
  }

  return [{ value: currentValue, label: currentValue, display: currentValue }, ...base];
}

/** 過濾只保留「使用中」的機台；當前值若非使用中（報廢 / 售出），
 *  補回清單頂部、label 加狀態 suffix（例：「P10 - Process A Machine（報廢）」），
 *  讓舊資料仍能正確顯示，但使用者**新選**時只能從使用中清單裡挑。
 *
 *  Why: Ragic 狀態欄目前三值「使用中 / 報廢 / 售出」，只有使用中算可派工機台。
 *  How to apply: 所有 machineId picker 場景（inline / modal / 主機台更改 / Form 16 downtime）
 *  都該用這支取代原本 withCurrentValue。 */
export function filterActiveMachineOptionsWithCurrentValue(
  options: FormOptionItem[] | undefined,
  currentValue: string
): FormOptionItem[] {
  const base = options ?? [];
  const filtered = base.filter((item) => {
    const status = item.machineDefault?.status?.trim();
    // 無狀態資料視為可選（防禦性：避免後端資料缺失時把清單過濾光）
    return !status || status === ACTIVE_MACHINE_STATUS;
  });

  const trimmedCurrent = currentValue.trim();
  if (!trimmedCurrent) {
    return filtered;
  }

  if (filtered.some((item) => item.value === trimmedCurrent)) {
    return filtered;
  }

  const originalItem = base.find((item) => item.value === trimmedCurrent);
  if (originalItem) {
    // 同時裝飾 label 跟 display：picker 列表有的讀 label、當前值顯示區有的讀 display。
    // 兩邊都 suffix 才能在 UI 各處一致看到「（報廢）」標記。
    const suffix = buildMachineStatusSuffix(originalItem);
    return [
      {
        ...originalItem,
        label: `${originalItem.label}${suffix}`,
        display: `${originalItem.display}${suffix}`,
      },
      ...filtered,
    ];
  }

  // 連原始清單都查無：fallback 保留原 withCurrentValue 行為，用純字串 token 補位
  return [
    { value: trimmedCurrent, label: trimmedCurrent, display: trimmedCurrent },
    ...filtered,
  ];
}

/** 取得某機台 option 加上狀態 suffix 的 label（給「當前值」獨立顯示區用）。
 *  若狀態為 null / 使用中則回原 label，否則加「（xxx）」。 */
export function decorateMachineOptionLabel(option: FormOptionItem): string {
  const suffix = buildMachineStatusSuffix(option);
  return suffix ? `${option.label}${suffix}` : option.label;
}

/** 取得機台 option 的狀態 suffix 字串（例：「（報廢）」）；
 *  使用中 / 無狀態時回空字串。給需要把 suffix 加到 `display` 而非 `label` 的場景用。 */
export function buildMachineStatusSuffix(option: FormOptionItem): string {
  const status = option.machineDefault?.status?.trim();
  if (!status || status === ACTIVE_MACHINE_STATUS) {
    return "";
  }
  return `（${status}）`;
}

/** 判斷某機台 option 是否為「使用中」（供 UI 決定是否 disabled / 灰顯） */
export function isActiveMachineOption(option: FormOptionItem | null | undefined): boolean {
  if (!option) {
    return false;
  }
  const status = option.machineDefault?.status?.trim();
  return !status || status === ACTIVE_MACHINE_STATUS;
}

export function buildLocalizedOptions(
  values: readonly string[],
  localize: (value: string) => string
): FormOptionItem[] {
  return values.map((value) => {
    const localized = localize(value);
    return {
      value,
      label: localized,
      display: localized,
    };
  });
}
