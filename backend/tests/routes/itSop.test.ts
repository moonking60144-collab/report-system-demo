import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import itSopRouter from "../../src/routes/itSop";
import { errorHandler } from "../../src/middleware/errorHandler";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", itSopRouter);
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

test("PUT /api/it/sop-documents/:documentId 未帶 admin token 會被拒絕", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/sop-documents/wk-e-pc-001`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });
});

test("GET /api/it/sop-documents/:documentId 未帶 admin token 會被拒絕", async () => {
  await withTestServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/sop-documents/wk-e-pc-001`);
    assert.equal(res.status, 401);
  });
});
