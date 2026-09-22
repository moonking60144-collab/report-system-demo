import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { FormOptionMap, WorkReportRecord } from "../../../api/workReport";
import type { WorkReportFormId } from "../../../features/work-report/types";
import {
  ALL_MACHINE_GROUP_KEY,
  buildMachineGroupOptions,
  filterMachineOptionsByGroup,
  readMachineGroupPreference,
  resolveMachineGroupPreference,
  writeMachineGroupPreference,
  type MachineGroupOption,
} from "../machineGroupPreferences";
import {
  ALL_OPERATOR_GROUP_KEY,
  filterOperatorOptionsByGroup,
  type OperatorGroupOption,
} from "../operatorGroupPreferences";
import {
  ALL_PROCESS_GROUP_KEY,
  buildProcessGroupOptions,
  filterProcessOptionsByGroup,
  readProcessGroupPreference,
  resolveProcessGroupPreference,
  writeProcessGroupPreference,
  type ProcessGroupOption,
} from "../processGroupPreferences";
import { filterActiveMachineOptionsWithCurrentValue, withCurrentValue } from "../optionUtils";
import {
  inferOperatorDefaultByMachine,
  inferOperatorDefaultSelection,
  inferReportTypeFromProcessCode,
} from "../formLogic";
import type { FormState } from "../types";
import type { ModalFieldKey } from "./types";

interface UseReportFormModalPickerControllerArgs {
  formId: WorkReportFormId;
  mode: "create" | "edit";
  entryContext?: WorkReportRecord | null;
  options: FormOptionMap;
  formState: FormState;
  setFormState: Dispatch<SetStateAction<FormState>>;
  operatorGroupOptions: OperatorGroupOption[];
  selectedOperatorGroupKey: string;
  onOperatorGroupChange: (groupKey: string) => void;
  focusNextEmptyModalField: (
    currentKey: ModalFieldKey,
    state: FormState,
    options?: { wrap?: boolean }
  ) => boolean;
}

export function useReportFormModalPickerController({
  formId,
  mode,
  entryContext,
  options,
  formState,
  setFormState,
  operatorGroupOptions,
  selectedOperatorGroupKey,
  onOperatorGroupChange,
  focusNextEmptyModalField,
}: UseReportFormModalPickerControllerArgs) {
  const [selectedMachineGroupKey, setSelectedMachineGroupKey] = useState<string>(ALL_MACHINE_GROUP_KEY);
  const [selectedProcessGroupKey, setSelectedProcessGroupKey] = useState<string>(ALL_PROCESS_GROUP_KEY);
  const [machinePickerOpen, setMachinePickerOpen] = useState(false);
  const [machinePickerSearch, setMachinePickerSearch] = useState("");
  const [operatorPickerOpen, setOperatorPickerOpen] = useState(false);
  const [operatorPickerSearch, setOperatorPickerSearch] = useState("");
  const [processPickerOpen, setProcessPickerOpen] = useState(false);
  const [processPickerSearch, setProcessPickerSearch] = useState("");

  const machineOptions = useMemo(
    () => filterActiveMachineOptionsWithCurrentValue(options.machineId, formState.machineId),
    [options.machineId, formState.machineId]
  );
  const machineGroupOptions = useMemo<MachineGroupOption[]>(
    () => buildMachineGroupOptions(machineOptions),
    [machineOptions]
  );
  const effectiveSelectedMachineGroupKey = useMemo(
    () =>
      resolveMachineGroupPreference(
        machineGroupOptions,
        readMachineGroupPreference(formId),
        machineOptions.find((option) => option.value === formState.machineId)?.machineDefault?.processCategoryCode ??
          machineOptions.find(
            (option) =>
              option.machineDefault?.machineCode?.trim() ===
              String(entryContext?.machineCode ?? "").trim()
          )?.machineDefault?.processCategoryCode
      ),
    [entryContext?.machineCode, formId, formState.machineId, machineGroupOptions, machineOptions]
  );
  const selectedMachineGroupLabel = useMemo(
    () =>
      (machineGroupOptions.find(
        (option) => option.key === (selectedMachineGroupKey || effectiveSelectedMachineGroupKey)
      )?.label ?? "").trim(),
    [effectiveSelectedMachineGroupKey, machineGroupOptions, selectedMachineGroupKey]
  );
  const filteredMachineOptions = useMemo(
    () =>
      filterMachineOptionsByGroup(
        machineOptions,
        selectedMachineGroupKey || effectiveSelectedMachineGroupKey
      ).map((opt) => ({
        ...opt,
        group:
          (selectedMachineGroupKey || effectiveSelectedMachineGroupKey) !== ALL_MACHINE_GROUP_KEY
            ? selectedMachineGroupLabel || undefined
            : undefined,
        metaLines: [
          [opt.machineDefault?.processCategoryCode, opt.machineDefault?.processCategoryName]
            .filter(Boolean)
            .join(" "),
          opt.machineDefault?.mainOperatorName ? `主要操作者: ${opt.machineDefault.mainOperatorName}` : "",
          opt.machineDefault?.processCode ? `子製程: ${opt.machineDefault.processCode}` : "",
          opt.machineDefault?.machineSpec ? `規格: ${opt.machineDefault.machineSpec}` : "",
          opt.machineDefault?.machineSpeed ? `分速: ${opt.machineDefault.machineSpeed}` : "",
        ].filter(Boolean),
      })),
    [effectiveSelectedMachineGroupKey, machineOptions, selectedMachineGroupKey, selectedMachineGroupLabel]
  );

  const operatorOptions = useMemo(
    () => withCurrentValue(options.operatorId, formState.operatorId),
    [options.operatorId, formState.operatorId]
  );
  const selectedOperatorGroupLabel = useMemo(
    () => (operatorGroupOptions.find((option) => option.key === selectedOperatorGroupKey)?.label ?? "").trim(),
    [operatorGroupOptions, selectedOperatorGroupKey]
  );
  const filteredOperatorOptions = useMemo(
    () =>
      filterOperatorOptionsByGroup(operatorOptions, selectedOperatorGroupKey).map((opt) => ({
        ...opt,
        group:
          selectedOperatorGroupKey !== ALL_OPERATOR_GROUP_KEY
            ? selectedOperatorGroupLabel || undefined
            : undefined,
      })),
    [operatorOptions, selectedOperatorGroupKey, selectedOperatorGroupLabel]
  );

  const processOptions = useMemo(
    () =>
      withCurrentValue(options.processCode, formState.processCode).map((opt) => ({
        ...opt,
        group: opt.processGroupLabel?.trim() || opt.processGroupKey?.trim() || "其他",
      })),
    [options.processCode, formState.processCode]
  );
  const processGroupOptions = useMemo<ProcessGroupOption[]>(
    () => buildProcessGroupOptions(processOptions),
    [processOptions]
  );
  const effectiveSelectedProcessGroupKey = useMemo(
    () => resolveProcessGroupPreference(processGroupOptions, readProcessGroupPreference(formId)),
    [formId, processGroupOptions]
  );
  const filteredProcessOptions = useMemo(
    () =>
      filterProcessOptionsByGroup(
        processOptions,
        selectedProcessGroupKey || effectiveSelectedProcessGroupKey
      ),
    [effectiveSelectedProcessGroupKey, processOptions, selectedProcessGroupKey]
  );

  const selectedOperatorOption = useMemo(
    () => operatorOptions.find((item) => item.value === formState.operatorId) ?? null,
    [formState.operatorId, operatorOptions]
  );
  const selectedMachineOption = useMemo(
    () => machineOptions.find((item) => item.value === formState.machineId) ?? null,
    [formState.machineId, machineOptions]
  );
  const selectedProcessOption = useMemo(
    () => processOptions.find((item) => item.value === formState.processCode) ?? null,
    [formState.processCode, processOptions]
  );

  const currentMachinePickerOption = useMemo(
    () =>
      selectedMachineOption
        ? {
            value: selectedMachineOption.value,
            display: selectedMachineOption.display,
            metaLines: [
              [selectedMachineOption.machineDefault?.processCategoryCode, selectedMachineOption.machineDefault?.processCategoryName]
                .filter(Boolean)
                .join(" "),
              selectedMachineOption.machineDefault?.mainOperatorName
                ? `主要操作者: ${selectedMachineOption.machineDefault.mainOperatorName}`
                : "",
              selectedMachineOption.machineDefault?.processCode
                ? `子製程: ${selectedMachineOption.machineDefault.processCode}`
                : "",
              selectedMachineOption.machineDefault?.machineSpec
                ? `規格: ${selectedMachineOption.machineDefault.machineSpec}`
                : "",
              selectedMachineOption.machineDefault?.machineSpeed
                ? `分速: ${selectedMachineOption.machineDefault.machineSpeed}`
                : "",
            ].filter(Boolean),
          }
        : null,
    [selectedMachineOption]
  );
  const currentOperatorPickerOption = useMemo(
    () =>
      selectedOperatorOption
        ? {
            value: selectedOperatorOption.value,
            display: selectedOperatorOption.display,
          }
        : null,
    [selectedOperatorOption]
  );
  const currentProcessPickerOption = useMemo(
    () =>
      selectedProcessOption
        ? {
            value: selectedProcessOption.value,
            display: selectedProcessOption.display,
            group:
              selectedProcessOption.processGroupLabel?.trim() ||
              selectedProcessOption.processGroupKey?.trim() ||
              "其他",
          }
        : null,
    [selectedProcessOption]
  );

  const filteredOperatorPickerOptions = useMemo(() => {
    const keyword = operatorPickerSearch.trim().toLowerCase();
    if (!keyword) {
      return filteredOperatorOptions;
    }
    return filteredOperatorOptions.filter((option) => {
      const value = option.value.toLowerCase();
      const display = option.display.toLowerCase();
      const label = option.label.toLowerCase();
      return value.includes(keyword) || display.includes(keyword) || label.includes(keyword);
    });
  }, [filteredOperatorOptions, operatorPickerSearch]);

  const filteredProcessPickerOptions = useMemo(() => {
    const keyword = processPickerSearch.trim().toLowerCase();
    if (!keyword) {
      return filteredProcessOptions;
    }
    return filteredProcessOptions.filter((option) => {
      const value = option.value.toLowerCase();
      const display = option.display.toLowerCase();
      const label = option.label.toLowerCase();
      return value.includes(keyword) || display.includes(keyword) || label.includes(keyword);
    });
  }, [filteredProcessOptions, processPickerSearch]);

  const filteredMachinePickerOptions = useMemo(() => {
    const keyword = machinePickerSearch.trim().toLowerCase();
    if (!keyword) {
      return filteredMachineOptions;
    }
    return filteredMachineOptions.filter((option) => {
      const value = option.value.toLowerCase();
      const display = option.display.toLowerCase();
      const label = option.label.toLowerCase();
      return value.includes(keyword) || display.includes(keyword) || label.includes(keyword);
    });
  }, [filteredMachineOptions, machinePickerSearch]);

  const handleOperatorChange = useCallback(
    (value: string) => {
      let nextStateSnapshot: FormState | null = null;
      const selected = operatorOptions.find((item) => item.value === value);
      setFormState((prev) => {
        const defaults = mode === "create" ? inferOperatorDefaultSelection(value, entryContext, machineOptions) : {};
        const shouldFillProcess = mode === "create" && !prev.processCode.trim();
        const shouldFillMachine = mode === "create" && !prev.machineId.trim();
        const shouldFillReportType = mode === "create" && !prev.reportType.trim();

        const nextState = {
          ...prev,
          operatorId: value,
          operatorName: selected?.display ?? prev.operatorName,
          processCode:
            shouldFillProcess && defaults.processCode ? defaults.processCode : prev.processCode,
          machineId:
            shouldFillMachine && defaults.machineId ? defaults.machineId : prev.machineId,
          reportType:
            shouldFillReportType && (defaults.reportType || defaults.processCode)
              ? defaults.reportType ?? inferReportTypeFromProcessCode(defaults.processCode ?? "")
              : prev.reportType,
        };
        nextStateSnapshot = nextState;
        return nextState;
      });
      setOperatorPickerOpen(false);
      setOperatorPickerSearch("");
      if (nextStateSnapshot) {
        focusNextEmptyModalField("operatorId", nextStateSnapshot);
      }
    },
    [entryContext, focusNextEmptyModalField, machineOptions, mode, operatorOptions, setFormState]
  );

  const handleMachineChange = useCallback(
    (value: string) => {
      let nextStateSnapshot: FormState | null = null;
      setFormState((prev) => {
        const nextState: FormState = { ...prev, machineId: value };

        if (mode !== "create") {
          nextStateSnapshot = nextState;
          return nextState;
        }

        const machineDefaults = inferOperatorDefaultByMachine(value, machineOptions);
        if (
          !machineDefaults.operatorId &&
          !machineDefaults.operatorName &&
          !machineDefaults.processCode &&
          !machineDefaults.reportType
        ) {
          nextStateSnapshot = nextState;
          return nextState;
        }

        const selectedOperator = operatorOptions.find((item) => item.value === machineDefaults.operatorId);
        const resolvedState = {
          ...nextState,
          operatorId:
            !prev.operatorId.trim() && machineDefaults.operatorId
              ? machineDefaults.operatorId
              : nextState.operatorId,
          operatorName:
            !prev.operatorName.trim()
              ? selectedOperator?.display ?? machineDefaults.operatorName ?? nextState.operatorName
              : nextState.operatorName,
          processCode:
            !prev.processCode.trim() && machineDefaults.processCode
              ? machineDefaults.processCode
              : nextState.processCode,
          reportType:
            !prev.reportType.trim() && (machineDefaults.reportType || machineDefaults.processCode)
              ? machineDefaults.reportType ?? inferReportTypeFromProcessCode(machineDefaults.processCode ?? "")
              : nextState.reportType,
        };
        nextStateSnapshot = resolvedState;
        return resolvedState;
      });
      setMachinePickerOpen(false);
      setMachinePickerSearch("");
      if (nextStateSnapshot) {
        focusNextEmptyModalField("machineId", nextStateSnapshot);
      }
    },
    [focusNextEmptyModalField, machineOptions, mode, operatorOptions, setFormState]
  );

  const handleMachineGroupPreferenceChange = useCallback(
    (groupKey: string) => {
      setSelectedMachineGroupKey(groupKey);
      writeMachineGroupPreference(formId, groupKey);
    },
    [formId]
  );

  const handleProcessGroupPreferenceChange = useCallback(
    (groupKey: string) => {
      setSelectedProcessGroupKey(groupKey);
      writeProcessGroupPreference(formId, groupKey);
    },
    [formId]
  );

  const handleProcessChange = useCallback(
    (value: string) => {
      const nextState: FormState = {
        ...formState,
        processCode: value,
        reportType: formState.reportType.trim()
          ? formState.reportType
          : inferReportTypeFromProcessCode(value),
      };
      setFormState(nextState);
      setProcessPickerOpen(false);
      setProcessPickerSearch("");
      focusNextEmptyModalField("processCode", nextState);
    },
    [focusNextEmptyModalField, formState, setFormState]
  );

  return {
    machinePickerOpen,
    setMachinePickerOpen,
    machinePickerSearch,
    setMachinePickerSearch,
    operatorPickerOpen,
    setOperatorPickerOpen,
    operatorPickerSearch,
    setOperatorPickerSearch,
    processPickerOpen,
    setProcessPickerOpen,
    processPickerSearch,
    setProcessPickerSearch,
    selectedMachineGroupKey,
    selectedProcessGroupKey,
    machineGroupOptions,
    processGroupOptions,
    effectiveSelectedMachineGroupKey,
    effectiveSelectedProcessGroupKey,
    filteredMachinePickerOptions,
    filteredOperatorPickerOptions,
    filteredProcessPickerOptions,
    currentMachinePickerOption,
    currentOperatorPickerOption,
    currentProcessPickerOption,
    selectedMachineOption,
    selectedOperatorOption,
    selectedProcessOption,
    handleOperatorChange,
    handleMachineChange,
    handleMachineGroupPreferenceChange,
    handleProcessGroupPreferenceChange,
    handleProcessChange,
    onOperatorGroupChange,
  };
}
