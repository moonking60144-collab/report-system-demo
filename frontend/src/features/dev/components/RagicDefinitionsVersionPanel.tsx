import { useState } from "react";
import {
  CloudUploadOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type {
  RagicDefinitionForm,
  RagicDefinitionFormDetail,
  RagicDefinitionsReExportResult,
  RagicDefinitionsState,
  RagicDefinitionsVersionControlCommitResult,
  RagicDefinitionsVersionControlPushResult,
  RagicDefinitionsVersionControlStatus,
  RagicFormulaPatchRollbackLatestResult,
} from "../../../api/devRagicDefinitions";
import type { RagicDefinitionsRealtimeStatus } from "../hooks/useRagicDefinitionsRealtime";
import type {
  DevDefinitionsPresenceClient,
  DevDefinitionsPresenceSummary,
} from "../hooks/useDevDefinitionsPresence";
import {
  canPushBaselineWithAutoSync,
  formatRemoteDelta,
  isRemoteBehindBlocker,
  shortCommit,
} from "./ragicDefinitionsExplorerUtils";

export type VersionActionResult =
  | { type: "refresh"; result: RagicDefinitionsReExportResult }
  | { type: "rollback"; result: RagicFormulaPatchRollbackLatestResult }
  | { type: "commit"; result: RagicDefinitionsVersionControlCommitResult }
  | { type: "push"; result: RagicDefinitionsVersionControlPushResult };

function formatPresenceOperation(client: DevDefinitionsPresenceClient): string {
  if (client.operation === "refresh") return "重新匯入中";
  if (client.operation === "rollback") return "回復中";
  if (client.operation === "apply") return "套用中";
  if (client.operation === "commit") return "提交中";
  if (client.operation === "push") return "推送中";
  return "查看中";
}

export function DevCommandBar({
  state,
  detail,
  selectedForm,
  loading,
  status,
  versionLoading,
  realtime,
  presence,
  onRefresh,
  onRollback,
  onCommit,
  onPush,
  rollbackAvailable,
  commitScopeFormPaths,
}: {
  state: RagicDefinitionsState | null;
  detail: RagicDefinitionFormDetail | null;
  selectedForm: RagicDefinitionForm | null;
  loading: boolean;
  status: RagicDefinitionsVersionControlStatus | null;
  versionLoading: "refresh" | "rollback" | "commit" | "push" | null;
  realtime: {
    connected: boolean;
    disconnectedSince: number | null;
    status: RagicDefinitionsRealtimeStatus | null;
    message: string | null;
    reloading: boolean;
  };
  presence?: DevDefinitionsPresenceSummary;
  onRefresh: () => void;
  onRollback: () => void;
  onCommit: () => void;
  onPush: () => void;
  rollbackAvailable: boolean;
  commitScopeFormPaths: string[];
}) {
  const counts = state?.manifest?.counts;
  const form = detail?.form ?? selectedForm;
  const hasActionableGitDiff = Boolean(
    status &&
      (status.definitionsEntries.length > 0 ||
        status.outsideEntries.some((entry) => entry.status !== "??") ||
        status.blockers.length > 0 ||
        status.error)
  );
  const realtimeSyncing = realtime.status === "syncing" || realtime.reloading;
  const realtimeErrored = realtime.status === "error";
  const realtimeDisabled = realtime.status === "disabled";
  const realtimeDisconnected = !realtime.connected && realtime.disconnectedSince !== null;
  const realtimeChipText = realtimeSyncing
    ? "自動匯入中"
    : realtimeErrored
      ? "同步異常"
      : realtimeDisabled
        ? "未啟用監看"
        : realtimeDisconnected
          ? "即時離線"
          : realtime.connected && (realtime.status === "watching" || realtime.status === "synced")
          ? "即時同步"
          : "即時連線中";
  const realtimeChipClass =
    realtimeSyncing || realtimeErrored || realtimeDisabled || realtimeDisconnected
      ? "is-dirty"
      : realtime.connected && (realtime.status === "watching" || realtime.status === "synced")
        ? "is-clean"
        : "";
  const presenceOnlineCount = presence?.onlineCount ?? 0;
  const presenceBusyCount = presence?.busyCount ?? 0;
  const presenceBlocked = Boolean(presence?.blocked);
  const presenceMaintenanceMessage = presence?.maintenanceMessage?.trim() ?? "";
  const presenceChipClass = presenceBusyCount > 0 ? "is-dirty" : presenceOnlineCount > 1 ? "is-clean" : "";
  const presenceTitle =
    presence?.clients.length
      ? presence.clients
          .map((client) => {
            const formPath = client.formPath ? ` · ${client.formPath}` : "";
            const realtimeState = client.realtimeConnected ? "" : " · 即時離線";
            return `${client.label}: ${formatPresenceOperation(client)}${formPath}${realtimeState}`;
          })
          .join("\n")
      : presence?.loading
        ? "讀取 Dev 在線狀態中"
        : presence?.error
          ? presence.error
          : "目前沒有其他 Dev definitions tab";
  const pushAvailable = Boolean(status?.canPush || canPushBaselineWithAutoSync(status));
  const pushWillAutoSync = Boolean(
    status?.canAutoSyncPush || (!status?.canPush && canPushBaselineWithAutoSync(status))
  );
  return (
    <section className="ragic-defs__command">
      <div className="ragic-defs__command-title">
        <strong>Definitions baseline</strong>
        <code>{form?.formPath ?? "未選擇表單"}</code>
      </div>
      <div className="ragic-defs__command-current">
        <span>{form?.formName || "(未命名)"}</span>
        <small>
          {detail
            ? `${detail.fields.length.toLocaleString()} 欄 · ${detail.formulas.length.toLocaleString()} 公式 · ${detail.workflows.length.toLocaleString()} workflow`
            : "表單 definition 載入中"}
        </small>
      </div>
      <div className="ragic-defs__command-metrics">
        <div className="ragic-defs__command-chips" aria-label="definitions 統計">
          <span>{loading ? "—" : counts?.forms.toLocaleString() ?? "0"} 表單</span>
          <span>{loading ? "—" : counts?.fields.toLocaleString() ?? "0"} 欄位</span>
          <span>{loading ? "—" : counts?.formulas.toLocaleString() ?? "0"} 公式</span>
          <span>{loading ? "—" : counts?.workflows.toLocaleString() ?? "0"} workflow</span>
        </div>
        <div className="ragic-defs__command-status" aria-label="definitions 狀態">
          <span className={hasActionableGitDiff ? "is-dirty" : "is-clean"}>
            {hasActionableGitDiff ? "Git 有差異" : "Git 無問題"}
          </span>
          <span className={realtimeChipClass} title={realtime.message ?? undefined}>
            {realtimeChipText}
          </span>
          <span
            className={`ragic-defs__presence-chip${presenceChipClass ? ` ${presenceChipClass}` : ""}`}
            title={presenceTitle}
          >
            {presence?.loading && presenceOnlineCount === 0
              ? "Dev 在線讀取中"
              : presenceOnlineCount > 0
                ? `Dev 在線 ${presenceOnlineCount}${presenceBusyCount > 0 ? ` · 操作中 ${presenceBusyCount}` : ""}`
                : "Dev 在線 0"}
          </span>
          {presenceMaintenanceMessage ? (
            <span className="is-dirty" title={presenceMaintenanceMessage}>
              維護訊息
            </span>
          ) : null}
          {presenceBlocked ? (
            <span className="is-dirty" title={presence?.blockedReason ?? "blocked"}>
              已封鎖
            </span>
          ) : null}
        </div>
      </div>
      <div className="ragic-defs__command-actions">
        <button
          type="button"
          className={`dev-mode-btn${
            versionLoading === "refresh" ? " ragic-defs__refresh-btn--active" : ""
          }`}
          disabled={presenceBlocked || versionLoading !== null}
          onClick={onRefresh}
        >
          <ReloadOutlined />
          {versionLoading === "refresh" ? "同步中…" : "重新匯入"}
        </button>
        <button
          type="button"
          className="dev-mode-btn dev-mode-btn--danger"
          disabled={presenceBlocked || versionLoading !== null || !rollbackAvailable}
          onClick={onRollback}
          title="用最近一次公式套用前的 .nui 備份回復，重新匯入 definitions，不會動 Git commit"
        >
          <RollbackOutlined />
          {versionLoading === "rollback" ? "回復中…" : "回復套用前"}
        </button>
        <button
          type="button"
          className={`dev-mode-btn${status?.canCommit ? " dev-mode-btn--primary" : ""}`}
          disabled={presenceBlocked || versionLoading !== null || !status?.canCommit}
          onClick={onCommit}
          title={
            commitScopeFormPaths.length > 0
              ? `只提交本次套用表單：${commitScopeFormPaths.join(" / ")}`
              : undefined
          }
        >
          <SaveOutlined />
          {versionLoading === "commit"
            ? "提交中…"
            : commitScopeFormPaths.length > 0
              ? `提交 baseline (${commitScopeFormPaths.length})`
              : "提交 baseline"}
        </button>
        <button
          type="button"
          className={`dev-mode-btn${
            !status?.canCommit && pushAvailable && (status?.ahead ?? 0) > 0
              ? " dev-mode-btn--primary"
              : ""
          }`}
          disabled={presenceBlocked || versionLoading !== null || !pushAvailable}
          onClick={onPush}
          title={pushWillAutoSync ? "推送前會先同步 origin/main（rebase）" : undefined}
        >
          <CloudUploadOutlined />
          {versionLoading === "push"
            ? "推送中…"
            : pushWillAutoSync
              ? `同步後推送 main (ahead ${status?.ahead ?? 0})`
              : (status?.ahead ?? 0) > 0
              ? `推送 main (ahead ${status?.ahead})`
              : "推送 main"}
        </button>
      </div>
    </section>
  );
}

export function BaselineStatusBar({
  status,
  message,
  loading,
  error,
  actionResult,
  commitScopeFormPaths,
  onMessageChange,
}: {
  status: RagicDefinitionsVersionControlStatus | null;
  message: string;
  commitScopeFormPaths: string[];
  loading: "refresh" | "rollback" | "commit" | "push" | null;
  error: string | null;
  actionResult: VersionActionResult | null;
  onMessageChange: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const definitionsEntries = status?.definitionsEntries ?? [];
  const outsideEntries = status?.outsideEntries ?? [];
  const outsideTrackedEntries = outsideEntries.filter((entry) => entry.status !== "??");
  const outsideUntrackedEntries = outsideEntries.filter((entry) => entry.status === "??");
  const autoSyncPushAvailable = Boolean(
    status?.canAutoSyncPush || (!status?.canPush && canPushBaselineWithAutoSync(status))
  );
  const rawBlockers = status?.blockers ?? [];
  const blockers = autoSyncPushAvailable
    ? rawBlockers.filter((item) => !isRemoteBehindBlocker(item))
    : rawBlockers;
  const warnings = status?.warnings ?? [];
  const isIgnorableWarning = (item: string) =>
    item.includes("ragic-definitions 以外未追蹤檔案") &&
    item.includes("commit baseline 時會略過");
  const autoSyncWarning =
    autoSyncPushAvailable && (status?.behind ?? 0) > 0
      ? `origin/main 有 ${status?.behind} 個新提交；推送時會先同步後再推送`
      : null;
  const visibleWarnings = [
    ...warnings.filter((item) => !isIgnorableWarning(item)),
    ...(autoSyncWarning ? [autoSyncWarning] : []),
  ];
  const actionBlockers =
    actionResult && actionResult.type !== "refresh" ? actionResult.result.blockers : [];
  const actionWarnings =
    actionResult && actionResult.type !== "refresh"
      ? actionResult.result.warnings.filter((item) => !isIgnorableWarning(item))
      : [];
  const actionStdout =
    actionResult?.type === "commit" || actionResult?.type === "push"
      ? actionResult.result.stdout.trim()
      : actionResult?.type === "rollback"
        ? actionResult.result.exportOutput?.trim() ?? ""
        : "";
  const actionStderr =
    actionResult?.type === "commit" || actionResult?.type === "push"
      ? actionResult.result.stderr.trim()
      : "";
  const refreshMessage =
    actionResult?.type === "refresh" ? actionResult.result.message : "";
  const hasDetails =
    definitionsEntries.length > 0 ||
    outsideEntries.length > 0 ||
    blockers.length > 0 ||
    visibleWarnings.length > 0 ||
    Boolean(error) ||
    Boolean(actionResult);
  const blocked = blockers.length > 0 || outsideTrackedEntries.length > 0 || Boolean(error);
  const warningOnly = !blocked && visibleWarnings.length > 0;
  const dirty = !status?.definitionsClean || definitionsEntries.length > 0;
  const trackedSummary =
    outsideTrackedEntries.length > 0
      ? `其他已追蹤檔案 ${outsideTrackedEntries.length} 筆`
      : definitionsEntries.length > 0
        ? `definitions ${definitionsEntries.length} 筆`
        : "";
  const warningSummary =
    visibleWarnings.length > 0 ? `警告 ${visibleWarnings.length} 筆` : "";

  // 下一步引導：依版控狀態推導開發者現在該按什麼，避免套用完公式後
  // 停在「baseline 有差異」不知道流程下一站
  const scopedCommitActive = commitScopeFormPaths.length > 0;
  const nextStep = (() => {
    if (blocked) return "下一步：先處理下方阻擋項，解除後才能提交 baseline";
    if ((status?.ahead ?? 0) > 0 && (status?.canPush || autoSyncPushAvailable)) {
      if (autoSyncPushAvailable) {
        return `下一步：按右上「推送 main」；系統會先同步 origin/main 再推送 ${status?.ahead} 筆 commit`;
      }
      return `下一步：按右上「推送 main」把 ${status?.ahead} 筆 commit 推上 origin`;
    }
    if (dirty && status?.canCommit) {
      return scopedCommitActive
        ? `下一步：確認本次 ${commitScopeFormPaths.length} 張表單差異 → 按右上「提交 baseline」`
        : "下一步：確認差異 → 填 commit 訊息 → 按右上「提交 baseline」";
    }
    return null;
  })();

  return (
    <section
      className={`ragic-defs__baseline${
        blocked ? " is-blocked" : dirty || warningOnly ? " is-dirty" : " is-clean"
      }`}
    >
      <div className="ragic-defs__baseline-line">
        <span className="ragic-defs__baseline-badge">
          {blocked
            ? "阻擋"
            : dirty
              ? "baseline 有差異"
              : warningOnly
                ? "警告"
                : "baseline 無差異"}
        </span>
        <button
          type="button"
          className="ragic-defs__baseline-toggle"
          disabled={!hasDetails}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "收合" : "展開"}
        </button>
        <code className="ragic-defs__baseline-meta">
          {status?.branch ?? "branch"} · {shortCommit(status?.lastCommit)} ·{" "}
          {status?.definitionsPathspec ?? "ragic-definitions"}
        </code>
        <span className="ragic-defs__baseline-remote">{formatRemoteDelta(status)}</span>
        <span className="ragic-defs__baseline-summary">
          {refreshMessage
            ? [refreshMessage, trackedSummary || warningSummary].filter(Boolean).join(" · ")
            : trackedSummary || warningSummary || "正常"}
          {blockers.length ? ` · 阻擋 ${blockers.length} 筆` : ""}
        </span>
      </div>

      {nextStep ? (
        <button
          type="button"
          className="ragic-defs__baseline-next"
          onClick={() => setExpanded(true)}
        >
          {nextStep}
        </button>
      ) : null}

      {hasDetails ? (
        <div
          className={`ragic-defs__baseline-detail-shell${
            expanded ? " is-expanded" : ""
          }`}
          aria-hidden={!expanded}
        >
          <div className="ragic-defs__baseline-detail">
            {scopedCommitActive ? (
              <div className="ragic-defs__vcs-result">
                <strong>本次 baseline 提交範圍</strong>
                <small>
                  只會提交以下表單資料夾；其他 definitions 差異會保留在工作樹，不混進本次 commit。
                </small>
                <pre>{commitScopeFormPaths.join("\n")}</pre>
              </div>
            ) : null}
            <label className="ragic-defs__vcs-message">
              <span>commit 訊息</span>
              <input
                className="ragic-inline__search"
                value={message}
                disabled={loading !== null || !expanded}
                onChange={(event) => onMessageChange(event.target.value)}
              />
            </label>
            <div className="ragic-defs__baseline-lists">
              {definitionsEntries.length ? (
                <GitEntryList title="ragic-definitions 差異" entries={definitionsEntries} />
              ) : null}
              {outsideTrackedEntries.length ? (
                <GitEntryList title="其他已追蹤檔案差異" entries={outsideTrackedEntries} danger />
              ) : null}
              {outsideUntrackedEntries.length ? (
                <GitEntryList title="其他未追蹤檔案" entries={outsideUntrackedEntries} />
              ) : null}
              {error ? <p className="dev-mode-error">{error}</p> : null}
              {blockers.length ? (
                <ResultList title="版控阻擋" items={blockers} tone="danger" />
              ) : null}
              {visibleWarnings.length ? (
                <ResultList title="版控警告" items={visibleWarnings} tone="warn" />
              ) : null}
            </div>
            {actionResult ? (
              <div className="ragic-defs__vcs-result">
                <strong>
                  {actionResult.type === "refresh"
                    ? [
                        actionResult.result.message,
                        actionResult.result.fieldIndexRefresh === "triggered"
                          ? "欄位索引背景同步中（約 30 秒，跨版本清單隨後更新）"
                          : actionResult.result.fieldIndexRefresh === "already-running"
                            ? "欄位索引已在同步中"
                            : actionResult.result.fieldIndexRefresh === "unavailable"
                              ? "欄位索引刷新不可用，請稍後手動重新抓取"
                              : actionResult.result.fieldIndexRefresh === "not-needed"
                                ? "欄位索引無結構變更，未刷新"
                              : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : actionResult.type === "commit"
                      ? actionResult.result.committed
                        ? `已提交 ${actionResult.result.commit ?? ""}`
                        : "提交被阻擋"
                      : actionResult.type === "rollback"
                        ? actionResult.result.rolledBack
                          ? `已回復套用前 ${actionResult.result.restoredCount} 張 .nui`
                          : "回復被阻擋"
                      : actionResult.result.pushed
                        ? "已推送"
                        : "推送被阻擋"}
                </strong>
                {actionResult.type === "refresh" ? (
                  <small>
                    {actionResult.result.summary.forms.toLocaleString()} 表單 ·{" "}
                    {actionResult.result.summary.fields.toLocaleString()} 欄 ·{" "}
                    {actionResult.result.summary.formulas.toLocaleString()} 公式 ·{" "}
                    {actionResult.result.summary.workflows.toLocaleString()} workflow
                  </small>
                ) : null}
                {actionResult.type === "commit" &&
                actionResult.result.scopedFormPaths?.length ? (
                  <small>
                    已提交 {actionResult.result.scopedFormPaths.length} 張表單；保留{" "}
                    {actionResult.result.retainedDefinitionsEntries?.length ?? 0} 筆其他
                    definitions 差異
                  </small>
                ) : null}
                {actionResult.type === "rollback" ? (
                  <small>
                    已重新匯入 definitions；safety backup 保留在{" "}
                    {actionResult.result.targets
                      .map((target) => target.safetyBackupFilePath)
                      .filter(Boolean)
                      .slice(0, 1)
                      .join("") || "本機 .data"}
                  </small>
                ) : null}
                {actionStdout ? <pre>{actionStdout}</pre> : null}
                {actionStderr ? <pre>{actionStderr}</pre> : null}
              </div>
            ) : null}
            {actionBlockers.length ? (
              <ResultList title="操作阻擋" items={actionBlockers} tone="danger" />
            ) : null}
            {actionWarnings.length ? (
              <ResultList title="操作警告" items={actionWarnings} tone="warn" />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GitEntryList({
  title,
  entries,
  danger = false,
}: {
  title: string;
  entries: RagicDefinitionsVersionControlStatus["entries"];
  danger?: boolean;
}) {
  return (
    <div className={`ragic-defs__git-list${danger ? " is-danger" : ""}`}>
      <strong>{title}</strong>
      <ul>
        {entries.slice(0, 12).map((entry) => (
          <li key={entry.raw}>
            <span>{entry.status.trim() || entry.status}</span>
            <code>{entry.path}</code>
          </li>
        ))}
      </ul>
      {entries.length > 12 ? <small>還有 {entries.length - 12} 筆</small> : null}
    </div>
  );
}

export function ResultList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "warn" | "danger";
}) {
  return (
    <div className={`ragic-defs__dryrun-list ragic-defs__dryrun-list--${tone}`}>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
