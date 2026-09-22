import { Select } from "antd";
import type { DefaultOptionType } from "antd/es/select";
import { useTranslation } from "react-i18next";

export interface SearchableOption {
  value: string;
  label: string;
  display?: string;
  group?: string;
}

export type SearchableSelectLabelMode = "value-display" | "value-only";

interface SearchableSelectProps {
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  labelMode?: SearchableSelectLabelMode;
  searchable?: boolean;
  clearable?: boolean;
  editorKey?: string;
}

interface SearchableOptionType extends DefaultOptionType {
  searchText?: string;
}

export function SearchableSelect({
  value,
  options,
  onChange,
  onSelect,
  placeholder,
  disabled,
  labelMode = "value-display",
  searchable = true,
  clearable = true,
  editorKey,
}: SearchableSelectProps) {
  const { t } = useTranslation(["common"]);
  const normalizedOptions: (SearchableOptionType & { group?: string })[] = options.map((option) => {
    const displayLabel =
      labelMode === "value-only" ? option.value : option.label || option.value;
    const searchText = `${option.value} ${option.display ?? ""} ${option.label ?? ""}`
      .toLowerCase()
      .trim();

    return {
      value: option.value,
      label: displayLabel,
      searchText,
      group: option.group,
    };
  });

  const hasGroups = normalizedOptions.some((o) => o.group !== undefined);
  let selectOptions: DefaultOptionType[];
  if (!hasGroups) {
    selectOptions = normalizedOptions;
  } else {
    const groupOrder: string[] = [];
    const groupMap = new Map<string, SearchableOptionType[]>();
    for (const opt of normalizedOptions) {
      const g = opt.group ?? "其他";
      if (!groupMap.has(g)) {
        groupMap.set(g, []);
        if (g !== "其他") groupOrder.push(g);
      }
      groupMap.get(g)!.push(opt);
    }
    if (groupMap.has("其他")) groupOrder.push("其他");
    selectOptions = groupOrder.map((g) => ({ label: g, options: groupMap.get(g) ?? [] }));
  }

  return (
    <div data-inline-editor-key={editorKey}>
      <Select
        showSearch={searchable}
        allowClear={clearable}
        value={value || undefined}
        options={selectOptions}
        placeholder={placeholder ?? t("common:options.select")}
        disabled={disabled}
        notFoundContent={t("common:states.noOptions")}
        optionFilterProp="label"
        filterOption={(input, option) =>
          Boolean((option as SearchableOptionType | undefined)?.searchText?.includes(input.toLowerCase()))
        }
        onSelect={(selectedValue) =>
          onSelect?.(selectedValue === undefined || selectedValue === null ? "" : String(selectedValue))
        }
        onChange={(nextValue) => onChange(nextValue === undefined || nextValue === null ? "" : String(nextValue))}
      />
    </div>
  );
}
