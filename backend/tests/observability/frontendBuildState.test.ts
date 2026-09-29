import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFrontendBuildReader } from "../../src/observability/frontendBuildState";

test("frontend identity follows the published artifact without restarting the backend", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-build-"));
  let now = 0;
  const read = createFrontendBuildReader(directory, () => now);
  const manifest = path.join(directory, "version.json");
  try {
    fs.writeFileSync(manifest, JSON.stringify({ buildId: "build-a" }));
    assert.equal(read(), "build-a");
    fs.writeFileSync(manifest, JSON.stringify({ buildId: "build-b" }));
    assert.equal(read(), "build-a", "share one cached read across SSE clients");
    now += 1_001;
    assert.equal(read(), "build-b", "the same reader observes the newly published frontend");
    fs.writeFileSync(manifest, "incomplete publication");
    now += 1_001;
    assert.equal(read(), null);
    fs.writeFileSync(manifest, JSON.stringify({ buildId: "build-c" }));
    now += 1_001;
    assert.equal(read(), "build-c");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unconfigured frontend does not read a manifest from the backend cwd", () => {
  assert.equal(createFrontendBuildReader("")(), null);
});
