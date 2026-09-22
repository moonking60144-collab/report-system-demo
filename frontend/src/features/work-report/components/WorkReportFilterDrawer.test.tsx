import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_FILTERS } from "../constants";
import { shouldCloseFilterDrawerFromBackgroundClick } from "../filterDrawerInteraction";
import { EMPTY_WORK_REPORT_FILTER_GROUP } from "../utils";
import { WorkReportFilterDrawer } from "./WorkReportFilterDrawer";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  index: 0,
}));
vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => {
      hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
    }];
  },
}));
vi.mock("react-i18next", async (load) => ({ ...await load<typeof import("react-i18next")>(), useTranslation: () => ({ t: (key: string) => key }) }));

const group = { joinMode: "all" as const, conditions: [
  { id: "status", field: "status" as const, operator: "isAnyOf" as const, values: ["未結案"] },
] };
const apply = vi.fn<(draft: unknown) => boolean>(() => true);
const close = vi.fn();
const pendingChange = vi.fn();
const appliedState: Parameters<typeof WorkReportFilterDrawer>[0]["appliedState"] = {
  filterGroup: group,
  globalFilters: { ...DEFAULT_GLOBAL_FILTERS, status: "未結案" },
  sortRules: [],
  columnFilterState: { machineCode: { selectedTokens: ["MA01"] } },
  activePlaceholderViewId: null,
  usesCustomFilterGroup: false,
};
function renderDrawer(nextAppliedState = appliedState) {
  hooks.index = 0;
  return WorkReportFilterDrawer({
    currentFormId: "901", activeLandingPageKey: "line-a-901",
    appliedState: nextAppliedState,
    machineFilterOptions: [], statusFilterOptions: [], siteRunningFilterOptions: [],
    filterControlDisabled: false, activeFilterChips: [],
    columnFilterCount: 1, machineColumnFilterTokens: ["MA01"],
    onApply: apply, onClose: close, onPendingChange: pendingChange,
  });
}
function render(nextAppliedState = appliedState) {
  return renderDrawer(nextAppliedState).props.children.props;
}
beforeEach(() => {
  hooks.values = [];
  hooks.index = 0;
  vi.clearAllMocks();
});

describe("filter drawer draft boundary", () => {
  it("keeps the work report underneath interactive without a modal mask", () => {
    expect(renderDrawer().props.mask).toBe(false);
  });

  it("clears locally and only commits on Apply", () => {
    render().onClearFilters();
    expect(apply).not.toHaveBeenCalled();
    expect(pendingChange).toHaveBeenLastCalledWith(true);
    const panel = render();
    expect(panel.filterGroup.conditions).toEqual([]);
    panel.onApplyFilters();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ resetColumns: true, filterGroup: EMPTY_WORK_REPORT_FILTER_GROUP }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("removing the final condition cannot restore the original global status", () => {
    render().onFilterGroupChange(EMPTY_WORK_REPORT_FILTER_GROUP);
    render().onApplyFilters();
    expect(apply.mock.calls[0][0]).toEqual(expect.objectContaining({
      globalFilters: DEFAULT_GLOBAL_FILTERS, filterGroup: EMPTY_WORK_REPORT_FILTER_GROUP,
    }));
  });
  it("loading a saved filter and removing a column facet wait for Apply", () => {
    render().onApplySavedFilter(group, []);
    render().onClearMachineColumnFilter();
    expect(apply).not.toHaveBeenCalled();
    expect(render().machineColumnFilterTokens).toEqual([]);
    render().onApplyFilters();
    expect(apply).toHaveBeenCalledOnce();
  });
  it("keeps the drawer open if validation rejects Apply", () => {
    apply.mockReturnValueOnce(false);
    render().onApplyFilters();
    expect(close).not.toHaveBeenCalled();
  });

  it("reloads its draft when an underlying control applies a new filter state", () => {
    render().onClearFilters();
    expect(render().filterGroup.conditions).toEqual([]);

    const nextGroup = { ...group, conditions: [{ ...group.conditions[0], id: "latest-status" }] };
    const nextAppliedState = {
      ...appliedState,
      filterGroup: nextGroup,
      globalFilters: { ...DEFAULT_GLOBAL_FILTERS, status: "已結案" },
      columnFilterState: {},
    };
    render(nextAppliedState);
    const panel = render(nextAppliedState);

    expect(panel.filterGroup).toBe(nextGroup);
    panel.onApplyFilters();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      globalFilters: expect.objectContaining({ status: "已結案" }),
      filterGroup: EMPTY_WORK_REPORT_FILTER_GROUP,
      resetColumns: false,
    }));
  });
});

describe("filter drawer background dismissal", () => {
  it("dismisses on blank background but not controls, rows, or scroll surfaces", () => {
    const blank = { closest: vi.fn(() => null) };
    const interactive = { closest: vi.fn(() => ({} as Element)) };

    expect(shouldCloseFilterDrawerFromBackgroundClick(blank as unknown as EventTarget)).toBe(true);
    expect(shouldCloseFilterDrawerFromBackgroundClick(interactive as unknown as EventTarget)).toBe(false);
    expect(shouldCloseFilterDrawerFromBackgroundClick(null)).toBe(false);
    expect(interactive.closest).toHaveBeenCalledWith(expect.stringContaining(".work-report-filter-drawer"));
    expect(interactive.closest).toHaveBeenCalledWith(expect.stringContaining(".fixed-h-scrollbar-shell"));
    expect(interactive.closest).toHaveBeenCalledWith(expect.stringContaining(".ant-modal-root"));
    expect(interactive.closest).toHaveBeenCalledWith(expect.stringContaining(".ant-select-dropdown"));
  });
});
