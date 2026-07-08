import test from "node:test";
import assert from "node:assert/strict";
import { workReportClientPresenceStore } from "../../src/observability/workReportClientPresenceStore";

test("markDisconnected 後 listClients 仍會保留 offline client", () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.1",
    ip: "10.0.0.1",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: null,
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  workReportClientPresenceStore.markDisconnected(clientId, tabId, "10.0.0.1");

  const client = workReportClientPresenceStore
    .listClients()
    .find((item) => item.clientId === clientId && item.tabId === tabId);

  assert.ok(client);
  assert.equal(client.connected, false);
  assert.equal(client.realtimeConnected, false);
  assert.equal(client.status, "offline");
});

test("markDisconnected 不會清掉尚未 ACK 的 debug commands", () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.11",
    ip: "10.0.0.11",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: "boot-disconnect-command",
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  const command = workReportClientPresenceStore.enqueueCommand({
    clientId,
    tabId,
    type: "force-session-expired",
    createdBy: "admin",
  });

  workReportClientPresenceStore.markDisconnected(clientId, tabId, "10.0.0.11");

  assert.deepEqual(
    workReportClientPresenceStore.getCommands(clientId, tabId).map((item) => item.id),
    [command.id]
  );
});

test("presence report 不會覆寫既有 tab 的 clientBootId", () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.2",
    ip: "10.0.0.2",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: "boot-original",
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.2",
    ip: "10.0.0.2",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: "boot-attacker",
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  const client = workReportClientPresenceStore.getClient(clientId, tabId).presence;

  assert.equal(client?.clientBootId, "boot-original");
});

test("debug commands 需由 ACK 刪除，fetch 不會 consume-once", () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.3",
    ip: "10.0.0.3",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: "boot-command",
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  const command = workReportClientPresenceStore.enqueueCommand({
    clientId,
    tabId,
    type: "force-refresh",
    createdBy: "admin",
  });

  assert.deepEqual(
    workReportClientPresenceStore.getCommands(clientId, tabId).map((item) => item.id),
    [command.id]
  );
  assert.deepEqual(
    workReportClientPresenceStore.getCommands(clientId, tabId).map((item) => item.id),
    [command.id]
  );

  assert.equal(workReportClientPresenceStore.ackCommands(clientId, tabId, [command.id]), 1);
  assert.deepEqual(workReportClientPresenceStore.getCommands(clientId, tabId), []);
});

test("未知 presence 的 debug event 不會建立 orphan event bucket", () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;

  workReportClientPresenceStore.recordEvent({
    clientId,
    tabId,
    ts: new Date().toISOString(),
    level: "info",
    category: "task",
    action: "force-refresh",
    summary: "pre-presence event",
  });

  workReportClientPresenceStore.upsertPresence({
    clientId,
    tabId,
    effectiveIp: "10.0.0.4",
    ip: "10.0.0.4",
    forwardedFor: null,
    realIp: null,
    userAgent: "test-agent",
    lastSeenAt: new Date().toISOString(),
    currentPath: "/reports/105/E-105",
    currentFormId: "105",
    currentEntryId: "E-105",
    currentTopView: "detail",
    currentLandingPageKey: null,
    clientBootId: null,
    serverBootIdAtConnect: null,
    deployVersionAtConnect: null,
    realtimeConnected: true,
    connected: true,
  });

  assert.deepEqual(workReportClientPresenceStore.getClient(clientId, tabId).events, []);
});
