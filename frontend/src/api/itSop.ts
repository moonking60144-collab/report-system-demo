import { createApiClient } from "./apiClient";
import {
  encodeTaskActorLabelHeader,
  getOrCreateClientId,
  getOrCreateTabId,
  readWorkReportDeviceLabel,
} from "../utils/clientIdentity";
import { readSystemNoticeAdminToken } from "../utils/systemNoticeAdminSession";

const api = createApiClient();

export type ItSopSectionKind = "text" | "table" | "code" | "checklist";

export interface ItSopTableRow {
  id: string;
  cells: string[];
}

export interface ItSopChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface ItSopSection {
  id: string;
  title: string;
  kind: ItSopSectionKind;
  text: string;
  rows: ItSopTableRow[];
  items: ItSopChecklistItem[];
  collapsed: boolean;
}

export interface ItSopDocument {
  id: string;
  title: string;
  summary: string;
  templateVersion: number;
  sections: ItSopSection[];
  updatedAt: string;
  updatedByLabel: string | null;
}

function buildActorHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-debug-client-id": getOrCreateClientId(),
    "x-debug-tab-id": getOrCreateTabId(),
  };
  const label = readWorkReportDeviceLabel();
  if (label) {
    headers["x-debug-device-label"] = encodeTaskActorLabelHeader(label);
  }
  return headers;
}

export async function fetchItSopDocument(documentId: string): Promise<ItSopDocument> {
  const token = readSystemNoticeAdminToken();
  const response = await api.get<{ data: ItSopDocument }>(
    `/it/sop-documents/${encodeURIComponent(documentId)}`,
    {
      headers: {
        ...buildActorHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }
  );
  return response.data.data;
}

export async function saveItSopDocument(document: ItSopDocument): Promise<ItSopDocument> {
  const token = readSystemNoticeAdminToken();
  const response = await api.put<{ data: ItSopDocument }>(
    `/it/sop-documents/${encodeURIComponent(document.id)}`,
    document,
    {
      headers: {
        ...buildActorHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }
  );
  return response.data.data;
}
