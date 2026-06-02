import { createApiClient } from "./apiClient";

const api = createApiClient();

export type SystemNoticeLevel = "info" | "warn" | "error";

export interface SystemNoticeRecord {
  enabled: boolean;
  level: SystemNoticeLevel;
  title: string;
  message: string;
  maintenanceMode: boolean;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  maintenanceSuggested: boolean;
  maintenanceSuggestedReasons: string[];
  startAt: string | null;
  endAt: string | null;
  linkText: string | null;
  linkUrl: string | null;
  updatedAt: string;
  updatedBy: string;
  revision: number;
  forceRefreshToken: string | null;
}

export interface SystemNoticeVersionInfo {
  revision: number;
  updatedAt: string;
  forceRefreshToken: string | null;
}

export interface SystemNoticeLoginResult {
  token: string;
  username: string;
  expiresAt: string;
}

export interface SystemNoticeSessionInfo {
  username: string;
  expiresAt: string;
}

export interface SystemNoticeAdminConfig {
  maxUsers: number;
  minPasswordLength: number;
}

export async function fetchSystemNoticeAdminConfig(): Promise<SystemNoticeAdminConfig> {
  const response = await api.get<{ data: SystemNoticeAdminConfig }>(
    "/system-notice/config"
  );
  return response.data.data;
}

export interface UpdateSystemNoticePayload {
  enabled: boolean;
  level: SystemNoticeLevel;
  title: string;
  message: string;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  startAt: string | null;
  endAt: string | null;
  linkText: string | null;
  linkUrl: string | null;
  forceRefresh?: boolean;
}

export async function fetchSystemNotice(): Promise<SystemNoticeRecord> {
  const response = await api.get<{ data: SystemNoticeRecord }>("/system-notice");
  return response.data.data;
}

export async function fetchSystemNoticeVersion(): Promise<SystemNoticeVersionInfo> {
  const response = await api.get<{ data: SystemNoticeVersionInfo }>("/system-notice/version");
  return response.data.data;
}

export async function fetchSystemNoticeSession(
  token: string
): Promise<SystemNoticeSessionInfo> {
  const response = await api.get<{ data: SystemNoticeSessionInfo }>("/system-notice/session", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data.data;
}

export async function loginSystemNotice(
  username: string,
  password: string
): Promise<SystemNoticeLoginResult> {
  const response = await api.post<{ data: SystemNoticeLoginResult }>("/system-notice/login", {
    username,
    password,
  });
  return response.data.data;
}

export async function updateSystemNotice(
  token: string,
  payload: UpdateSystemNoticePayload
): Promise<SystemNoticeRecord> {
  const response = await api.put<{ data: SystemNoticeRecord }>("/system-notice", payload, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data.data;
}

export interface ChangeSystemNoticePasswordResult {
  username: string;
  updatedAt: string;
}

export async function changeSystemNoticePassword(
  token: string,
  input: {
    currentPassword: string;
    newPassword: string;
    nextUsername?: string;
  }
): Promise<ChangeSystemNoticePasswordResult> {
  const response = await api.post<{ data: ChangeSystemNoticePasswordResult }>(
    "/system-notice/change-password",
    input,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return response.data.data;
}

export interface SystemNoticeAdminUser {
  id: number;
  username: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export async function listSystemNoticeUsers(
  token: string
): Promise<SystemNoticeAdminUser[]> {
  const response = await api.get<{ data: SystemNoticeAdminUser[] }>(
    "/system-notice/users",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data.data;
}

export async function createSystemNoticeUser(
  token: string,
  input: { username: string; password: string }
): Promise<SystemNoticeAdminUser> {
  const response = await api.post<{ data: SystemNoticeAdminUser }>(
    "/system-notice/users",
    input,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data.data;
}

export async function deleteSystemNoticeUser(
  token: string,
  username: string
): Promise<void> {
  await api.delete(`/system-notice/users/${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
