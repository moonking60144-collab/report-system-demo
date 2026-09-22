import { useState } from "react";
import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import { DEFAULT_GLOBAL_FILTERS } from "../constants";
import type {
  ColumnFilterState,
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportFilterGroup,
} from "../types";
import { EMPTY_WORK_REPORT_FILTER_GROUP, isSameWorkReportFilterGroup } from "../utils";
import { WorkReportFilterPanel, type WorkReportFilterPanelProps } from "./WorkReportFilterPanel";

type Props = Omit<WorkReportFilterPanelProps,
  "filterGroup" | "columnSortRules" |
  "onFilterGroupChange" | "onApplyFilters" | "onClearFilters" | "onApplySavedFilter" |
  "onRemoveActiveFilterChip" | "onClearMachineColumnFilter" | "hasPendingChanges"
> & {
  appliedState: {
    globalFilters: GlobalFilters;
    filterGroup: WorkReportFilterGroup;
    sortRules: ColumnSortRule[];
    columnFilterState: ColumnFilterState;
    activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
    usesCustomFilterGroup: boolean;
  };
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
  onApply: (draft: {
    globalFilters: GlobalFilters;
    filterGroup: WorkReportFilterGroup;
    sortRules: ColumnSortRule[];
    resetColumns: boolean;
    clearMachineColumn: boolean;
  }) => boolean;
};

type AppliedState = Props["appliedState"];

interface DrawerDraftState {
  source: AppliedState;
  group: WorkReportFilterGroup;
  globals: GlobalFilters;
  sortRules: ColumnSortRule[];
  removedChips: string[];
  resetColumns: boolean;
  clearMachineColumn: boolean;
  hideChips: boolean;
  preserveAppliedGlobalFilters: boolean;
}

function createGlobalDraft(globalFilters: GlobalFilters): GlobalFilters {
  return {
    ...DEFAULT_GLOBAL_FILTERS,
    globalKeyword: globalFilters.globalKeyword,
    ragicUnfinishedStatus: globalFilters.ragicUnfinishedStatus,
  };
}

function createDrawerDraft(source: AppliedState): DrawerDraftState {
  return {
    source,
    group: source.filterGroup,
    globals: createGlobalDraft(source.globalFilters),
    sortRules: source.sortRules,
    removedChips: [],
    resetColumns: false,
    clearMachineColumn: false,
    hideChips: false,
    preserveAppliedGlobalFilters: !source.usesCustomFilterGroup,
  };
}

function isDrawerDraftPending(draft: DrawerDraftState, appliedState: AppliedState): boolean {
  return draft.resetColumns || draft.clearMachineColumn || draft.removedChips.length > 0 ||
    draft.preserveAppliedGlobalFilters !== !appliedState.usesCustomFilterGroup ||
    !isSameWorkReportFilterGroup(draft.group, appliedState.filterGroup) ||
    JSON.stringify(draft.sortRules) !== JSON.stringify(appliedState.sortRules);
}

export function WorkReportFilterDrawer({
  appliedState,
  onClose,
  onPendingChange,
  onApply,
  ...props
}: Props) {
  const { t } = useTranslation(["workReport", "common"]);
  const [storedDraft, setStoredDraft] = useState(() => createDrawerDraft(appliedState));
  const draft = storedDraft.source === appliedState
    ? storedDraft
    : createDrawerDraft(appliedState);
  const updateDraft = (update: (current: DrawerDraftState) => DrawerDraftState) => {
    const nextDraft = update(draft);
    setStoredDraft(nextDraft);
    onPendingChange(isDrawerDraftPending(nextDraft, appliedState));
  };

  const pending = isDrawerDraftPending(draft, appliedState);

  const resetDraft = (current: DrawerDraftState): DrawerDraftState => ({
    ...current,
    group: EMPTY_WORK_REPORT_FILTER_GROUP,
    globals: DEFAULT_GLOBAL_FILTERS,
    removedChips: [],
    resetColumns: true,
    clearMachineColumn: false,
    hideChips: true,
    preserveAppliedGlobalFilters: false,
  });

  return (
    <Drawer open mask={false} onClose={onClose} title={t("workReport:filters.filterButton")}
      size="min(440px, 100vw)" rootClassName="work-report-filter-drawer"
      styles={{ body: { padding: 0, overflow: "hidden" } }}>
      <WorkReportFilterPanel {...props}
        filterGroup={draft.group}
        onFilterGroupChange={(group) => updateDraft(current => ({
          ...current,
          group,
          preserveAppliedGlobalFilters:
            !appliedState.usesCustomFilterGroup &&
            isSameWorkReportFilterGroup(group, appliedState.filterGroup),
        }))}
        columnSortRules={draft.sortRules} hasPendingChanges={pending}
        activeFilterChips={draft.hideChips ? [] : props.activeFilterChips.filter(chip => !draft.removedChips.includes(chip.removeActionKey ?? ""))}
        columnFilterCount={draft.resetColumns ? 0 : props.columnFilterCount - (draft.clearMachineColumn && props.machineColumnFilterTokens.length > 0 ? 1 : 0)}
        machineColumnFilterTokens={draft.resetColumns || draft.clearMachineColumn ? [] : props.machineColumnFilterTokens}
        onClearMachineColumnFilter={() => updateDraft(current => ({ ...current, clearMachineColumn: true }))}
        onRemoveActiveFilterChip={(key) => {
          updateDraft(current => {
            if (key.startsWith("active-")) return resetDraft(current);
            const removedChips = [...current.removedChips, key];
            return {
              ...current,
              removedChips,
              globals: {
                ...current.globals,
                ...(key === "filter-global-keyword" ? { globalKeyword: "" } : {}),
                ...(key === "filter-ragic-unfinished-status"
                  ? { ragicUnfinishedStatus: DEFAULT_GLOBAL_FILTERS.ragicUnfinishedStatus }
                  : {}),
              },
              sortRules: key.startsWith("sort:")
                ? appliedState.sortRules.filter((_, index) => !removedChips.includes(`sort:${index}`))
                : current.sortRules,
            };
          });
        }}
        onClearFilters={() => updateDraft(resetDraft)}
        onApplySavedFilter={(nextGroup, nextSort) => {
          updateDraft(current => ({
            ...resetDraft(current),
            group: nextGroup,
            sortRules: nextSort,
          }));
        }}
        onApplyFilters={() => {
          const globalFilters = draft.preserveAppliedGlobalFilters
            ? {
                ...appliedState.globalFilters,
                globalKeyword: draft.globals.globalKeyword,
                ragicUnfinishedStatus: draft.globals.ragicUnfinishedStatus,
              }
            : draft.globals;
          if (onApply({
            globalFilters,
            filterGroup: draft.preserveAppliedGlobalFilters
              ? EMPTY_WORK_REPORT_FILTER_GROUP
              : draft.group,
            sortRules: draft.sortRules,
            resetColumns: draft.resetColumns,
            clearMachineColumn: draft.clearMachineColumn,
          })) onClose();
        }}
      />
    </Drawer>
  );
}
