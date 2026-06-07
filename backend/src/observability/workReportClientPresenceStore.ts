export type WorkReportClientCommandType =
  | "force-refresh"
  | "force-session-expired"
  | "set-maintenance-message"
  | "clear-maintenance-message";

export interface WorkReportClientPresence {
  clientId: string;
  tabId: string;
  effectiveIp: string | null;
  ip: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  userAgent: string | null;
  connected: boolean;
  connectedAt: string | null;
  lastSeenAt: string;
  lastEventAt: string | null;
  currentPath: string | null;
  currentFormId: string | null;
  currentEntryId: string | null;
  currentTopView: string | null;
  currentLandingPageKey: string | null;
  realtimeConnected: boolean;
  lastSseConnectedAt: string | null;
  lastSseDisconnectedAt: string | null;
  lastAction: string | null;
  lastActionSummary: string | null;
  lastErrorAt: string | null;
  lastErrorSummary: string | null;
  clientBootId: string | null;
  serverBootIdAtConnect: string | null;
  deployVersionAtConnect: string | null;
  maintenanceMessage: string | null;
  status: "online" | "offline" | "stale";
  updatedAt: string;
}

export interface WorkReportClientEventSummary {
  clientId: string;
  tabId: string;
  ts: string;
  level: "info" | "warn" | "error";
  category: "ui" | "api" | "task" | "realtime" | "navigation";
  action: string;
  summary: string;
  formId?: string;
  entryId?: string;
  rowId?: string;
  taskId?: string;
  operationId?: string;
  durationMs?: number;
}

export interface WorkReportClientCommand {
  id: string;
  clientId: string;
  tabId?: string;
  type: WorkReportClientCommandType;
  createdAt: string;
  createdBy: string;
  message?: string;
  reason?: string;
}

interface UpsertWorkReportClientPresenceInput {
  clientId: string;
  tabId: string;
  effectiveIp: string | null;
  ip: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  currentPath: string | null;
  currentFormId: string | null;
  currentEntryId: string | null;
  currentTopView: string | null;
  currentLandingPageKey: string | null;
  realtimeConnected: boolean;
  clientBootId: string | null;
  serverBootIdAtConnect: string | null;
  deployVersionAtConnect: string | null;
  connected?: boolean;
  connectedAt?: string | null;
  lastEventAt?: string | null;
  lastAction?: string | null;
  lastActionSummary?: string | null;
  lastErrorAt?: string | null;
  lastErrorSummary?: string | null;
  maintenanceMessage?: string | null;
  lastSseConnectedAt?: string | null;
  lastSseDisconnectedAt?: string | null;
}

function buildPresenceKey(clientId: string, tabId: string): string {
  return `${clientId}:${tabId}`;
}

function normalizeIpKey(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

class WorkReportClientPresenceStore {
  private readonly presenceByKey = new Map<string, WorkReportClientPresence>();
  private readonly eventsByKey = new Map<string, WorkReportClientEventSummary[]>();
  private readonly commandsByKey = new Map<string, WorkReportClientCommand[]>();
  private readonly maxClients = 2_000;
  private readonly maxEventsPerClient = 50;
  private readonly maxCommandsPerClient = 20;
  private readonly offlineMs = 90_000;
  private readonly staleMs = 10 * 60 * 1000;

  private resolvePresenceStatus(
    lastSeenAt: string,
    connected: boolean
  ): "online" | "offline" | "stale" {
    // connected 由 SSE 連線狀態直接驅動（見 markConnected / markDisconnected）
    // SSE 連著就一定是 online，不再依賴 lastSeenAt 的年齡
    if (connected) {
      return "online";
    }
    const seenAt = Date.parse(lastSeenAt);
    if (Number.isNaN(seenAt)) {
      return "stale";
    }
    const ageMs = Date.now() - seenAt;
    return ageMs <= this.staleMs ? "offline" : "stale";
  }

  /**
   * SSE 連線建立時由 /api/events route 呼叫。
   *
   * 跟 `upsertPresence` 的差異：
   * - `markConnected`：只負責把連線狀態標成 connected=true + 綁 clientBootId 等 SSE 級別欄位；
   *   presence 不存在就建空殼（state 欄位 null）。**不會**動 path / formId / entryId 等 UI state。
   * - `upsertPresence`：由 frontend presence POST 觸發，負責維護 path / formId / entryId / topView 等 UI state。
   *
   * 兩者會對同一條 presence 協作寫入；admin panel 看到「SSE 剛連 + state 還沒 POST 上來」那瞬間，
   * state 欄位會是 null，屬正常短暫狀態（幾百 ms 內 upsertPresence 就會補齊）。
   */
  markConnected(input: {
    clientId: string;
    tabId: string;
    effectiveIp: string | null;
    userAgent: string | null;
    clientBootId: string | null;
    serverBootIdAtConnect: string | null;
    deployVersionAtConnect: string | null;
  }): WorkReportClientPresence {
    this.pruneStaleClients();
    const key = buildPresenceKey(input.clientId, input.tabId);
    const existing = this.presenceByKey.get(key);
    const now = new Date().toISOString();
    const next: WorkReportClientPresence = existing
      ? {
          ...existing,
          connected: true,
          realtimeConnected: true,
          lastSeenAt: now,
          lastSseConnectedAt: now,
          effectiveIp: input.effectiveIp,
          userAgent: input.userAgent ?? existing.userAgent,
          clientBootId: input.clientBootId ?? existing.clientBootId,
          serverBootIdAtConnect: input.serverBootIdAtConnect ?? existing.serverBootIdAtConnect,
          deployVersionAtConnect: input.deployVersionAtConnect ?? existing.deployVersionAtConnect,
          status: "online",
          updatedAt: now,
        }
      : {
          clientId: input.clientId,
          tabId: input.tabId,
          effectiveIp: input.effectiveIp,
          ip: input.effectiveIp,
          forwardedFor: null,
          realIp: null,
          userAgent: input.userAgent,
          connected: true,
          connectedAt: now,
          lastSeenAt: now,
          lastEventAt: null,
          currentPath: null,
          currentFormId: null,
          currentEntryId: null,
          currentTopView: null,
          currentLandingPageKey: null,
          realtimeConnected: true,
          lastSseConnectedAt: now,
          lastSseDisconnectedAt: null,
          lastAction: null,
          lastActionSummary: null,
          lastErrorAt: null,
          lastErrorSummary: null,
          clientBootId: input.clientBootId,
          serverBootIdAtConnect: input.serverBootIdAtConnect,
          deployVersionAtConnect: input.deployVersionAtConnect,
          maintenanceMessage: null,
          status: "online",
          updatedAt: now,
        };
    this.presenceByKey.set(key, next);
    this.enforceClientLimit();
    return next;
  }

  upsertPresence(
    input: UpsertWorkReportClientPresenceInput
  ): WorkReportClientPresence {
    this.pruneStaleClients();
    const key = buildPresenceKey(input.clientId, input.tabId);
    const existing = this.presenceByKey.get(key);
    const now = new Date().toISOString();
    const nextConnected = input.connected ?? existing?.connected ?? true;
    const next: WorkReportClientPresence = {
      clientId: input.clientId,
      tabId: input.tabId,
      effectiveIp: input.effectiveIp,
      ip: input.ip,
      forwardedFor: input.forwardedFor,
      realIp: input.realIp,
      userAgent: input.userAgent,
      connected: nextConnected,
      connectedAt: existing?.connectedAt ?? input.connectedAt ?? now,
      lastSeenAt: input.lastSeenAt,
      lastEventAt: input.lastEventAt ?? existing?.lastEventAt ?? null,
      currentPath: input.currentPath,
      currentFormId: input.currentFormId,
      currentEntryId: input.currentEntryId,
      currentTopView: input.currentTopView,
      currentLandingPageKey: input.currentLandingPageKey,
      realtimeConnected: input.realtimeConnected,
      lastSseConnectedAt:
        input.lastSseConnectedAt ??
        existing?.lastSseConnectedAt ??
        (input.realtimeConnected ? now : null),
      lastSseDisconnectedAt:
        input.lastSseDisconnectedAt ??
        existing?.lastSseDisconnectedAt ??
        (input.realtimeConnected ? null : now),
      lastAction: input.lastAction ?? existing?.lastAction ?? null,
      lastActionSummary: input.lastActionSummary ?? existing?.lastActionSummary ?? null,
      lastErrorAt: input.lastErrorAt ?? existing?.lastErrorAt ?? null,
      lastErrorSummary: input.lastErrorSummary ?? existing?.lastErrorSummary ?? null,
      clientBootId: input.clientBootId,
      serverBootIdAtConnect: input.serverBootIdAtConnect,
      deployVersionAtConnect: input.deployVersionAtConnect,
      maintenanceMessage: input.maintenanceMessage ?? existing?.maintenanceMessage ?? null,
      status: this.resolvePresenceStatus(input.lastSeenAt, nextConnected),
      updatedAt: now,
    };
    this.presenceByKey.set(key, next);
    this.enforceClientLimit();
    return next;
  }

  recordEvent(event: WorkReportClientEventSummary): void {
    this.pruneStaleClients();
    const key = buildPresenceKey(event.clientId, event.tabId);
    const current = this.eventsByKey.get(key) ?? [];
    this.eventsByKey.set(key, [...current.slice(-(this.maxEventsPerClient - 1)), event]);

    const existing = this.presenceByKey.get(key);
    if (!existing) {
      return;
    }
    this.presenceByKey.set(key, {
      ...existing,
      lastEventAt: event.ts,
      lastAction: event.action,
      lastActionSummary: event.summary,
      lastErrorAt: event.level === "error" ? event.ts : existing.lastErrorAt,
      lastErrorSummary: event.level === "error" ? event.summary : existing.lastErrorSummary,
      status: this.resolvePresenceStatus(existing.lastSeenAt, existing.connected),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 收到 broadcast 事件時呼叫：更新 lastEventAt 讓 admin 看到該 client 最近有收事件
   * 沒找到對應 presence 就 no-op（不該是錯誤）
   */
  noteSseEventDelivered(clientId: string, tabId: string): void {
    const key = buildPresenceKey(clientId, tabId);
    const existing = this.presenceByKey.get(key);
    if (!existing) return;
    const now = new Date().toISOString();
    this.presenceByKey.set(key, {
      ...existing,
      lastEventAt: now,
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  markDisconnected(clientId: string, tabId: string, effectiveIp?: string | null): WorkReportClientPresence | null {
    const key = buildPresenceKey(clientId, tabId);
    const existing = this.presenceByKey.get(key);
    if (!existing) {
      return null;
    }
    const now = new Date().toISOString();
    const next: WorkReportClientPresence = {
      ...existing,
      effectiveIp: effectiveIp ?? existing.effectiveIp,
      connected: false,
      realtimeConnected: false,
      lastSeenAt: now,
      lastSseDisconnectedAt: now,
      status: "offline",
      updatedAt: now,
    };
    this.presenceByKey.set(key, next);
    this.commandsByKey.delete(key);
    return next;
  }

  listClients(): WorkReportClientPresence[] {
    this.pruneStaleClients();
    return Array.from(this.presenceByKey.values())
      .map((client) => ({
        ...client,
        status: this.resolvePresenceStatus(client.lastSeenAt, client.connected),
      }))
      .sort((left, right) => {
        const rank = { online: 0, offline: 1, stale: 2 } as const;
        if (rank[left.status] !== rank[right.status]) {
          return rank[left.status] - rank[right.status];
        }
        return right.lastSeenAt.localeCompare(left.lastSeenAt);
      });
  }

  getClient(clientId: string, tabId?: string): {
    presence: WorkReportClientPresence | null;
    events: WorkReportClientEventSummary[];
  } {
    const matched = Array.from(this.presenceByKey.values()).find((item) => {
      if (item.clientId !== clientId) {
        return false;
      }
      if (!tabId) {
        return true;
      }
      return item.tabId === tabId;
    });
    if (!matched) {
      return { presence: null, events: [] };
    }
    const key = buildPresenceKey(matched.clientId, matched.tabId);
    return {
      presence: {
        ...matched,
        status: this.resolvePresenceStatus(matched.lastSeenAt, matched.connected),
      },
      events: (this.eventsByKey.get(key) ?? []).slice().reverse(),
    };
  }

  getSummary(): {
    totalClients: number;
    onlineClients: number;
    clientsWithErrors: number;
    realtimeDisconnectedClients: number;
  } {
    const clients = this.listClients();
    return {
      totalClients: clients.length,
      onlineClients: clients.filter((client) => client.status === "online").length,
      clientsWithErrors: clients.filter((client) => Boolean(client.lastErrorAt)).length,
      realtimeDisconnectedClients: clients.filter((client) => !client.realtimeConnected).length,
    };
  }

  enqueueCommand(
    command: Omit<WorkReportClientCommand, "id" | "createdAt">
  ): WorkReportClientCommand {
    const next: WorkReportClientCommand = {
      ...command,
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };

    const matchingClients = this.listClients().filter((client) => {
      if (client.clientId !== command.clientId) {
        return false;
      }
      if (command.tabId && client.tabId !== command.tabId) {
        return false;
      }
      return true;
    });

    const targetEffectiveIps = Array.from(
      new Set(
        matchingClients
          .map((client) => normalizeIpKey(client.effectiveIp))
          .filter((value): value is string => Boolean(value))
      )
    );

    const commandTargets =
      command.type === "force-session-expired" && targetEffectiveIps.length > 0
        ? this.listClients().filter((client) => {
            const ipKey = normalizeIpKey(client.effectiveIp);
            return ipKey ? targetEffectiveIps.includes(ipKey) : false;
          })
        : matchingClients;

    for (const client of commandTargets) {
      const key = buildPresenceKey(client.clientId, client.tabId);
      const current = this.commandsByKey.get(key) ?? [];
      this.commandsByKey.set(
        key,
        [...current, next].slice(-this.maxCommandsPerClient)
      );

      if (command.type === "set-maintenance-message") {
        this.presenceByKey.set(key, {
          ...client,
          maintenanceMessage: command.message ?? null,
          updatedAt: new Date().toISOString(),
        });
      } else if (command.type === "clear-maintenance-message") {
        this.presenceByKey.set(key, {
          ...client,
          maintenanceMessage: null,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return next;
  }

  consumeCommands(clientId: string, tabId: string): WorkReportClientCommand[] {
    const key = buildPresenceKey(clientId, tabId);
    const commands = this.commandsByKey.get(key) ?? [];
    this.commandsByKey.delete(key);
    return commands;
  }

  private enforceClientLimit(): void {
    if (this.presenceByKey.size <= this.maxClients) {
      return;
    }

    const overflowCount = this.presenceByKey.size - this.maxClients;
    const victims = Array.from(this.presenceByKey.entries())
      .sort((left, right) => {
        const seenCompare = left[1].lastSeenAt.localeCompare(right[1].lastSeenAt);
        if (seenCompare !== 0) {
          return seenCompare;
        }
        return left[1].updatedAt.localeCompare(right[1].updatedAt);
      })
      .slice(0, overflowCount);

    for (const [key] of victims) {
      this.presenceByKey.delete(key);
      this.eventsByKey.delete(key);
      this.commandsByKey.delete(key);
    }
  }

  private pruneStaleClients(): void {
    const threshold = Date.now() - this.staleMs;
    for (const [key, presence] of this.presenceByKey.entries()) {
      const seenAt = Date.parse(presence.lastSeenAt);
      if (!Number.isNaN(seenAt) && seenAt < threshold) {
        this.presenceByKey.delete(key);
        this.eventsByKey.delete(key);
        this.commandsByKey.delete(key);
      }
    }
  }
}

export const workReportClientPresenceStore = new WorkReportClientPresenceStore();
