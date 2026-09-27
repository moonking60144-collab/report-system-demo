import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import demoFaultInjectionRouter from "../../src/routes/demoFaultInjection";
import { reset } from "../../src/infra/faultInjection";

test("Demo fault injection can be updated without X-Demo-Key", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", demoFaultInjectionRouter);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/__demo/fault-injection`;
    reset();

    const update = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, failureRate: 0.25 }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual((await update.json()).data, {
      enabled: true,
      failureRate: 0.25,
      latencyMs: 0,
      dropFieldRate: 0,
    });

    const current = await fetch(url);
    assert.equal(current.status, 200);
    assert.deepEqual((await current.json()).data, {
      enabled: true,
      failureRate: 0.25,
      latencyMs: 0,
      dropFieldRate: 0,
    });
  } finally {
    reset();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
