interface EditingLockRecord {
  formId: string;
  entryId: string;
  rowId: string;
  ownerSessionId: string;
  state: string;
  lockAcquiredAt: string;
  lastHeartbeatAt: string;
  lockVersion: number;
}

export interface EditingPresenceSnapshot {
  hasOtherEditors: boolean;
  otherEditorCount: number;
  observedAt: string;
  canEdit: boolean;
  isCurrentSessionOwner: boolean;
  lockAcquiredAt?: string;
  idleMs?: number;
  lockVersion?: number;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_TIMEOUT_MS = 5 * 60_000;
const ROW_LOCK_DEBUG = process.env.NODE_ENV !== "production";

class WorkReportEditingPresenceService {
  private readonly locks = new Map<string, EditingLockRecord>();

  private logDebug(
    action: string,
    payload: Record<string, unknown>
  ): void {
    if (!ROW_LOCK_DEBUG) {
      return;
    }
    console.info("[row-lock-debug]", {
      action,
      ...payload,
    });
  }

  upsertPresence(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId: string;
    active: boolean;
    state?: string;
  }): EditingPresenceSnapshot {
    const normalized = this.normalizeInput(input);
    this.pruneStale();
    const key = this.buildKey(normalized.formId, normalized.entryId, normalized.rowId);
    if (!key) {
      return this.buildUnlockedSnapshot();
    }
    const existing = this.locks.get(key);
    this.logDebug("upsert-begin", {
      key,
      formId: normalized.formId,
      entryId: normalized.entryId,
      rowId: normalized.rowId,
      sessionId: normalized.sessionId,
      active: normalized.active,
      existingOwnerSessionId: existing?.ownerSessionId ?? null,
      existingLockVersion: existing?.lockVersion ?? null,
    });

    if (!normalized.active) {
      if (existing?.ownerSessionId === normalized.sessionId) {
        this.locks.delete(key);
      }
      const snapshot = this.getSnapshot({
        formId: normalized.formId,
        entryId: normalized.entryId,
        rowId: normalized.rowId,
        sessionId: normalized.sessionId,
      });
      this.logDebug("upsert-release", {
        key,
        sessionId: normalized.sessionId,
        snapshot,
      });
      return snapshot;
    }

    const now = new Date().toISOString();
    if (!existing) {
      this.locks.set(key, {
        formId: normalized.formId,
        entryId: normalized.entryId,
        rowId: normalized.rowId!,
        ownerSessionId: normalized.sessionId,
        state: normalized.state ?? "editing",
        lockAcquiredAt: now,
        lastHeartbeatAt: now,
        lockVersion: 1,
      });
      const snapshot = this.getSnapshot({
        formId: normalized.formId,
        entryId: normalized.entryId,
        rowId: normalized.rowId,
        sessionId: normalized.sessionId,
      });
      this.logDebug("upsert-acquire-first", {
        key,
        ownerSessionId: normalized.sessionId,
        snapshot,
      });
      return snapshot;
    }

    if (existing.ownerSessionId === normalized.sessionId) {
      this.locks.set(key, {
        ...existing,
        state: normalized.state ?? existing.state,
        lastHeartbeatAt: now,
      });
    }

    const snapshot = this.getSnapshot({
      formId: normalized.formId,
      entryId: normalized.entryId,
      rowId: normalized.rowId,
      sessionId: normalized.sessionId,
    });
    this.logDebug("upsert-finish", {
      key,
      sessionId: normalized.sessionId,
      existingOwnerSessionId: existing?.ownerSessionId ?? null,
      snapshot,
    });
    return snapshot;
  }

  getSnapshot(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId?: string;
  }): EditingPresenceSnapshot {
    const normalizedFormId = String(input.formId ?? "").trim();
    const normalizedEntryId = String(input.entryId ?? "").trim();
    const normalizedRowId = String(input.rowId ?? "").trim();
    const normalizedSessionId = String(input.sessionId ?? "").trim();
    this.pruneStale();
    if (!normalizedRowId) {
      const otherEditorCount = Array.from(this.locks.values()).filter(
        (record) =>
          record.formId === normalizedFormId &&
          record.entryId === normalizedEntryId &&
          record.ownerSessionId !== normalizedSessionId
      ).length;
      return {
        hasOtherEditors: otherEditorCount > 0,
        otherEditorCount,
        observedAt: new Date().toISOString(),
        canEdit: true,
        isCurrentSessionOwner: false,
      };
    }
    const key = this.buildKey(normalizedFormId, normalizedEntryId, normalizedRowId);

    const existing = this.locks.get(key);
    const isCurrentSessionOwner = Boolean(normalizedSessionId) && existing?.ownerSessionId === normalizedSessionId;
    const hasOtherEditors = Boolean(existing) && !isCurrentSessionOwner;
    const idleMs = existing ? Math.max(0, Date.now() - Date.parse(existing.lastHeartbeatAt)) : undefined;

    const snapshot = {
      hasOtherEditors,
      otherEditorCount: hasOtherEditors ? 1 : 0,
      observedAt: new Date().toISOString(),
      canEdit: !existing || isCurrentSessionOwner,
      isCurrentSessionOwner,
      ...(existing
        ? {
            lockAcquiredAt: existing.lockAcquiredAt,
            idleMs,
            lockVersion: existing.lockVersion,
          }
        : {}),
    };
    this.logDebug("snapshot", {
      key,
      formId: normalizedFormId,
      entryId: normalizedEntryId,
      rowId: normalizedRowId,
      sessionId: normalizedSessionId || null,
      existingOwnerSessionId: existing?.ownerSessionId ?? null,
      snapshot,
    });
    return snapshot;
  }

  assertOwnerOrAvailable(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId?: string;
  }): EditingPresenceSnapshot {
    const snapshot = this.getSnapshot(input);
    return snapshot;
  }

  assertLockVersion(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId?: string;
    expectedLockVersion?: number;
  }): void {
    const snapshot = this.getSnapshot(input);
    if (!snapshot.isCurrentSessionOwner || !snapshot.lockVersion) {
      return;
    }
    if (input.expectedLockVersion === undefined || input.expectedLockVersion === null) {
      throw new Error("LOCK_VERSION_MISMATCH");
    }
    if (snapshot.lockVersion === input.expectedLockVersion) {
      return;
    }
    throw new Error("LOCK_VERSION_MISMATCH");
  }

  getHeartbeatIntervalMs(): number {
    return HEARTBEAT_INTERVAL_MS;
  }

  private normalizeInput(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    sessionId: string;
    active: boolean;
    state?: string;
  }) {
    return {
      formId: String(input.formId ?? "").trim(),
      entryId: String(input.entryId ?? "").trim(),
      rowId: String(input.rowId ?? "").trim() || undefined,
      sessionId: String(input.sessionId ?? "").trim(),
      active: Boolean(input.active),
      state: String(input.state ?? "").trim() || undefined,
    };
  }

  private buildKey(formId: string, entryId: string, rowId?: string): string {
    const normalizedRowId = String(rowId ?? "").trim();
    if (!normalizedRowId) {
      return "";
    }
    return `${formId}:${entryId}:${normalizedRowId}`;
  }

  private buildUnlockedSnapshot(): EditingPresenceSnapshot {
    return {
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: new Date().toISOString(),
      canEdit: true,
      isCurrentSessionOwner: false,
    };
  }

  private pruneStale(): void {
    const now = Date.now();
    for (const [key, record] of this.locks.entries()) {
      const heartbeatAt = Date.parse(record.lastHeartbeatAt);
      if (Number.isNaN(heartbeatAt) || now - heartbeatAt >= STALE_TIMEOUT_MS) {
        this.locks.delete(key);
      }
    }
  }
}

export const workReportEditingPresenceService = new WorkReportEditingPresenceService();
