import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRagicDefinitionsSourceRouter } from "../../src/routes/ragicDefinitionsSource";
import { errorHandler } from "../../src/middleware/errorHandler";
import { exportRagicDefinitions } from "../../src/services/dev/ragicDefinitionsExportService";
import { createRagicDefinitionsReadService } from "../../src/services/dev/ragicDefinitionsReadService";

const SOURCE_TOKEN = "source-token-with-at-least-thirty-two-characters";

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "ragic-source-api-test-"));
  const builderRoot = join(root, "builder");
  const definitionsRoot = join(root, "ragic-definitions");
  const formDir = join(builderRoot, "default", "devtest");
  await mkdir(formDir, { recursive: true });
  await writeFile(
    join(formDir, "51_Sheet1_index.nui"),
    [
      "N,Source API Test",
      "D,1,2,1036615,編號,noDup=true&f=A1+1",
      "PRE_WORKFLOW_START",
      "log.println(\"source\");",
    ].join("\n"),
    "utf-8"
  );
  const exported = exportRagicDefinitions({
    builderRoot,
    outDir: definitionsRoot,
    namespaces: "default",
  });
  const service = createRagicDefinitionsReadService({
    definitionsRoot,
    repoRoot: root,
    cacheTtlMs: 0,
  });
  return { root, exported, service };
}

async function withServer(
  options: Parameters<typeof createRagicDefinitionsSourceRouter>[0],
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(
    "/api/integrations/ragic-definitions",
    createRagicDefinitionsSourceRouter(options)
  );
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, () => resolve(next));
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function authHeaders(etag?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${SOURCE_TOKEN}`,
    ...(etag ? { "If-None-Match": etag } : {}),
  };
}

test("source API：未設定專用 token 時 fail closed", async () => {
  const fixture = await buildFixture();
  try {
    await withServer(
      { service: fixture.service, sourceToken: "" },
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/state`
        );
        assert.equal(response.status, 503);
        assert.equal(
          (await response.json() as { error: { code: string } }).error.code,
          "RAGIC_DEFINITIONS_SOURCE_API_DISABLED"
        );
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source API：missing/invalid token 均不可讀取", async () => {
  const fixture = await buildFixture();
  try {
    await withServer(
      { service: fixture.service, sourceToken: SOURCE_TOKEN },
      async (baseUrl) => {
        const url = `${baseUrl}/api/integrations/ragic-definitions/state`;
        const missing = await fetch(url);
        assert.equal(missing.status, 401);
        const invalid = await fetch(url, {
          headers: { Authorization: "Bearer wrong-token" },
        });
        assert.equal(invalid.status, 401);
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source API：state 不洩漏路徑/Git，snapshot 支援 ETag 304", async () => {
  const fixture = await buildFixture();
  try {
    await withServer(
      { service: fixture.service, sourceToken: SOURCE_TOKEN },
      async (baseUrl) => {
        const stateResponse = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/state`,
          { headers: authHeaders() }
        );
        assert.equal(stateResponse.status, 200);
        const stateText = await stateResponse.text();
        const state = JSON.parse(stateText) as {
          data: {
            contract: string;
            current: { revision: string };
          };
        };
        assert.equal(state.data.contract, "ragic-definitions-source-v1");
        assert.equal(state.data.current.revision, fixture.exported.revision);
        assert.doesNotMatch(stateText, /definitionsRoot|gitStatus|repoRoot/);
        const stateEtag = stateResponse.headers.get("etag");
        assert.ok(stateEtag);
        const unchangedState = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/state`,
          { headers: authHeaders(stateEtag ?? undefined) }
        );
        assert.equal(unchangedState.status, 304);

        const snapshotResponse = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          { headers: authHeaders() }
        );
        assert.equal(snapshotResponse.status, 200);
        assert.equal(
          snapshotResponse.headers.get("x-ragic-definitions-revision"),
          fixture.exported.revision
        );
        assert.match(
          snapshotResponse.headers.get("vary") ?? "",
          /Accept-Encoding/i
        );
        const etag = snapshotResponse.headers.get("etag");
        assert.ok(etag);
        const snapshotText = await snapshotResponse.text();
        assert.equal(
          createHash("sha256").update(snapshotText).digest("hex"),
          snapshotResponse.headers.get(
            "x-ragic-definitions-payload-sha256"
          )
        );
        const snapshot = JSON.parse(snapshotText) as {
          revision: string;
          forms: Array<{ form: { formPath: string } }>;
        };
        assert.equal(snapshot.revision, fixture.exported.revision);
        assert.equal(
          snapshot.forms[0]?.form.formPath,
          "default/devtest/51"
        );

        const identityResponse = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          {
            headers: {
              ...authHeaders(),
              "Accept-Encoding": "identity",
            },
          }
        );
        assert.equal(identityResponse.status, 200);
        assert.equal(identityResponse.headers.get("content-encoding"), null);
        assert.equal(
          (await identityResponse.json() as { revision: string }).revision,
          fixture.exported.revision
        );

        const gzipDisabled = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          {
            headers: {
              ...authHeaders(),
              "Accept-Encoding": "gzip;q=0, identity;q=1",
            },
          }
        );
        assert.equal(gzipDisabled.status, 200);
        assert.equal(gzipDisabled.headers.get("content-encoding"), null);
        assert.equal(
          (await gzipDisabled.json() as { revision: string }).revision,
          fixture.exported.revision
        );

        const unacceptable = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          {
            headers: {
              ...authHeaders(),
              "Accept-Encoding": "gzip;q=0, identity;q=0, *;q=0",
            },
          }
        );
        assert.equal(unacceptable.status, 406);
        assert.equal(
          (await unacceptable.json() as { error: { code: string } }).error.code,
          "RAGIC_DEFINITIONS_ENCODING_NOT_ACCEPTABLE"
        );

        const unchanged = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          { headers: authHeaders(etag ?? undefined) }
        );
        assert.equal(unchanged.status, 304);
        assert.equal(await unchanged.text(), "");

        const head = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          { method: "HEAD", headers: authHeaders() }
        );
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-encoding"), "gzip");
        assert.equal(await head.text(), "");
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source API：可列出與下載 retained revision，非法或不存在 revision 有 typed error", async () => {
  const fixture = await buildFixture();
  try {
    await withServer(
      { service: fixture.service, sourceToken: SOURCE_TOKEN },
      async (baseUrl) => {
        const listResponse = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshots`,
          { headers: authHeaders() }
        );
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json() as {
          data: Array<{ revision: string }>;
        };
        assert.equal(
          list.data.some((item) => item.revision === fixture.exported.revision),
          true
        );

        const revisionHex = fixture.exported.revision.slice("sha256:".length);
        const historical = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshots/${revisionHex}`,
          { headers: authHeaders() }
        );
        assert.equal(historical.status, 200);
        assert.equal(
          (await historical.json() as { revision: string }).revision,
          fixture.exported.revision
        );

        const invalid = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshots/not-a-hash`,
          { headers: authHeaders() }
        );
        assert.equal(invalid.status, 400);
        const missing = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshots/${"f".repeat(64)}`,
          { headers: authHeaders() }
        );
        assert.equal(missing.status, 404);

        const mutation = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/state`,
          { method: "POST", headers: authHeaders() }
        );
        assert.equal(mutation.status, 404);
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source API：runtime cache 不存在時可從 manifest v2 非同步重建 current snapshot", async () => {
  const fixture = await buildFixture();
  try {
    await rm(join(fixture.root, "ragic-definitions", ".snapshots"), {
      recursive: true,
      force: true,
    });
    await withServer(
      { service: fixture.service, sourceToken: SOURCE_TOKEN },
      async (baseUrl) => {
        const response = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/snapshot`,
          { headers: authHeaders() }
        );
        assert.equal(response.status, 200);
        assert.equal(
          (await response.json() as { revision: string }).revision,
          fixture.exported.revision
        );
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source API：HEAD、304、406 不載入 snapshot body", async () => {
  const fixture = await buildFixture();
  let currentLoadCount = 0;
  let historicalLoadCount = 0;
  try {
    await withServer(
      {
        service: {
          ...fixture.service,
          loadCurrentSnapshot: async () => {
            currentLoadCount += 1;
            return fixture.service.loadCurrentSnapshot();
          },
          loadSnapshot: async (revision: string) => {
            historicalLoadCount += 1;
            return fixture.service.loadSnapshot(revision);
          },
        },
        sourceToken: SOURCE_TOKEN,
      },
      async (baseUrl) => {
        const snapshotUrl = `${baseUrl}/api/integrations/ragic-definitions/snapshot`;
        const head = await fetch(snapshotUrl, {
          method: "HEAD",
          headers: authHeaders(),
        });
        assert.equal(head.status, 200);

        const state = await fetch(
          `${baseUrl}/api/integrations/ragic-definitions/state`,
          { headers: authHeaders() }
        );
        const etag = state.headers.get("etag");
        assert.ok(etag);
        const unchanged = await fetch(snapshotUrl, {
          headers: authHeaders(etag ?? undefined),
        });
        assert.equal(unchanged.status, 304);

        const unacceptable = await fetch(snapshotUrl, {
          headers: {
            ...authHeaders(),
            "Accept-Encoding": "gzip;q=0, identity;q=0, *;q=0",
          },
        });
        assert.equal(unacceptable.status, 406);

        const revisionHex = fixture.exported.revision.slice("sha256:".length);
        const historicalUrl = `${baseUrl}/api/integrations/ragic-definitions/snapshots/${revisionHex}`;
        const historicalHead = await fetch(historicalUrl, {
          method: "HEAD",
          headers: authHeaders(),
        });
        assert.equal(historicalHead.status, 200);
        const historicalEtag = historicalHead.headers.get("etag");
        assert.ok(historicalEtag);
        const historicalUnchanged = await fetch(historicalUrl, {
          headers: authHeaders(historicalEtag ?? undefined),
        });
        assert.equal(historicalUnchanged.status, 304);
        const historicalUnacceptable = await fetch(historicalUrl, {
          headers: {
            ...authHeaders(),
            "Accept-Encoding": "gzip;q=0, identity;q=0, *;q=0",
          },
        });
        assert.equal(historicalUnacceptable.status, 406);

        assert.equal(currentLoadCount, 0);
        assert.equal(historicalLoadCount, 0);
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
