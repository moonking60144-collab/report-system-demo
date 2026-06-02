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
