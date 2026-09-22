import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import realtimeEventsRouter, {
  closeRealtimeSseConnections,
  getRealtimeSseStats,
} from "../../src/routes/realtimeEvents";
import { workReportClientPresenceStore } from "../../src/observability/workReportClientPresenceStore";

test("shutdown 主動結束 SSE 並清除 heartbeat、event listener 與 presence", async () => {
  const app = express();
  app.use("/api", realtimeEventsRouter);
  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(
      `${baseUrl}/api/events?clientId=shutdown-client&tabId=shutdown-tab&bootId=shutdown-boot`,
      { signal: AbortSignal.timeout(3_000) }
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    assert.match(Buffer.from(firstChunk.value).toString("utf8"), /event: ready/);
    assert.deepEqual(getRealtimeSseStats(), {
      acceptingConnections: true,
      activeConnectionCount: 1,
      activeHeartbeatCount: 1,
      activeEventListenerCount: 1,
    });
    assert.equal(
      workReportClientPresenceStore.getClient("shutdown-client", "shutdown-tab").presence
        ?.connected,
      true
    );

    assert.equal(closeRealtimeSseConnections(), 1);

    const remainingChunks: Uint8Array[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      remainingChunks.push(chunk.value);
    }
    const remainingText = Buffer.concat(remainingChunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8"
    );
    assert.match(remainingText, /event: shutdown/);
    assert.deepEqual(getRealtimeSseStats(), {
      acceptingConnections: false,
      activeConnectionCount: 0,
      activeHeartbeatCount: 0,
      activeEventListenerCount: 0,
    });
    assert.equal(
      workReportClientPresenceStore.getClient("shutdown-client", "shutdown-tab").presence
        ?.connected,
      false
    );

    const rejected = await fetch(`${baseUrl}/api/events`);
    assert.equal(rejected.status, 503);
    assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, "SERVER_SHUTTING_DOWN");
  } finally {
    closeRealtimeSseConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
