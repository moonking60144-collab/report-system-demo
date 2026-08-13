import type { DevAiSendMessageRequest } from "@shared-types/ragicDefinitions";

export type DevAiMessagePayload = Omit<DevAiSendMessageRequest, "clientMessageId">;

export interface DevAiMessageSubmission {
  clientMessageId: string;
  requestKey: string;
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJsonValue(item)])
  );
}

function createDevAiClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `devmsg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function resolveDevAiMessageSubmission(
  current: DevAiMessageSubmission | null,
  threadId: string,
  payload: DevAiMessagePayload
): DevAiMessageSubmission {
  const requestKey = JSON.stringify(normalizeJsonValue({ threadId, payload }));
  if (current?.requestKey === requestKey) {
    return current;
  }
  return {
    clientMessageId: createDevAiClientMessageId(),
    requestKey,
  };
}
