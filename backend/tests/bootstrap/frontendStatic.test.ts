import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { env } from "../../src/config/env";
import { setupFrontendStaticServing } from "../../src/bootstrap/frontendStatic";

test("frontend publication exposes a non-cacheable version and never serves HTML as a missing chunk", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-static-"));
  const previous = { enabled: env.SERVE_FRONTEND_FROM_BACKEND, directory: env.FRONTEND_STATIC_DIR };
  fs.mkdirSync(path.join(directory, "assets"));
  fs.writeFileSync(path.join(directory, "index.html"), '<div id="root">current release</div>');
  fs.writeFileSync(path.join(directory, "version.json"), JSON.stringify({ buildId: "build-a" }));
  fs.writeFileSync(path.join(directory, "assets/current.js"), 'export const current = true;');
  Object.assign(env, { SERVE_FRONTEND_FROM_BACKEND: true, FRONTEND_STATIC_DIR: directory });
  const app = express();
  setupFrontendStaticServing(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const version = await fetch(`${base}/version.json`);
    assert.equal(version.headers.get("cache-control"), "no-store");
    assert.deepEqual(await version.json(), { buildId: "build-a" });
    const route = await fetch(`${base}/dev/search`);
    assert.equal(route.status, 200);
    assert.match(route.headers.get("cache-control") ?? "", /no-cache/);
    assert.match(await route.text(), /current release/);
    const current = await fetch(`${base}/assets/current.js`);
    assert.equal(current.status, 200);
    assert.match(current.headers.get("content-type") ?? "", /javascript/);
    const missing = await fetch(`${base}/assets/previous.js`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /current release/);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  } finally {
    Object.assign(env, { SERVE_FRONTEND_FROM_BACKEND: previous.enabled, FRONTEND_STATIC_DIR: previous.directory });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
