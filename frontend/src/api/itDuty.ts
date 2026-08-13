import { createApiClient } from "./apiClient";
import {
  encodeTaskActorLabelHeader,
  getOrCreateClientId,
  getOrCreateTabId,
  readWorkReportDeviceLabel,
} from "../utils/clientIdentity";
import { readSystemNoticeAdminToken } from "../utils/systemNoticeAdminSession";

const api = createApiClient();

function buildActorHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
  const label = readWorkReportDeviceLabel();
  if (label) {
    headers["x-debug-device-label"] = encodeTaskActorLabelHeader(label);
  }
  const token = readSystemNoticeAdminToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export interface ItDutyMember {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItDutyOverride {
  isoWeek: string;
  memberId: number;
  note: string | null;
  /**
   * true = 改派從這週起，後續週都按新順序輪
   * false = 只改這週、後續仍按原本順序
   */
  propagateForward: boolean;
  updatedAt: string;
  updatedByLabel: string | null;
}

export interface ItDutySetting {
  weeksPerSlot: number;
  /**
   * Rotation 演算法的初始錨點。後端第一次有 member 時 seed、之後固定不變
   * → 解決「時間漂移」（autoAnchor 跟著今天走、歷史週反覆改變）。
   * member 刪除/停用時 anchor_member_id 後端會 refill 成最早 active member，
   * anchor_iso_week 保持不變。完全沒 active member 時兩者都會是 null。
   */
  anchorIsoWeek: string | null;
  anchorMemberId: number | null;
  updatedAt: string;
}

export type ItDutyDaySwapReason = "leave" | "repay";

export interface ItDutyDaySwap {
  id: number;
  coverDate: string;
  originalMemberId: number;
  coverMemberId: number;
  reason: ItDutyDaySwapReason;
  pairedSwapId: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItDutyDebtEntry {
  debtorMemberId: number;
  creditorMemberId: number;
  unsettledDays: number;
}

export interface ItDutyDayNote {
  id: number;
  noteDate: string; // YYYY-MM-DD
  note: string;
  updatedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Modal 內所有 note textarea 共用的長度上限（含 swap note + day note）。
 * 後端 routes/itDuty.ts MAX_NOTE_LENGTH 也是 200，兩邊對齊。
 */
export const IT_DUTY_NOTE_MAX_LENGTH = 200;

export async function fetchItDutyMembers(): Promise<ItDutyMember[]> {
  const response = await api.get<{ data: ItDutyMember[] }>("/it/duty/members", {
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export async function createItDutyMember(input: {
  name: string;
  active?: boolean;
}): Promise<ItDutyMember> {
  const response = await api.post<{ data: ItDutyMember }>(
    "/it/duty/members",
    input,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function updateItDutyMember(
  id: number,
  patch: { name?: string; active?: boolean }
): Promise<ItDutyMember> {
  const response = await api.patch<{ data: ItDutyMember }>(
    `/it/duty/members/${id}`,
    patch,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function deleteItDutyMember(id: number): Promise<void> {
  await api.delete(`/it/duty/members/${id}`, {
    headers: buildActorHeaders(),
  });
}

export async function reorderItDutyMembers(
  orderedIds: number[]
): Promise<ItDutyMember[]> {
  const response = await api.put<{ data: ItDutyMember[] }>(
    "/it/duty/members/order",
    { orderedIds },
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function fetchItDutyOverrides(
  range?: { from: string; to: string }
): Promise<ItDutyOverride[]> {
  const response = await api.get<{ data: ItDutyOverride[] }>(
    "/it/duty/overrides",
    {
      params: range,
      headers: buildActorHeaders(),
    }
  );
  return response.data.data;
}

export async function upsertItDutyOverride(
  isoWeek: string,
  input: {
    memberId: number;
    note?: string | null;
    propagateForward?: boolean;
  }
): Promise<ItDutyOverride> {
  const response = await api.put<{ data: ItDutyOverride }>(
    `/it/duty/overrides/${isoWeek}`,
    input,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function deleteItDutyOverride(isoWeek: string): Promise<void> {
  await api.delete(`/it/duty/overrides/${isoWeek}`, {
    headers: buildActorHeaders(),
  });
}

export async function fetchItDutySetting(): Promise<ItDutySetting> {
  const response = await api.get<{ data: ItDutySetting }>("/it/duty/settings", {
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export async function updateItDutySetting(
  weeksPerSlot: number
): Promise<ItDutySetting> {
  const response = await api.put<{ data: ItDutySetting }>(
    "/it/duty/settings",
    { weeksPerSlot },
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function fetchItDutySwaps(
  range?: { from: string; to: string }
): Promise<ItDutyDaySwap[]> {
  const response = await api.get<{ data: ItDutyDaySwap[] }>("/it/duty/swaps", {
    params: range,
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export async function createItDutyLeaveSwap(input: {
  coverDate: string;
  originalMemberId: number;
  coverMemberId: number;
  note?: string | null;
}): Promise<ItDutyDaySwap> {
  const response = await api.post<{ data: ItDutyDaySwap }>(
    "/it/duty/swaps/leave",
    input,
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function createItDutyRepaySwap(input: {
  coverDate: string;
  pairLeaveSwapId: number;
  note?: string | null;
}): Promise<{ leave: ItDutyDaySwap; repay: ItDutyDaySwap }> {
  const response = await api.post<{
    data: { leave: ItDutyDaySwap; repay: ItDutyDaySwap };
  }>("/it/duty/swaps/repay", input, { headers: buildActorHeaders() });
  return response.data.data;
}

export async function deleteItDutySwap(id: number): Promise<void> {
  await api.delete(`/it/duty/swaps/${id}`, {
    headers: buildActorHeaders(),
  });
}

export async function fetchItDutyDebts(): Promise<ItDutyDebtEntry[]> {
  const response = await api.get<{ data: ItDutyDebtEntry[] }>("/it/duty/debts", {
    headers: buildActorHeaders(),
  });
  return response.data.data;
}

export async function fetchItDutyDayNotes(
  range?: { from: string; to: string }
): Promise<ItDutyDayNote[]> {
  const response = await api.get<{ data: ItDutyDayNote[] }>(
    "/it/duty/day-notes",
    {
      params: range ? { from: range.from, to: range.to } : undefined,
      headers: buildActorHeaders(),
    }
  );
  return response.data.data;
}

export async function upsertItDutyDayNote(
  noteDate: string,
  note: string
): Promise<ItDutyDayNote> {
  const response = await api.put<{ data: ItDutyDayNote }>(
    `/it/duty/day-notes/${noteDate}`,
    { note },
    { headers: buildActorHeaders() }
  );
  return response.data.data;
}

export async function deleteItDutyDayNote(noteDate: string): Promise<void> {
  await api.delete(`/it/duty/day-notes/${noteDate}`, {
    headers: buildActorHeaders(),
  });
}
