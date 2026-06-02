import { createApiClient } from "./apiClient";
import {
  getOrCreateClientId,
  getOrCreateTabId,
} from "../features/work-report/debug/clientIdentity";

const api = createApiClient();

function buildActorHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
  if (typeof window !== "undefined") {
    const label = window.localStorage.getItem("debug.deviceLabel");
    if (label && label.trim()) {
      headers["x-debug-device-label"] = label.trim();
    }
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
