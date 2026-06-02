import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../api/workReport";
import { translateBooleanLikeDisplay } from "../i18n/valueMappers";
import { parseSemanticBoolean } from "../utils/semanticBoolean";

interface ContextField {
  key: string;
  label: string;
}

interface ContextGroup {
  titleKey: string;
  fields: ContextField[];
}

interface WorkOrderContextCardProps {
  record?: WorkReportRecord | null;
  uiLanguage?: "zh" | "en";
  compact?: boolean;
  loading?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  detailCollapsible?: boolean;
  detailDefaultCollapsed?: boolean;
}

const KPI_FIELDS: ContextField[] = [
  { key: "machineCode", label: "目前機台" },
  { key: "currentMaterial", label: "來料" },
  { key: "plannedEndDate", label: "指定結束日" },
  { key: "producedQtyStat", label: "已生產數量統計(pc)" },
  { key: "pendingQty", label: "待生產數量" },
  { key: "processName", label: "主製程簡稱" },
];

const DETAIL_GROUPS: ContextGroup[] = [
  {
    titleKey: "workOrderBasics",
    fields: [
      { key: "workOrderNo", label: "工令單號" },
      { key: "workOrderType", label: "工令單種類" },
      { key: "processName", label: "主製程簡稱" },
      { key: "defaultProcessCode", label: "子製程別代碼" },
      { key: "status", label: "工令狀態" },
      { key: "misCloseStatus", label: "結案狀態" },
    ],
  },
  {
    titleKey: "productionTargets",
    fields: [
      { key: "targetQtyPc", label: "目標數 pc" },
      { key: "pendingQty", label: "待生產數量" },
      { key: "producedQtyStat", label: "已生產數量統計(pc)" },
      { key: "estimatedHours", label: "預估所需工時" },
    ],
  },
  {
    titleKey: "materialsAndSpecs",
    fields: [
      { key: "currentMaterial", label: "目前使用來料" },
      { key: "primaryMaterial", label: "指定主要來料" },
      { key: "defaultMainMaterial", label: "[預設]主要製程來料" },
      { key: "size", label: "尺寸" },
    ],
  },
  {
    titleKey: "stationStatus",
    fields: [
      { key: "prevStationRunning", label: "上一站執行中" },
      { key: "prevStationStatus", label: "上一站狀態" },
      { key: "siteRunning", label: "本站執行中?" },
    ],
  },
  {
    titleKey: "previousStationStats",
    fields: [
      { key: "prevReportQtyPc", label: "[上一站]報工數pc" },
      { key: "prevReportQtyKg", label: "[上一站]報工重kg" },
      { key: "prevReportContainerQty", label: "[上一站]報工容器數" },
      { key: "prevCompletePc", label: "[上一站]完工數pc" },
      { key: "prevCompleteKg", label: "[上一站]完工重kg" },
      { key: "prevCompleteContainer", label: "[上一站]完工容器數" },
    ],
  },
  {
    titleKey: "scheduleDates",
    fields: [
      { key: "plannedEndDate", label: "指定結束日期" },
      { key: "prevPlanEndDate", label: "[上製程]指定結束日期" },
    ],
  },
];

const BOOLEAN_FIELDS = new Set(["prevStationRunning", "siteRunning"]);

function formatPlainValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  const text = String(value).trim();
  if (!text) {
    return "-";
  }

  return text;
}

function formatBooleanValue(
  value: unknown,
  translateBooleanLike: (value: unknown) => string
): string {
  const parsed = parseSemanticBoolean(value);
  if (parsed === true) {
    return translateBooleanLike(true);
  }
  if (parsed === false) {
    return translateBooleanLike(false);
  }
  return formatPlainValue(value);
}

function formatValue(
  key: string,
  value: unknown,
  translateBooleanLike: (value: unknown) => string
): string {
  if (BOOLEAN_FIELDS.has(key)) {
    return formatBooleanValue(value, translateBooleanLike);
  }
  return formatPlainValue(value);
}

export function WorkOrderContextCard({
  record,
  compact = false,
  loading = false,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
  detailCollapsible = false,
  detailDefaultCollapsed = false,
}: WorkOrderContextCardProps) {
  const { t: tr } = useTranslation(["workReport"]);
  const translateBooleanLike = (value: unknown) => translateBooleanLikeDisplay(value, tr);
  const fieldLabel = (key: string, fallback: string) =>
    tr(`workReport:contextCard.fieldLabels.${key}`, { defaultValue: fallback });
  const groupTitle = (titleKey: string) => tr(`workReport:contextCard.groupTitles.${titleKey}`);
  const rawSiteRunning = record?.siteRunning;
  const siteRunningText = formatValue("siteRunning", rawSiteRunning, translateBooleanLike);
  const siteRunning = parseSemanticBoolean(rawSiteRunning) === true;
  const shouldCollapse = collapsible && collapsed;
  const [detailCollapsed, setDetailCollapsed] = useState<boolean>(detailDefaultCollapsed);
  const detailShouldCollapse = detailCollapsible && detailCollapsed;

  const isClosed = record?.status === "已結案";

  return (
    <section
      className={`context-card${compact ? " context-card--compact" : ""}${
        shouldCollapse ? " context-card--collapsed" : ""
      }${isClosed ? " context-card--closed" : ""}`}
    >
      <header className="context-card-header">
        <h3>{tr("workReport:contextCard.title")}</h3>
        <div className="context-card-actions">
          {collapsible && (
            <button
              type="button"
              className="context-toggle-button"
              onClick={onToggleCollapse}
            >
              {shouldCollapse ? tr("workReport:contextCard.expandInfo") : tr("workReport:contextCard.collapseInfo")}
            </button>
          )}
          <span className={`context-badge${siteRunning ? " is-running" : ""}`}>
            {tr("workReport:contextCard.siteRunningPrefix")}
            {siteRunningText}
          </span>
          {record != null && (
            <span className={`context-badge${isClosed ? " is-closed" : " is-open"}`}>
              {isClosed && (
                <span className="context-badge-check" aria-hidden="true">
                  ✓
                </span>
              )}
              {isClosed
                ? tr("workReport:values.workOrderStatus.closed")
                : tr("workReport:values.workOrderStatus.open")}
            </span>
          )}
        </div>
      </header>

      {loading && <p className="context-loading">{tr("workReport:contextCard.loadingInfo")}</p>}
      {shouldCollapse && (
        <p className="context-collapsed-hint">
          {tr("workReport:contextCard.collapsedHint")}
        </p>
      )}

      {!shouldCollapse && (
        <>
          <div className="context-kpi-grid">
            {KPI_FIELDS.map((field) => {
              const rawValue = record?.[field.key];

              return (
                <article className="context-kpi-card" key={field.key}>
                  <span className="context-kpi-label">{fieldLabel(field.key, field.label)}</span>
                  <span className="context-kpi-value">{formatValue(field.key, rawValue, translateBooleanLike)}</span>
                </article>
              );
            })}
          </div>

          <div className={`context-detail${detailShouldCollapse ? " is-collapsed" : ""}`}>
            <div className="context-detail-header">
              <h4>{tr("workReport:contextCard.detailsTitle")}</h4>
              {detailCollapsible && (
                <button
                  type="button"
                  className="context-detail-toggle"
                  aria-expanded={!detailShouldCollapse}
                  aria-label={
                    detailShouldCollapse
                      ? tr("workReport:contextCard.detailsExpandAria")
                      : tr("workReport:contextCard.detailsCollapseAria")
                  }
                  onClick={() => setDetailCollapsed((prev) => !prev)}
                >
                  {detailShouldCollapse
                    ? tr("workReport:contextCard.detailsExpandLabel")
                    : tr("workReport:contextCard.detailsCollapseLabel")}
                </button>
              )}
            </div>

            {!detailShouldCollapse && (
              <div className="context-grid">
                {DETAIL_GROUPS.map((group) => (
                  <section className="context-group" key={group.titleKey}>
                    <h4>{groupTitle(group.titleKey)}</h4>
                    <div className="context-items">
                      {group.fields.map((field) => (
                        <div className="context-item" key={field.key}>
                          <span className="context-label">{fieldLabel(field.key, field.label)}</span>
                          <span className="context-value">
                            {formatValue(field.key, record?.[field.key], translateBooleanLike)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
