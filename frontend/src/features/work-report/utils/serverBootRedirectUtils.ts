import { clearHydrationCache } from "./storageUtils";
import {
  WORK_REPORT_LANDING_PAGE_KEYS,
  WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY,
  WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
} from "../constants";

const SERVER_BOOT_REDIRECT_FLASH_STORAGE_KEY = "work-report:server-boot-redirect-flash:v1";
const SERVER_BOOT_REDIRECT_PENDING_STORAGE_KEY = "work-report:server-boot-redirect-pending:v1";
const SERVER_BOOT_REDIRECT_HANDLED_DEPLOY_VERSION_STORAGE_KEY =
  "work-report:server-boot-redirect-handled-deploy-version:v1";

interface ServerBootRedirectFlashPayload {
  deployVersion: string;
  messageKey: string;
}

export function writeServerBootRedirectFlash(
  payload: ServerBootRedirectFlashPayload
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      SERVER_BOOT_REDIRECT_FLASH_STORAGE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // NOTE: sessionStorage 寫入失敗時不阻塞強制導頁
  }
}

export function readServerBootRedirectFlash(): ServerBootRedirectFlashPayload | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(SERVER_BOOT_REDIRECT_FLASH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ServerBootRedirectFlashPayload>;
    const deployVersion = String(parsed.deployVersion ?? "").trim();
    const messageKey = String(parsed.messageKey ?? "").trim();
    if (!deployVersion || !messageKey) {
      window.sessionStorage.removeItem(SERVER_BOOT_REDIRECT_FLASH_STORAGE_KEY);
      return null;
    }
    return { deployVersion, messageKey };
  } catch {
    return null;
  }
}

export function clearServerBootRedirectFlash(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SERVER_BOOT_REDIRECT_FLASH_STORAGE_KEY);
    window.sessionStorage.removeItem(SERVER_BOOT_REDIRECT_PENDING_STORAGE_KEY);
  } catch {
    // NOTE: sessionStorage 清除失敗時不阻塞主流程
  }
}

export function hasServerBootRedirectPending(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return Boolean(
      String(window.sessionStorage.getItem(SERVER_BOOT_REDIRECT_PENDING_STORAGE_KEY) ?? "").trim()
    );
  } catch {
    return false;
  }
}

export function readHandledServerBootRedirectDeployVersion(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(
      window.localStorage.getItem(SERVER_BOOT_REDIRECT_HANDLED_DEPLOY_VERSION_STORAGE_KEY) ?? ""
    ).trim();
  } catch {
    return "";
  }
}

export function writeHandledServerBootRedirectDeployVersion(deployVersion: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = String(deployVersion ?? "").trim();
    if (!normalized) {
      window.localStorage.removeItem(SERVER_BOOT_REDIRECT_HANDLED_DEPLOY_VERSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      SERVER_BOOT_REDIRECT_HANDLED_DEPLOY_VERSION_STORAGE_KEY,
      normalized
    );
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞 redirect dedupe。
  }
}

export function consumeServerBootRedirectFlash(): ServerBootRedirectFlashPayload | null {
  const payload = readServerBootRedirectFlash();
  clearServerBootRedirectFlash();
  return payload;
}

export function redirectToWorkReportHomeAfterBootUpdate(
  deployVersion: string,
  messageKey = "workReport:messages.systemUpdatedForcedHome"
): void {
  if (typeof window === "undefined") {
    return;
  }

  for (const landingPageKey of WORK_REPORT_LANDING_PAGE_KEYS) {
    clearHydrationCache(landingPageKey === "thread-rolling-104" ? "104" : "105");
  }
  try {
    window.localStorage.removeItem(WORK_REPORT_TASK_MONITOR_STORAGE_KEY);
  } catch {
    // NOTE: localStorage 清除失敗時不阻塞強制導頁
  }
  try {
    window.sessionStorage.removeItem(WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY);
  } catch {
    // NOTE: sessionStorage 清除失敗時不阻塞強制導頁
  }
  try {
    window.sessionStorage.setItem(SERVER_BOOT_REDIRECT_PENDING_STORAGE_KEY, deployVersion);
  } catch {
    // NOTE: pending 標記寫入失敗時不阻塞強制導頁
  }
  writeHandledServerBootRedirectDeployVersion(deployVersion);
  writeServerBootRedirectFlash({
    deployVersion,
    messageKey,
  });
  window.location.assign("/");
}
