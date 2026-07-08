import { EventEmitter } from "events";
import type {
  RagicDefinitionsSyncPayload,
  RealtimeEventPayload,
} from "@shared-types/realtime";

export type {
  RagicDefinitionsSyncPayload,
  RagicDefinitionsSyncStatus,
  RealtimeEventPayload,
  RealtimeEventType,
} from "@shared-types/realtime";

type RealtimeEventListener = (payload: RealtimeEventPayload) => void;
let lastRagicDefinitionsSyncEvent: RealtimeEventPayload | null = null;

class RealtimeEventBus {
  private readonly emitter = new EventEmitter();
  private sequence = 0;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  subscribe(listener: RealtimeEventListener): () => void {
    this.emitter.on("realtime-event", listener);
    return () => {
      this.emitter.off("realtime-event", listener);
    };
  }

  publish(payload: Omit<RealtimeEventPayload, "id" | "occurredAt">): RealtimeEventPayload {
    const eventPayload: RealtimeEventPayload = {
      ...payload,
      id: this.buildEventId(),
      occurredAt: new Date().toISOString(),
    };
    this.emitter.emit("realtime-event", eventPayload);
    return eventPayload;
  }

  private buildEventId(): string {
    this.sequence += 1;
    return `${Date.now()}-${this.sequence}`;
  }
}

export const realtimeEventBus = new RealtimeEventBus();

export function publishWorkReportUpdated(formId: string, entryId: string): RealtimeEventPayload {
  const normalizedFormId = String(formId ?? "").trim();
  const normalizedEntryId = String(entryId ?? "").trim();
  return realtimeEventBus.publish({
    type: "work-report-entry-updated",
    formId: normalizedFormId,
    entryId: normalizedEntryId,
  });
}

export function publishWorkReportFormUpdated(formId: string): RealtimeEventPayload {
  const normalizedFormId = String(formId ?? "").trim();
  return realtimeEventBus.publish({
    type: "work-report-form-updated",
    formId: normalizedFormId,
  });
}

export function publishSystemNoticeForceRefresh(forceRefreshToken: string): RealtimeEventPayload {
  const normalizedToken = String(forceRefreshToken ?? "").trim();
  return realtimeEventBus.publish({
    type: "system-notice-force-refresh",
    forceRefreshToken: normalizedToken,
  });
}

export function publishSystemNoticeContentUpdated(revision: number): RealtimeEventPayload {
  return realtimeEventBus.publish({
    type: "system-notice-content-updated",
    noticeRevision: revision,
  });
}

export function publishRagicDefinitionsSyncStatus(
  payload: RagicDefinitionsSyncPayload
): RealtimeEventPayload {
  const eventPayload = realtimeEventBus.publish({
    type: "ragic-definitions-sync-status",
    ragicDefinitions: payload,
  });
  lastRagicDefinitionsSyncEvent = eventPayload;
  return eventPayload;
}

export function getLastRagicDefinitionsSyncStatus(): RealtimeEventPayload | null {
  return lastRagicDefinitionsSyncEvent;
}
