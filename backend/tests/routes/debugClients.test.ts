import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import debugClientsRouter from "../../src/routes/debugClients";
import { errorHandler } from "../../src/middleware/errorHandler";
import { workReportClientPresenceStore } from "../../src/observability/workReportClientPresenceStore";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", debugClientsRouter);
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("presence report 不回傳 commands，command fetch 需符合 clientBootId 並由 ACK 刪除", async () => {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientId = `presence-client-${uniqueSuffix}`;
  const tabId = `presence-tab-${uniqueSuffix}`;
  const realBootId = `boot-real-${uniqueSuffix}`;
  const attackerBootId = `boot-attacker-${uniqueSuffix}`;

  await withTestServer(async (baseUrl) => {
    const presenceResponse = await fetch(`${baseUrl}/api/debug/clients/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        tabId,
        clientBootId: realBootId,
        currentPath: "/reports/105/E-105",
        realtimeConnected: true,
      }),
    });
    assert.equal(presenceResponse.status, 200);
    const presencePayload = (await presenceResponse.json()) as {
      data: { presence: { clientBootId: string }; commands?: unknown };
    };
    assert.equal(presencePayload.data.presence.clientBootId, realBootId);
    assert.equal("commands" in presencePayload.data, false);

    const command = workReportClientPresenceStore.enqueueCommand({
      clientId,
      tabId,
      type: "force-refresh",
      createdBy: "admin",
    });

    const attackerPresenceResponse = await fetch(`${baseUrl}/api/debug/clients/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        tabId,
        clientBootId: attackerBootId,
        currentPath: "/reports/105/E-105",
        realtimeConnected: true,
      }),
    });
    assert.equal(attackerPresenceResponse.status, 200);

    const attackerFetchResponse = await fetch(`${baseUrl}/api/debug/clients/commands/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, tabId, clientBootId: attackerBootId }),
    });
    assert.equal(attackerFetchResponse.status, 403);

    const fetchCommands = async () => {
      const response = await fetch(`${baseUrl}/api/debug/clients/commands/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, tabId, clientBootId: realBootId }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { data: { commands: Array<{ id: string }> } };
    };

    assert.deepEqual(
      (await fetchCommands()).data.commands.map((item) => item.id),
      [command.id]
    );
    assert.deepEqual(
      (await fetchCommands()).data.commands.map((item) => item.id),
      [command.id]
    );

    const missingBootDisconnectResponse = await fetch(`${baseUrl}/api/debug/clients/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, tabId }),
    });
    assert.equal(missingBootDisconnectResponse.status, 400);
    assert.deepEqual(
      (await fetchCommands()).data.commands.map((item) => item.id),
      [command.id]
    );

    const attackerDisconnectResponse = await fetch(`${baseUrl}/api/debug/clients/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, tabId, clientBootId: attackerBootId }),
    });
    assert.equal(attackerDisconnectResponse.status, 403);
    assert.deepEqual(
      (await fetchCommands()).data.commands.map((item) => item.id),
      [command.id]
    );

    const realDisconnectResponse = await fetch(`${baseUrl}/api/debug/clients/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, tabId, clientBootId: realBootId }),
    });
    assert.equal(realDisconnectResponse.status, 202);
    const disconnectPayload = (await realDisconnectResponse.json()) as {
      data: { presence: { connected: boolean; realtimeConnected: boolean; status: string } };
    };
    assert.equal(disconnectPayload.data.presence.connected, false);
    assert.equal(disconnectPayload.data.presence.realtimeConnected, false);
    assert.equal(disconnectPayload.data.presence.status, "offline");
    assert.deepEqual(
      (await fetchCommands()).data.commands.map((item) => item.id),
      [command.id]
    );

    const ackResponse = await fetch(`${baseUrl}/api/debug/clients/commands/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        tabId,
        clientBootId: realBootId,
        commandIds: [command.id],
      }),
    });
    assert.equal(ackResponse.status, 200);

    assert.deepEqual((await fetchCommands()).data.commands, []);
  });
});
