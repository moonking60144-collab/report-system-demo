import { useCallback, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { OperatorGroupFilter } from "../../../../components/report-form/OperatorGroupFilter";
import {
  ALL_MACHINE_GROUP_KEY,
  buildMachineGroupOptions,
  filterMachineOptionsByGroup,
  readMachineGroupPreference,
  resolveMachineGroupPreference,
  type MachineGroupOption,
  writeMachineGroupPreference,
} from "../../../../components/report-form/machineGroupPreferences";
import {
  ALL_OPERATOR_GROUP_KEY,
  buildOperatorGroupOptions,
  filterOperatorOptionsByGroup,
  readOperatorGroupPreference,
  resolveOperatorGroupPreference,
  type OperatorGroupOption,
  writeOperatorGroupPreference,
} from "../../../../components/report-form/operatorGroupPreferences";
import {
  ALL_PROCESS_GROUP_KEY,
  buildProcessGroupOptions,
  filterProcessOptionsByGroup,
  readProcessGroupPreference,
  resolveProcessGroupPreference,
  type ProcessGroupOption,
  writeProcessGroupPreference,
} from "../../../../components/report-form/processGroupPreferences";
import {
  filterActiveMachineOptionsWithCurrentValue,
  isActiveMachineOption,
} from "../../../../components/report-form/optionUtils";
import type { FormState } from "../../../../components/report-form/types";
import type { FormOptionItem } from "../../../../api/workReport";
import type { WorkReportFormId } from "../../types";
import type { LinkedPickerState } from "./types";

interface DetailPickerOption {
  value: string;
  display: string;
  group?: string;
  metaLines?: string[];
}

interface DetailLinkedPickerCopy {
  title: string;
  hint: string;
  searchLabel: string;
  searchPlaceholder: string;
  emptyText: string;
}

function filterPickerOptionsByKeyword<T extends DetailPickerOption>(
  options: T[],
  keyword: string
): T[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) {
    return options;
  }
  return options.filter((option) => {
    const value = option.value.toLowerCase();
    const display = option.display.toLowerCase();
    return value.includes(normalizedKeyword) || display.includes(normalizedKeyword);
  });
}

function mapBasicPickerOptions(options: FormOptionItem[]): DetailPickerOption[] {
  return options.map((option) => ({
    value: option.value,
    display: option.display,
  }));
}

interface UseWorkReportDetailPickerControllerArgs {
  formId: WorkReportFormId | null;
  t: (key: string, options?: Record<string, unknown>) => string;
  formOptions: Record<string, FormOptionItem[]>;
  recordMachineCode?: string | null;
  linkedPickerState: LinkedPickerState | null;
  editingRowDraft: FormState | null;
  mainMachineDraft: string;
  mainMachinePickerSearch: string;
  selectedInlineMachineOption: FormOptionItem | null;
  inlineMachineOptions: FormOptionItem[];
  inlineOperatorOptions: FormOptionItem[];
  inlineProcessOptions: FormOptionItem[];
  inputOptionPickerOptions: FormOptionItem[];
  shiftTypePickerOptions: FormOptionItem[];
  plannedIdlePickerOptions: FormOptionItem[];
  setupAdjustTypePickerOptions: FormOptionItem[];
  countSetupTimeFlagPickerOptions: FormOptionItem[];
  containerUnitPickerOptions: FormOptionItem[];
}

function buildMachineMetaLines(option: FormOptionItem): string[] {
  return [
    [option.machineDefault?.processCategoryCode, option.machineDefault?.processCategoryName]
      .filter(Boolean)
      .join(" "),
    option.machineDefault?.mainOperatorName
      ? `主要操作者: ${option.machineDefault.mainOperatorName}`
      : "",
    option.machineDefault?.processCode ? `子製程: ${option.machineDefault.processCode}` : "",
    option.machineDefault?.machineSpec ? `規格: ${option.machineDefault.machineSpec}` : "",
    option.machineDefault?.machineSpeed ? `分速: ${option.machineDefault.machineSpeed}` : "",
  ].filter(Boolean);
}

export function useWorkReportDetailPickerController({
  formId,
  t,
  formOptions,
  recordMachineCode,
  linkedPickerState,
  editingRowDraft,
  mainMachineDraft,
  mainMachinePickerSearch,
  selectedInlineMachineOption,
  inlineMachineOptions,
  inlineOperatorOptions,
  inlineProcessOptions,
  inputOptionPickerOptions,
  shiftTypePickerOptions,
  plannedIdlePickerOptions,
  setupAdjustTypePickerOptions,
  countSetupTimeFlagPickerOptions,
  containerUnitPickerOptions,
}: UseWorkReportDetailPickerControllerArgs) {
  const [machineGroupOverrideByForm, setMachineGroupOverrideByForm] = useState<
    Partial<Record<WorkReportFormId, string>>
  >({});
  const [operatorGroupOverrideByForm, setOperatorGroupOverrideByForm] = useState<
    Partial<Record<WorkReportFormId, string>>
  >({});
  const [processGroupOverrideByForm, setProcessGroupOverrideByForm] = useState<
    Partial<Record<WorkReportFormId, string>>
  >({});

  const blankTokenLabel = t("workReport:values.special.blankToken");
  const deferredLinkedPickerSearch = useDeferredValue(linkedPickerState?.search ?? "");
  const deferredMainMachinePickerSearch = useDeferredValue(mainMachinePickerSearch);

  const mainMachineOptions = useMemo<FormOptionItem[]>(
    () =>
      filterActiveMachineOptionsWithCurrentValue(
        formOptions.machineId,
        mainMachineDraft || String(recordMachineCode ?? "").trim()
      ),
    [formOptions.machineId, mainMachineDraft, recordMachineCode]
  );

  // Group 清單只 build「使用中」機台的分類；否則會出現某 group 在下拉選項裡、但 picker 點進去空白的情況。
  const machineGroupOptions = useMemo<MachineGroupOption[]>(
    () => buildMachineGroupOptions((formOptions.machineId ?? []).filter(isActiveMachineOption)),
    [formOptions.machineId]
  );
  const operatorGroupOptions = useMemo<OperatorGroupOption[]>(
    () => buildOperatorGroupOptions(formOptions.operatorId ?? []),
    [formOptions.operatorId]
  );
  const processGroupOptions = useMemo<ProcessGroupOption[]>(
    () => buildProcessGroupOptions(formOptions.processCode ?? []),
    [formOptions.processCode]
  );

  const resolvedMachineGroupKey = useMemo(() => {
    if (!formId) {
      return ALL_MACHINE_GROUP_KEY;
    }
    return resolveMachineGroupPreference(
      machineGroupOptions,
      machineGroupOverrideByForm[formId] ?? readMachineGroupPreference(formId),
      selectedInlineMachineOption?.machineDefault?.processCategoryCode ??
        inlineMachineOptions.find(
          (option) =>
            option.machineDefault?.machineCode?.trim() === String(recordMachineCode ?? "").trim()
        )?.machineDefault?.processCategoryCode
    );
  }, [
    formId,
    inlineMachineOptions,
    machineGroupOverrideByForm,
    machineGroupOptions,
    recordMachineCode,
    selectedInlineMachineOption?.machineDefault?.processCategoryCode,
  ]);
  const resolvedOperatorGroupKey = useMemo(() => {
    if (!formId) {
      return ALL_OPERATOR_GROUP_KEY;
    }
    return resolveOperatorGroupPreference(
      formId,
      operatorGroupOptions,
      operatorGroupOverrideByForm[formId] ?? readOperatorGroupPreference(formId)
    );
  }, [formId, operatorGroupOptions, operatorGroupOverrideByForm]);
  const resolvedProcessGroupKey = useMemo(() => {
    if (!formId) {
      return ALL_PROCESS_GROUP_KEY;
    }
    return resolveProcessGroupPreference(
      processGroupOptions,
      processGroupOverrideByForm[formId] ?? readProcessGroupPreference(formId)
    );
  }, [formId, processGroupOptions, processGroupOverrideByForm]);

  const handleOperatorGroupPreferenceChange = useCallback(
    (groupKey: string) => {
      if (!formId) {
        return;
      }
      setOperatorGroupOverrideByForm((prev) => ({
        ...prev,
        [formId]: groupKey,
      }));
      writeOperatorGroupPreference(formId, groupKey);
    },
    [formId]
  );

  const handleMachineGroupPreferenceChange = useCallback(
    (groupKey: string) => {
      if (!formId) {
        return;
      }
      setMachineGroupOverrideByForm((prev) => ({
        ...prev,
        [formId]: groupKey,
      }));
      writeMachineGroupPreference(formId, groupKey);
    },
    [formId]
  );

  const handleProcessGroupPreferenceChange = useCallback(
    (groupKey: string) => {
      if (!formId) {
        return;
      }
      setProcessGroupOverrideByForm((prev) => ({
        ...prev,
        [formId]: groupKey,
      }));
      writeProcessGroupPreference(formId, groupKey);
    },
    [formId]
  );

  const selectedMachineGroupLabel = useMemo(
    () =>
      (
        machineGroupOptions.find((option) => option.key === resolvedMachineGroupKey)?.label ?? ""
      ).trim(),
    [machineGroupOptions, resolvedMachineGroupKey]
  );
  const selectedOperatorGroupLabel = useMemo(
    () =>
      (
        operatorGroupOptions.find((option) => option.key === resolvedOperatorGroupKey)?.label ?? ""
      ).trim(),
    [operatorGroupOptions, resolvedOperatorGroupKey]
  );

  const machinePickerBaseOptions = useMemo<DetailPickerOption[]>(
    () =>
      filterMachineOptionsByGroup(inlineMachineOptions, resolvedMachineGroupKey).map((opt) => ({
        value: opt.value,
        display: opt.display,
        group:
          resolvedMachineGroupKey !== ALL_MACHINE_GROUP_KEY
            ? selectedMachineGroupLabel || undefined
            : undefined,
        metaLines: buildMachineMetaLines(opt),
      })),
    [inlineMachineOptions, resolvedMachineGroupKey, selectedMachineGroupLabel]
  );
  const operatorPickerBaseOptions = useMemo<DetailPickerOption[]>(
    () =>
      filterOperatorOptionsByGroup(inlineOperatorOptions, resolvedOperatorGroupKey).map((opt) => ({
        value: opt.value,
        display: opt.display,
        group:
          resolvedOperatorGroupKey !== ALL_OPERATOR_GROUP_KEY
            ? selectedOperatorGroupLabel || undefined
            : undefined,
      })),
    [inlineOperatorOptions, resolvedOperatorGroupKey, selectedOperatorGroupLabel]
  );
  const processPickerBaseOptions = useMemo<DetailPickerOption[]>(
    () =>
      filterProcessOptionsByGroup(inlineProcessOptions, resolvedProcessGroupKey).map((opt) => ({
        value: opt.value,
        display: opt.display,
        group: opt.processGroupLabel?.trim() || opt.processGroupKey?.trim() || "其他",
      })),
    [inlineProcessOptions, resolvedProcessGroupKey]
  );
  const inputOptionPickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(inputOptionPickerOptions),
    [inputOptionPickerOptions]
  );
  const shiftTypePickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(shiftTypePickerOptions),
    [shiftTypePickerOptions]
  );
  const plannedIdlePickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(plannedIdlePickerOptions),
    [plannedIdlePickerOptions]
  );
  const setupAdjustTypePickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(setupAdjustTypePickerOptions),
    [setupAdjustTypePickerOptions]
  );
  const countSetupTimeFlagPickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(countSetupTimeFlagPickerOptions),
    [countSetupTimeFlagPickerOptions]
  );
  const containerUnitPickerBaseOptions = useMemo<DetailPickerOption[]>(
    () => mapBasicPickerOptions(containerUnitPickerOptions),
    [containerUnitPickerOptions]
  );
  const filteredLinkedPickerOptions = useMemo<DetailPickerOption[]>(() => {
    let options = machinePickerBaseOptions;
    switch (linkedPickerState?.key) {
      case "processCode":
        options = processPickerBaseOptions;
        break;
      case "operatorId":
        options = operatorPickerBaseOptions;
        break;
      case "inputOptions":
        options = inputOptionPickerBaseOptions;
        break;
      case "shiftType":
        options = shiftTypePickerBaseOptions;
        break;
      case "plannedIdle":
        options = plannedIdlePickerBaseOptions;
        break;
      case "setupAdjustType":
        options = setupAdjustTypePickerBaseOptions;
        break;
      case "countSetupTimeFlag":
        options = countSetupTimeFlagPickerBaseOptions;
        break;
      case "containerUnit":
        options = containerUnitPickerBaseOptions;
        break;
      default:
        options = machinePickerBaseOptions;
        break;
    }
    return filterPickerOptionsByKeyword(options, deferredLinkedPickerSearch);
  }, [
    containerUnitPickerBaseOptions,
    countSetupTimeFlagPickerBaseOptions,
    deferredLinkedPickerSearch,
    inputOptionPickerBaseOptions,
    linkedPickerState?.key,
    machinePickerBaseOptions,
    operatorPickerBaseOptions,
    plannedIdlePickerBaseOptions,
    processPickerBaseOptions,
    setupAdjustTypePickerBaseOptions,
    shiftTypePickerBaseOptions,
  ]);

  const linkedPickerCopy = useMemo<DetailLinkedPickerCopy | null>(() => {
    if (!linkedPickerState) {
      return null;
    }

    switch (linkedPickerState.key) {
      case "processCode":
        return {
          title: t("workReport:detailPage.processPickerTitle"),
          hint: t("workReport:detailPage.processPickerHint"),
          searchLabel: t("workReport:detailPage.processPickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.processPickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.processPickerEmpty"),
        };
      case "operatorId":
        return {
          title: t("workReport:detailPage.operatorPickerTitle"),
          hint: t("workReport:detailPage.operatorPickerHint"),
          searchLabel: t("workReport:detailPage.operatorPickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.operatorPickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.operatorPickerEmpty"),
        };
      case "inputOptions":
        return {
          title: t("workReport:detailPage.inputOptionPickerTitle"),
          hint: t("workReport:detailPage.inputOptionPickerHint"),
          searchLabel: t("workReport:detailPage.inputOptionPickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.inputOptionPickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.inputOptionPickerEmpty"),
        };
      case "shiftType":
        return {
          title: t("workReport:detailPage.shiftTypePickerTitle"),
          hint: t("workReport:detailPage.shiftTypePickerHint"),
          searchLabel: t("workReport:detailPage.shiftTypePickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.shiftTypePickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.shiftTypePickerEmpty"),
        };
      case "plannedIdle":
        return {
          title: t("workReport:detailPage.plannedIdlePickerTitle"),
          hint: t("workReport:detailPage.plannedIdlePickerHint"),
          searchLabel: t("workReport:detailPage.plannedIdlePickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.plannedIdlePickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.plannedIdlePickerEmpty"),
        };
      case "setupAdjustType":
        return {
          title: t("workReport:detailPage.setupAdjustTypePickerTitle"),
          hint: t("workReport:detailPage.setupAdjustTypePickerHint"),
          searchLabel: t("workReport:detailPage.setupAdjustTypePickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.setupAdjustTypePickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.setupAdjustTypePickerEmpty"),
        };
      case "countSetupTimeFlag":
        return {
          title: t("workReport:detailPage.countSetupTimeFlagPickerTitle"),
          hint: t("workReport:detailPage.countSetupTimeFlagPickerHint"),
          searchLabel: t("workReport:detailPage.countSetupTimeFlagPickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.countSetupTimeFlagPickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.countSetupTimeFlagPickerEmpty"),
        };
      case "containerUnit":
        return {
          title: t("workReport:detailPage.containerUnitPickerTitle"),
          hint: t("workReport:detailPage.containerUnitPickerHint"),
          searchLabel: t("workReport:detailPage.containerUnitPickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.containerUnitPickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.containerUnitPickerEmpty"),
        };
      default:
        return {
          title: t("workReport:detailPage.machinePickerTitle"),
          hint: t("workReport:detailPage.machinePickerHint"),
          searchLabel: t("workReport:detailPage.machinePickerSearchLabel"),
          searchPlaceholder: t("workReport:detailPage.machinePickerSearchPlaceholder"),
          emptyText: t("workReport:detailPage.machinePickerEmpty"),
        };
    }
  }, [linkedPickerState, t]);

  const linkedPickerSelectedValue = useMemo(() => {
    if (!linkedPickerState) {
      return "";
    }

    switch (linkedPickerState.key) {
      case "processCode":
        return editingRowDraft?.processCode ?? "";
      case "operatorId":
        return editingRowDraft?.operatorId ?? "";
      case "inputOptions":
        return editingRowDraft?.inputOptions ?? "";
      case "shiftType":
        return editingRowDraft?.shiftType ?? "";
      case "plannedIdle":
        return editingRowDraft?.plannedIdle ?? "";
      case "setupAdjustType":
        return editingRowDraft?.setupAdjustType ?? "";
      case "countSetupTimeFlag":
        return editingRowDraft?.countSetupTimeFlag ?? "";
      case "containerUnit":
        return editingRowDraft?.containerUnit ?? "";
      default:
        return editingRowDraft?.machineId ?? "";
    }
  }, [
    editingRowDraft?.containerUnit,
    editingRowDraft?.countSetupTimeFlag,
    editingRowDraft?.inputOptions,
    editingRowDraft?.machineId,
    editingRowDraft?.operatorId,
    editingRowDraft?.plannedIdle,
    editingRowDraft?.processCode,
    editingRowDraft?.setupAdjustType,
    editingRowDraft?.shiftType,
    linkedPickerState,
  ]);

  const currentLinkedPickerOption = useMemo<DetailPickerOption | null>(() => {
    if (!linkedPickerState) {
      return null;
    }

    if (linkedPickerState.key === "processCode") {
      const selected = inlineProcessOptions.find(
        (option) => option.value === (editingRowDraft?.processCode ?? "")
      );
      return selected
        ? {
            value: selected.value,
            display: selected.display,
            group:
              selected.processGroupLabel?.trim() ||
              selected.processGroupKey?.trim() ||
              "其他",
          }
        : null;
    }

    if (linkedPickerState.key === "operatorId") {
      const selected = inlineOperatorOptions.find(
        (option) => option.value === (editingRowDraft?.operatorId ?? "")
      );
      return selected
        ? {
            value: selected.value,
            display: selected.display,
          }
        : null;
    }

    if (linkedPickerState.key === "machineId") {
      const selected = inlineMachineOptions.find(
        (option) => option.value === (editingRowDraft?.machineId ?? "")
      );
      return selected
        ? {
            value: selected.value,
            display: selected.display,
            metaLines: buildMachineMetaLines(selected),
          }
        : null;
    }

    const selectedValue = linkedPickerSelectedValue;
    const selected =
      linkedPickerState.key === "plannedIdle"
        ? plannedIdlePickerBaseOptions.find((option) => option.value === selectedValue)
        : linkedPickerState.key === "setupAdjustType"
          ? setupAdjustTypePickerBaseOptions.find((option) => option.value === selectedValue)
          : linkedPickerState.key === "countSetupTimeFlag"
            ? countSetupTimeFlagPickerBaseOptions.find((option) => option.value === selectedValue)
            : linkedPickerState.key === "containerUnit"
              ? containerUnitPickerBaseOptions.find((option) => option.value === selectedValue)
              : null;
    return selected ?? null;
  }, [
    containerUnitPickerBaseOptions,
    countSetupTimeFlagPickerBaseOptions,
    editingRowDraft?.machineId,
    editingRowDraft?.operatorId,
    editingRowDraft?.processCode,
    inlineMachineOptions,
    inlineOperatorOptions,
    inlineProcessOptions,
    linkedPickerSelectedValue,
    linkedPickerState,
    plannedIdlePickerBaseOptions,
    setupAdjustTypePickerBaseOptions,
  ]);

  const linkedPickerTopContent = useMemo<ReactNode>(() => {
    if (linkedPickerState?.key === "operatorId") {
      return (
        <OperatorGroupFilter
          className="detail-picker-group-filter"
          label={t("workReport:detailPage.operatorPickerGroupLabel")}
          allLabel={t("common:options.all")}
          selectedGroupKey={resolvedOperatorGroupKey}
          options={operatorGroupOptions}
          onChange={handleOperatorGroupPreferenceChange}
        />
      );
    }

    if (linkedPickerState?.key === "machineId") {
      return (
        <OperatorGroupFilter
          className="detail-picker-group-filter"
          label={t("workReport:detailPage.machinePickerGroupLabel")}
          allLabel={t("common:options.all")}
          selectedGroupKey={resolvedMachineGroupKey}
          options={machineGroupOptions}
          onChange={handleMachineGroupPreferenceChange}
        />
      );
    }

    if (linkedPickerState?.key === "processCode") {
      return (
        <OperatorGroupFilter
          className="detail-picker-group-filter"
          label={t("workReport:detailPage.processPickerGroupLabel")}
          allLabel={t("common:options.all")}
          selectedGroupKey={resolvedProcessGroupKey}
          options={processGroupOptions}
          onChange={handleProcessGroupPreferenceChange}
        />
      );
    }

    return null;
  }, [
    handleMachineGroupPreferenceChange,
    handleOperatorGroupPreferenceChange,
    handleProcessGroupPreferenceChange,
    linkedPickerState?.key,
    machineGroupOptions,
    operatorGroupOptions,
    processGroupOptions,
    resolvedMachineGroupKey,
    resolvedOperatorGroupKey,
    resolvedProcessGroupKey,
    t,
  ]);

  const mainMachinePickerCopy = useMemo<DetailLinkedPickerCopy>(
    () => ({
      title: t("workReport:detailPage.machinePickerTitle"),
      hint: t("workReport:detailPage.machinePickerHint"),
      searchLabel: t("workReport:detailPage.machinePickerSearchLabel"),
      searchPlaceholder: t("workReport:detailPage.machinePickerSearchPlaceholder"),
      emptyText: t("workReport:detailPage.machinePickerEmpty"),
    }),
    [t]
  );

  const mainMachinePickerBaseOptions = useMemo<DetailPickerOption[]>(
    () =>
      filterMachineOptionsByGroup(mainMachineOptions, resolvedMachineGroupKey).map((opt) => ({
        value: opt.value,
        display: opt.display,
        group:
          resolvedMachineGroupKey !== ALL_MACHINE_GROUP_KEY
            ? selectedMachineGroupLabel || undefined
            : undefined,
        metaLines: buildMachineMetaLines(opt),
      })),
    [mainMachineOptions, resolvedMachineGroupKey, selectedMachineGroupLabel]
  );
  const filteredMainMachinePickerOptions = useMemo<DetailPickerOption[]>(
    () => filterPickerOptionsByKeyword(mainMachinePickerBaseOptions, deferredMainMachinePickerSearch),
    [deferredMainMachinePickerSearch, mainMachinePickerBaseOptions]
  );

  const currentMainMachineOption = useMemo<DetailPickerOption | null>(() => {
    const selected = mainMachineOptions.find((option) => option.value === mainMachineDraft);
    return selected
      ? {
          value: selected.value,
          display: selected.display,
          metaLines: buildMachineMetaLines(selected),
        }
      : null;
  }, [mainMachineDraft, mainMachineOptions]);

  const mainMachinePickerTopContent = useMemo<ReactNode>(
    () => (
      <OperatorGroupFilter
        className="detail-picker-group-filter"
        label={t("workReport:detailPage.machinePickerGroupLabel")}
        allLabel={t("common:options.all")}
        selectedGroupKey={resolvedMachineGroupKey}
        options={machineGroupOptions}
        onChange={handleMachineGroupPreferenceChange}
      />
    ),
    [handleMachineGroupPreferenceChange, machineGroupOptions, resolvedMachineGroupKey, t]
  );

  return {
    blankTokenLabel,
    operatorGroupOptions,
    selectedOperatorGroupKey: resolvedOperatorGroupKey,
    handleOperatorGroupPreferenceChange,
    machineGroupOptions,
    selectedMachineGroupKey: resolvedMachineGroupKey,
    handleMachineGroupPreferenceChange,
    linkedPickerCopy,
    linkedPickerSelectedValue,
    currentLinkedPickerOption,
    linkedPickerTopContent,
    filteredLinkedPickerOptions,
    mainMachinePickerCopy,
    filteredMainMachinePickerOptions,
    currentMainMachineOption,
    mainMachinePickerTopContent,
  };
}
