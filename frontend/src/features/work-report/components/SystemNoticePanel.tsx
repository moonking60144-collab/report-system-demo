import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getErrorCode, isUnauthorized } from "../../../api/apiErrors";
import { useTranslation } from "react-i18next";
import type { WorkReportFrontendEventAction } from "../debug/workReportDeveloperContract";
import {
  fetchSystemNotice,
  fetchSystemNoticeSession,
  loginSystemNotice,
  updateSystemNotice,
  type SystemNoticeLevel,
  type SystemNoticeRecord,
  type UpdateSystemNoticePayload,
} from "../../../api/systemNotice";
import type { NoticeState } from "../types";
import { getErrorMessage } from "../utils";
import { pushFrontendEvent } from "../logging/frontendEventLog";
import { cacheSystemNoticeAvailabilitySnapshot } from "../systemAvailability";
import {
  readSystemNoticeAdminToken,
  writeSystemNoticeAdminToken,
} from "../../../utils/systemNoticeAdminSession";
import { SystemNoticePanelHeader } from "./system-notice/SystemNoticePanelHeader";
import { SystemNoticeLoadingState } from "./system-notice/SystemNoticeLoadingState";
import { SystemNoticeNoticeContent } from "./system-notice/SystemNoticeNoticeContent";
import { SystemNoticeEditorForm } from "./system-notice/SystemNoticeEditorForm";
import { SystemNoticePopup } from "./system-notice/SystemNoticePopup";
import { SystemNoticeLoginModal } from "./system-notice/SystemNoticeLoginModal";

interface NoticeDraft {
  enabled: boolean;
  level: SystemNoticeLevel;
  title: string;
  message: string;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  startAtInput: string;
  endAtInput: string;
  linkText: string;
  linkUrl: string;
  forceRefreshAfterSave: boolean;
}

const SYSTEM_NOTICE_DISMISSED_REVISION_STORAGE_KEY = "work-report:system-notice-dismissed-revision:v1";
const SYSTEM_NOTICE_TOAST_SEEN_REVISION_STORAGE_KEY = "work-report:system-notice-toast-seen-revision:v1";
const SYSTEM_NOTICE_FORCE_REFRESH_HANDLED_TOKEN_STORAGE_KEY =
  "work-report:system-notice-force-refresh-handled-token:v1";
const SYSTEM_NOTICE_EDITOR_PREFS_STORAGE_KEY =
  "work-report:system-notice-editor-prefs:v1";

function writeStoredToken(token: string): void {
  writeSystemNoticeAdminToken(token, "session");
}

function readStoredToken(): string {
  return readSystemNoticeAdminToken();
}

function readDismissedRevision(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(SYSTEM_NOTICE_DISMISSED_REVISION_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function writeDismissedRevision(revision: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!revision) {
      window.localStorage.removeItem(SYSTEM_NOTICE_DISMISSED_REVISION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SYSTEM_NOTICE_DISMISSED_REVISION_STORAGE_KEY, revision);
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

function readToastSeenRevision(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(SYSTEM_NOTICE_TOAST_SEEN_REVISION_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

function writeToastSeenRevision(revision: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!revision) {
      window.localStorage.removeItem(SYSTEM_NOTICE_TOAST_SEEN_REVISION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SYSTEM_NOTICE_TOAST_SEEN_REVISION_STORAGE_KEY, revision);
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

function writeForceRefreshHandledToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!token) {
      window.localStorage.removeItem(SYSTEM_NOTICE_FORCE_REFRESH_HANDLED_TOKEN_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SYSTEM_NOTICE_FORCE_REFRESH_HANDLED_TOKEN_STORAGE_KEY, token);
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

interface SystemNoticeEditorPrefs {
  forceRefreshAfterSave?: boolean;
}

function readSystemNoticeEditorPrefs(): SystemNoticeEditorPrefs {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = String(
      window.localStorage.getItem(SYSTEM_NOTICE_EDITOR_PREFS_STORAGE_KEY) ?? ""
    ).trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<SystemNoticeEditorPrefs>;
    return {
      forceRefreshAfterSave: parsed.forceRefreshAfterSave === true,
    };
  } catch {
    return {};
  }
}

function writeSystemNoticeEditorPrefs(prefs: SystemNoticeEditorPrefs): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      SYSTEM_NOTICE_EDITOR_PREFS_STORAGE_KEY,
      JSON.stringify({
        forceRefreshAfterSave: prefs.forceRefreshAfterSave === true,
      })
    );
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

function toDatetimeLocalInput(isoValue: string | null): string {
  if (!isoValue) {
    return "";
  }
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  const hours = `${parsed.getHours()}`.padStart(2, "0");
  const minutes = `${parsed.getMinutes()}`.padStart(2, "0");
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

function toDatetimePickerInput(isoValue: string | null): string {
  if (!isoValue) {
    return "";
  }
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  const hours = `${parsed.getHours()}`.padStart(2, "0");
  const minutes = `${parsed.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

interface ParsedDateTimeInput {
  normalizedInput: string;
  isoValue: string | null;
  isValid: boolean;
}

function parseFlexibleDateTimeInput(value: string): ParsedDateTimeInput {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      normalizedInput: "",
      isoValue: null,
      isValid: true,
    };
  }

  const normalized = trimmed
    .replace(/[年.]/g, "/")
    .replace(/月/g, "/")
    .replace(/日/g, " ")
    .replace(/[Ｔt]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/：/g, ":")
    .trim();

  const digitOnly = normalized.replace(/\D/g, "");
  if (/^\d{12}$/.test(digitOnly)) {
    const year = Number(digitOnly.slice(0, 4));
    const month = Number(digitOnly.slice(4, 6));
    const day = Number(digitOnly.slice(6, 8));
    const hour = Number(digitOnly.slice(8, 10));
    const minute = Number(digitOnly.slice(10, 12));
    return buildParsedDateTime(year, month, day, hour, minute);
  }

  const match = normalized.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+)(上午|下午|AM|PM|am|pm)?\s*(\d{1,2})(?::?(\d{2}))?$/
  );
  if (!match) {
    return {
      normalizedInput: trimmed,
      isoValue: null,
      isValid: false,
    };
  }

  let hour = Number(match[5]);
  const meridiem = String(match[4] ?? "").toLowerCase();
  const minute = Number(match[6] ?? "0");
  if (meridiem === "下午" || meridiem === "pm") {
    if (hour < 12) {
      hour += 12;
    }
  } else if ((meridiem === "上午" || meridiem === "am") && hour === 12) {
    hour = 0;
  }

  return buildParsedDateTime(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    hour,
    minute
  );
}

function buildParsedDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): ParsedDateTimeInput {
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 9999 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return {
      normalizedInput: `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      isoValue: null,
      isValid: false,
    };
  }

  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() + 1 !== month ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute
  ) {
    return {
      normalizedInput: `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      isoValue: null,
      isValid: false,
    };
  }

  return {
    normalizedInput: `${String(year).padStart(4, "0")}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    isoValue: parsed.toISOString(),
    isValid: true,
  };
}

function normalizeDateTimeInput(value: string): string | null {
  const parsed = parseFlexibleDateTimeInput(value);
  return parsed.isValid ? parsed.isoValue : null;
}

function detectMaintenanceSuggestion(input: {
  title: string;
  message: string;
  linkText: string;
}): { suggested: boolean; reasons: string[] } {
  const normalizedText = [input.title, input.message, input.linkText]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const compactText = normalizedText
    .replace(/[\s,.:;!?，。：；！？()（）{}\-_/\\]+/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "");
  const reasons = new Set<string>();

  if (compactText.includes("系統維護")) {
    reasons.add("系統維護");
  }
  if (compactText.includes("停機維護")) {
    reasons.add("停機維護");
  }
  if (compactText.includes("systemmaintenance")) {
    reasons.add("system maintenance");
  }
  if (compactText.includes("scheduledmaintenance")) {
    reasons.add("scheduled maintenance");
  }
  if (compactText.includes("plannedmaintenance")) {
    reasons.add("planned maintenance");
  }
  if (compactText.includes("系統升級")) {
    reasons.add("系統升級");
  }
  if (compactText.includes("系統更新")) {
    reasons.add("系統更新");
  }
  if (compactText.includes("systemupgrade")) {
    reasons.add("system upgrade");
  }
  if (compactText.includes("systemupdate")) {
    reasons.add("system update");
  }

  const hasSystemKeyword =
    compactText.includes("系統") ||
    compactText.includes("伺服器") ||
    compactText.includes("後端") ||
    compactText.includes("服務") ||
    normalizedText.includes("system") ||
    normalizedText.includes("server") ||
    normalizedText.includes("backend") ||
    normalizedText.includes("service");
  const hasMaintenanceKeyword =
    compactText.includes("維護") ||
    compactText.includes("升級") ||
    compactText.includes("更新") ||
    compactText.includes("停機") ||
    compactText.includes("重啟") ||
    compactText.includes("修復") ||
    normalizedText.includes("maintenance") ||
    normalizedText.includes("upgrade") ||
    normalizedText.includes("updating") ||
    normalizedText.includes("deploy") ||
    normalizedText.includes("deployment") ||
    normalizedText.includes("restart") ||
    normalizedText.includes("downtime") ||
    normalizedText.includes("unavailable");

  if (hasSystemKeyword && hasMaintenanceKeyword) {
    reasons.add("system+maintenance");
  }

  return {
    suggested: reasons.size > 0,
    reasons: Array.from(reasons),
  };
}

function toNoticeDraft(
  notice: SystemNoticeRecord,
  editorPrefs: SystemNoticeEditorPrefs = {}
): NoticeDraft {
  return {
    enabled: notice.enabled,
    level: notice.level,
    title: notice.title,
    message: notice.message,
    maintenanceDecision: notice.maintenanceDecision,
    startAtInput: toDatetimeLocalInput(notice.startAt),
    endAtInput: toDatetimeLocalInput(notice.endAt),
    linkText: notice.linkText ?? "",
    linkUrl: notice.linkUrl ?? "",
    forceRefreshAfterSave: editorPrefs.forceRefreshAfterSave === true,
  };
}

function formatDisplayDateTime(raw: string | null): string {
  if (!raw) {
    return "--";
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }
  return parsed.toLocaleString("zh-TW", { hour12: false });
}

function isNoticeActive(notice: SystemNoticeRecord): boolean {
  if (!notice.enabled) {
    return false;
  }
  const now = Date.now();
  const startAt = notice.startAt ? Date.parse(notice.startAt) : null;
  const endAt = notice.endAt ? Date.parse(notice.endAt) : null;
  if (startAt !== null && Number.isFinite(startAt) && now < startAt) {
    return false;
  }
  if (endAt !== null && Number.isFinite(endAt) && now > endAt) {
    return false;
  }
  return true;
}

interface SystemNoticePanelProps {
  onForceRefreshRequested?: (forceRefreshToken: string) => void | Promise<void>;
  forceReloadToken?: string;
  statusNotice?: NoticeState | null;
}

export function SystemNoticePanel({
  onForceRefreshRequested,
  forceReloadToken,
  statusNotice,
}: SystemNoticePanelProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const logNoticeEvent = useCallback(
    (
      action: WorkReportFrontendEventAction,
      summary: string,
      options: {
        level?: "info" | "warn" | "error";
        meta?: Record<string, string | number | boolean | null | undefined | string[]>;
      } = {}
    ) => {
      pushFrontendEvent({
        level: options.level ?? "info",
        category: "ui",
        action,
        summary,
        meta: options.meta,
      });
    },
    []
  );
  const [notice, setNotice] = useState<SystemNoticeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [token, setToken] = useState<string>(() => readStoredToken());
  const [tokenVerified, setTokenVerified] = useState(false);
  const [loginDraft, setLoginDraft] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submittingLogin, setSubmittingLogin] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [dismissedRevision, setDismissedRevision] = useState<string>(() => readDismissedRevision());
  const [toastSeenRevision, setToastSeenRevision] = useState<string>(() => readToastSeenRevision());
  const [noticePopupOpen, setNoticePopupOpen] = useState(false);
  const noticeRevisionRef = useRef("");
  const forceRefreshTokenRef = useRef("");
  const startAtPickerInputRef = useRef<HTMLInputElement | null>(null);
  const endAtPickerInputRef = useRef<HTMLInputElement | null>(null);
  const loadNoticeRef = useRef<() => Promise<void>>(async () => {});
  const hasLoadedNoticeRef = useRef(false);
  const [draft, setDraft] = useState<NoticeDraft>({
    enabled: false,
    level: "info",
    title: "",
    message: "",
    maintenanceDecision: "auto",
    startAtInput: "",
    endAtInput: "",
    linkText: "",
    linkUrl: "",
    forceRefreshAfterSave: false,
  });
  const parsedStartAtInput = useMemo(
    () => parseFlexibleDateTimeInput(draft.startAtInput),
    [draft.startAtInput]
  );
  const parsedEndAtInput = useMemo(
    () => parseFlexibleDateTimeInput(draft.endAtInput),
    [draft.endAtInput]
  );
  const maintenanceSuggestion = useMemo(
    () =>
      detectMaintenanceSuggestion({
        title: draft.title,
        message: draft.message,
        linkText: draft.linkText,
      }),
    [draft.linkText, draft.message, draft.title]
  );
  const maintenanceModeChecked =
    draft.maintenanceDecision === "manual-on"
      ? true
      : draft.maintenanceDecision === "manual-off"
        ? false
        : maintenanceSuggestion.suggested;
  const dateTimeInputError = useMemo(() => {
    if (draft.startAtInput.trim() && !parsedStartAtInput.isValid) {
      return t("workReport:systemNotice.errors.invalidDateTimeInput");
    }
    if (draft.endAtInput.trim() && !parsedEndAtInput.isValid) {
      return t("workReport:systemNotice.errors.invalidDateTimeInput");
    }
    if (
      parsedStartAtInput.isoValue &&
      parsedEndAtInput.isoValue &&
      Date.parse(parsedEndAtInput.isoValue) < Date.parse(parsedStartAtInput.isoValue)
    ) {
      return t("workReport:systemNotice.errors.invalidDateTimeRange");
    }
    return null;
  }, [draft.endAtInput, draft.startAtInput, parsedEndAtInput, parsedStartAtInput, t]);
  const startAtPickerValue = useMemo(
    () => toDatetimePickerInput(parsedStartAtInput.isoValue),
    [parsedStartAtInput.isoValue]
  );
  const endAtPickerValue = useMemo(
    () => toDatetimePickerInput(parsedEndAtInput.isoValue),
    [parsedEndAtInput.isoValue]
  );
  const handleDateTimePickerChange = useCallback(
    (field: "startAtInput" | "endAtInput", rawValue: string) => {
      const nextInput = toDatetimeLocalInput(rawValue ? new Date(rawValue).toISOString() : null);
      setDraft((prev) => ({
        ...prev,
        [field]: nextInput,
      }));
    },
    []
  );
  const openDateTimePicker = useCallback((field: "startAtInput" | "endAtInput") => {
    const target = field === "startAtInput" ? startAtPickerInputRef.current : endAtPickerInputRef.current;
    if (!target) {
      return;
    }
    if (typeof target.showPicker === "function") {
      target.showPicker();
      return;
    }
    target.focus();
    target.click();
  }, []);

  const loadNotice = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextNotice = await fetchSystemNotice();
      setNotice(nextNotice);
      setDraft(toNoticeDraft(nextNotice, readSystemNoticeEditorPrefs()));
      cacheSystemNoticeAvailabilitySnapshot(nextNotice);
      hasLoadedNoticeRef.current = true;
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNoticeRef.current = loadNotice;
  }, [loadNotice]);

  useEffect(() => {
    void loadNotice();
  }, [loadNotice]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePageShow = () => {
      hasLoadedNoticeRef.current = false;
      void loadNoticeRef.current();
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(() => {
    if (!forceReloadToken || !hasLoadedNoticeRef.current) {
      return;
    }
    void loadNoticeRef.current();
  }, [forceReloadToken]);

  useEffect(() => {
    if (!token) {
      setTokenVerified(true);
      setEditing(false);
      return;
    }

    let cancelled = false;
    setTokenVerified(false);

    const verify = async () => {
      try {
        await fetchSystemNoticeSession(token);
        if (!cancelled) {
          setTokenVerified(true);
        }
      } catch (error) {
        if (!cancelled) {
          // 只有 401（token 真失效）才清；timeout / backend 暫時沒回應保留
          // token，下次操作再驗（避免 backend 慢 10 秒就把管理者登出）
          if (isUnauthorized(error)) {
            setToken("");
            writeStoredToken("");
            setEditing(false);
            setLoginModalOpen(false);
            setLoginError(null);
            setSaveError(null);
            setSaveNotice(null);
          }
          setTokenVerified(true);
        }
      }
    };

    void verify();

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!saveNotice) {
      return;
    }
    const timer = window.setTimeout(() => setSaveNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [saveNotice]);

  useEffect(() => {
    if (!notice || !notice.enabled) {
      return;
    }
    const revision = String(notice.updatedAt ?? "").trim();
    if (!revision) {
      return;
    }
    if (dismissedRevision === revision) {
      return;
    }
    if (toastSeenRevision === revision) {
      return;
    }
    setNoticePopupOpen(true);
  }, [dismissedRevision, notice, toastSeenRevision]);

  const activeState = useMemo(() => {
    if (!notice) {
      return false;
    }
    return isNoticeActive(notice);
  }, [notice]);

  const noticeRevision = useMemo(() => {
    if (!notice) {
      return "";
    }
    return String(notice.updatedAt ?? "").trim();
  }, [notice]);

  const isDismissedByDevice = useMemo(() => {
    if (!activeState || !noticeRevision) {
      return false;
    }
    return dismissedRevision === noticeRevision;
  }, [activeState, dismissedRevision, noticeRevision]);

  const isNoticeContentVisible = !isDismissedByDevice || editing;
  const inlineStatusMessage =
    statusNotice && String(statusNotice.message ?? "").trim() ? statusNotice.message : null;
  const inlineStatusType = statusNotice?.type ?? "success";
  const isInlineStatusSpinning = statusNotice?.type === "loading";
  const shouldShowHeaderActions = Boolean(notice) || editing;
  const handleNormalizeDateTimeInput = useCallback((_field: "startAtInput" | "endAtInput", rawValue: string) => {
    return parseFlexibleDateTimeInput(rawValue).normalizedInput;
  }, []);
  const handleSetForceRefreshAfterSave = useCallback((checked: boolean) => {
    setDraft((prev) => {
      const nextDraft = {
        ...prev,
        forceRefreshAfterSave: checked,
      };
      writeSystemNoticeEditorPrefs({
        forceRefreshAfterSave: nextDraft.forceRefreshAfterSave,
      });
      return nextDraft;
    });
  }, []);
  const handleToggleEditMode = useCallback(() => {
    if (editing) {
      setEditing(false);
      setLoginModalOpen(false);
      setLoginError(null);
      setSaveError(null);
      setSaveNotice(null);
      return;
    }

    if (!token || !tokenVerified) {
      setLoginModalOpen(true);
      setLoginError(null);
      setSaveError(null);
      setSaveNotice(null);
      return;
    }

    setEditing(true);
    setLoginError(null);
    setSaveError(null);
    setSaveNotice(null);
  }, [editing, token, tokenVerified]);
  const handleCloseLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    setLoginError(null);
  }, []);

  useEffect(() => {
    noticeRevisionRef.current = String(notice?.revision ?? "").trim();
    forceRefreshTokenRef.current = String(notice?.forceRefreshToken ?? "").trim();
  }, [notice]);

  // 改 SSE 事件驅動：useWorkReportRealtime 收到 system-notice-content-updated SSE event
  // 後 dispatch CustomEvent('app:system-notice-content-updated')，這裡訂閱觸發 loadNotice。
  // 取代原本每 15s 打一支 /api/system-notice/version 的 polling。
  // force-refresh 已由 useWorkReportRealtime 直接處理 onSystemNoticeForceRefresh callback。
  useEffect(() => {
    if (!notice || typeof window === "undefined") {
      return;
    }

    const handleNoticeContentUpdated = (event: Event) => {
      if (!hasLoadedNoticeRef.current) return;
      const detail = (event as CustomEvent<{ revision?: number | null }>).detail;
      const incomingRevision = String(detail?.revision ?? "").trim();
      // 跟自己當前的 revision 比對：相同就 no-op（避免自己 PUT 完後 SSE 再 trigger 一次）
      if (incomingRevision && incomingRevision === noticeRevisionRef.current) {
        return;
      }
      void loadNoticeRef.current();
    };

    window.addEventListener("app:system-notice-content-updated", handleNoticeContentUpdated);
    return () => {
      window.removeEventListener("app:system-notice-content-updated", handleNoticeContentUpdated);
    };
  }, [notice]);

  const handleLogin = useCallback(async () => {
    setLoginError(null);
    setSaveNotice(null);
    setSubmittingLogin(true);
    try {
      const result = await loginSystemNotice(loginDraft.username, loginDraft.password);
      setToken(result.token);
      writeStoredToken(result.token);
      setLoginDraft((prev) => ({ ...prev, password: "" }));
      setLoginModalOpen(false);
      setEditing(true);
      setSaveNotice(t("workReport:systemNotice.loginSuccess"));
      logNoticeEvent("system-notice-login-succeeded", "系統通知登入成功");
    } catch (loginErrorValue) {
      logNoticeEvent("system-notice-login-failed", getErrorMessage(loginErrorValue), {
        level: "error",
      });
      setLoginError(getErrorMessage(loginErrorValue));
    } finally {
      setSubmittingLogin(false);
    }
  }, [logNoticeEvent, loginDraft.password, loginDraft.username, t]);

  const handleLogout = useCallback(() => {
    setToken("");
    writeStoredToken("");
    setEditing(false);
    setLoginModalOpen(false);
    setLoginError(null);
    setSaveNotice(null);
  }, []);

  const handleSaveNotice = useCallback(async () => {
    if (!token) {
      setSaveError(t("workReport:systemNotice.errors.loginRequired"));
      return;
    }
    if (dateTimeInputError) {
      setSaveError(dateTimeInputError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    const payload: UpdateSystemNoticePayload = {
      enabled: draft.enabled,
      level: draft.level,
      title: draft.title.trim(),
      message: draft.message.trim(),
      maintenanceDecision: draft.maintenanceDecision,
      startAt: normalizeDateTimeInput(draft.startAtInput),
      endAt: normalizeDateTimeInput(draft.endAtInput),
      linkText: draft.linkText.trim() || null,
      linkUrl: draft.linkUrl.trim() || null,
      forceRefresh: draft.forceRefreshAfterSave,
    };

    try {
      const updated = await updateSystemNotice(token, payload);
      setNotice(updated);
      writeSystemNoticeEditorPrefs({
        forceRefreshAfterSave: draft.forceRefreshAfterSave,
      });
      setDraft(toNoticeDraft(updated, readSystemNoticeEditorPrefs()));
      cacheSystemNoticeAvailabilitySnapshot(updated);
      setDismissedRevision("");
      writeDismissedRevision("");
      if (draft.forceRefreshAfterSave && updated.forceRefreshToken) {
        writeForceRefreshHandledToken(updated.forceRefreshToken);
        void onForceRefreshRequested?.(updated.forceRefreshToken);
      }
      setSaveNotice(t("workReport:systemNotice.saveSuccess"));
      setEditing(false);
      logNoticeEvent("system-notice-save-succeeded", "系統通知保存成功", {
        meta: {
          enabled: payload.enabled,
          level: payload.level,
          changedFields: Object.keys(payload).sort(),
        },
      });
    } catch (saveErrorValue) {
      const message = getErrorMessage(saveErrorValue);
      logNoticeEvent("system-notice-save-failed", message, {
        level: "error",
      });
      setSaveError(message);
      const code = getErrorCode(saveErrorValue);
      if (
        isUnauthorized(saveErrorValue) ||
        code === "NOTICE_TOKEN_INVALID" ||
        code === "NOTICE_TOKEN_MISSING"
      ) {
        setToken("");
        writeStoredToken("");
      }
    } finally {
      setSaving(false);
    }
  }, [dateTimeInputError, draft, logNoticeEvent, onForceRefreshRequested, t, token]);

  const handleDismissNoticeForDevice = useCallback(() => {
    if (!noticeRevision) {
      return;
    }
    setDismissedRevision(noticeRevision);
    writeDismissedRevision(noticeRevision);
    setNoticePopupOpen(false);
  }, [noticeRevision]);

  const handleReopenDismissedNotice = useCallback(() => {
    setDismissedRevision("");
    writeDismissedRevision("");
  }, []);

  const handleCloseNoticePopup = useCallback(() => {
    setNoticePopupOpen(false);
    if (!noticeRevision) {
      return;
    }
    if (toastSeenRevision === noticeRevision) {
      return;
    }
    setToastSeenRevision(noticeRevision);
    writeToastSeenRevision(noticeRevision);
  }, [noticeRevision, toastSeenRevision]);

  const emptyTitleText = t("workReport:systemNotice.emptyTitle");
  const emptyMessageText = t("workReport:systemNotice.emptyMessage");
  const effectiveRangeText = notice
    ? t("workReport:systemNotice.effectiveRange", {
        start: formatDisplayDateTime(notice.startAt),
        end: formatDisplayDateTime(notice.endAt),
      })
    : "";
  const updatedMetaText = notice
    ? t("workReport:systemNotice.updatedMeta", {
        time: formatDisplayDateTime(notice.updatedAt),
        user: notice.updatedBy || "--",
      })
    : "";

  return (
    <section className={`system-notice-panel${isDismissedByDevice && !editing ? " is-collapsed" : ""}`} aria-live="polite">
      <SystemNoticePanelHeader
        noticeExists={Boolean(notice)}
        activeState={activeState}
        shouldShowHeaderActions={shouldShowHeaderActions}
        showDismissButton={Boolean(notice) && activeState && !editing}
        dismissButtonText={
          isDismissedByDevice
            ? t("workReport:systemNotice.actions.showNotice")
            : t("workReport:systemNotice.actions.dismiss")
        }
        editing={editing}
        inlineStatusMessage={inlineStatusMessage}
        inlineStatusType={inlineStatusType}
        isInlineStatusSpinning={isInlineStatusSpinning}
        onDismissToggle={
          isDismissedByDevice ? handleReopenDismissedNotice : handleDismissNoticeForDevice
        }
        onEditToggle={handleToggleEditMode}
      />

      <SystemNoticeLoadingState loading={loading} error={error} />

      {!loading && !error && notice && isNoticeContentVisible && (
        <SystemNoticeNoticeContent
          notice={notice}
          emptyTitle={emptyTitleText}
          emptyMessage={emptyMessageText}
          effectiveRange={effectiveRangeText}
          updatedMeta={updatedMetaText}
          className={`system-notice-content level-${notice.level}`}
        />
      )}

      {editing && token && (
        <SystemNoticeEditorForm
          draft={draft}
          maintenanceSuggestion={maintenanceSuggestion}
          maintenanceModeChecked={maintenanceModeChecked}
          dateTimeState={{
            startAtPickerValue,
            endAtPickerValue,
            dateTimeInputError,
            saveError,
            saveNotice,
            saving,
          }}
          dateTimeRefs={{
            startAtPickerInputRef,
            endAtPickerInputRef,
          }}
          handlers={{
            setDraft,
            openDateTimePicker,
            handleDateTimePickerChange,
            normalizeDateTimeInput: handleNormalizeDateTimeInput,
            resetMaintenanceDecision: () => {
              setDraft((prev) => ({ ...prev, maintenanceDecision: "auto" }));
            },
            onSave: () => {
              void handleSaveNotice();
            },
            onLogout: handleLogout,
            setForceRefreshAfterSave: handleSetForceRefreshAfterSave,
          }}
        />
      )}

      <SystemNoticePopup
        open={noticePopupOpen && Boolean(notice) && !editing}
        notice={notice}
        onClose={handleCloseNoticePopup}
        emptyTitle={emptyTitleText}
        emptyMessage={emptyMessageText}
        effectiveRange={effectiveRangeText}
        updatedMeta={updatedMetaText}
      />

      <SystemNoticeLoginModal
        open={loginModalOpen}
        username={loginDraft.username}
        password={loginDraft.password}
        loginError={loginError}
        submittingLogin={submittingLogin}
        onUsernameChange={(username) => setLoginDraft((prev) => ({ ...prev, username }))}
        onPasswordChange={(password) => setLoginDraft((prev) => ({ ...prev, password }))}
        onSubmit={() => {
          void handleLogin();
        }}
        onClose={handleCloseLoginModal}
      />
    </section>
  );
}
