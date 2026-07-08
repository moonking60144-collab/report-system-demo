import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDevRagicDefinitionsRouter } from "../../src/routes/devRagicDefinitions";
import { createRagicDefinitionsReadService } from "../../src/services/dev/ragicDefinitionsReadService";
import { createRagicFormulaPatchDryRunService } from "../../src/services/dev/ragicFormulaPatchDryRunService";
import { createRagicFormulaPatchApplyService } from "../../src/services/dev/ragicFormulaPatchApplyService";
import type { RagicDefinitionsVersionControlService } from "../../src/services/dev/ragicDefinitionsVersionControlService";
import { createRagicDefinitionsReExportService } from "../../src/services/dev/ragicDefinitionsReExportService";
import type { RagicDefinitionsExportResult } from "../../src/services/dev/ragicDefinitionsExportService";
import type { RagicFormulaSiblingsService } from "../../src/services/dev/ragicFormulaSiblingsService";
import type { RagicFormulaAiSuggestionService } from "../../src/services/dev/ai/ragicFormulaAiSuggestionService";
import type { DevAiChatService } from "../../src/services/dev/ai/devAiChatService";
import type { DevAiFeedbackService } from "../../src/services/dev/ai/devAiFeedbackService";
import type { DevAiKnowledgeCompilerService } from "../../src/services/dev/ai/devAiKnowledgeCompilerService";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";

const VALID_TOKEN = "test-token-valid";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function colToLetters(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out || "?";
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "ragic-definitions-test-"));
  const builderRoot = join(root, "builder");
  const formDir = join(root, "forms", "default", "devtest", "51");
  const nuiDir = join(builderRoot, "default", "devtest");
  const nuiFilePath = join(nuiDir, "51_Sheet51_index.nui");
  await mkdir(join(formDir, "workflows"), { recursive: true });
  await mkdir(nuiDir, { recursive: true });
  await writeJson(join(root, "manifest.json"), {
    schemaVersion: 1,
    namespaceFilter: { mode: "include", namespaces: ["default"] },
    counts: { forms: 1, fields: 2, formulas: 1, workflows: 1 },
  });
  await writeJson(join(formDir, "form.json"), {
    schemaVersion: 1,
    formPath: "default/devtest/51",
    formName: "luo test",
    nuiFile: "51_Sheet51_index.nui",
    sourceEncoding: "utf-8",
    sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
    counts: { fields: 2, formulas: 1, workflows: 1 },
  });
  await writeJson(join(formDir, "fields.json"), [
    {
      fieldId: "1036615",
      fieldName: "編號",
      kind: "D",
      position: "A2",
      sourceLine: 13,
      attrs: { text: "1" },
    },
    {
      fieldId: "1036641",
      fieldName: "測試",
      kind: "D",
      position: "G6",
      sourceLine: 24,
      attrs: { text: "1" },
    },
  ]);
  await writeJson(join(formDir, "formulas.json"), [
    {
      fieldId: "1036641",
      fieldName: "測試",
      position: "G6",
      formulaKind: "formula",
      nuiFormula: "F6*D6+123456",
      displayFormula: "F6*D6+123456",
      sourceLine: 24,
    },
  ]);
  await writeFile(
    join(formDir, "workflows", "post.js"),
    "var entry = param.getUpdatedEntry();\n",
    "utf-8"
  );
  const nuiLines = Array.from({ length: 26 }, (_, index) => `# filler ${index + 1}`);
  nuiLines[12] = "D,1,2,1036615,編號,text=1";
  nuiLines[23] = "D,7,6,1036641,測試,text=1&f=F6*D6+123456";
  await writeFile(
    nuiFilePath,
    `${nuiLines.join("\n")}\n`,
    "utf-8"
  );
  return { root, builderRoot, formDir, nuiFilePath };
}

async function reexportFixtureDefinitions(
  fixture: Awaited<ReturnType<typeof buildFixture>>
): Promise<{ stdout: string; stderr: string }> {
  const content = await readFile(fixture.nuiFilePath, "utf-8");
  const formulas = content
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.startsWith("D,")) return [];
      const parts = line.split(",");
      if (parts.length < 6) return [];
      const rawFormula =
        parts
          .slice(5)
          .join(",")
          .split("&")
          .find((part) => part.startsWith("f="))
          ?.slice(2) ?? "";
      if (!rawFormula) return [];
      const formula = decodeURIComponent(rawFormula);
      return [
        {
          fieldId: parts[3],
          fieldName: parts[4],
          position: `${colToLetters(Number(parts[1]))}${parts[2]}`,
          formulaKind: "formula" as const,
          nuiFormula: formula,
          displayFormula: formula,
          sourceLine: index + 1,
        },
      ];
    })
    .sort((a, b) => Number(a.fieldId) - Number(b.fieldId));
  await writeJson(join(fixture.formDir, "formulas.json"), formulas);
  return { stdout: "[test] exported", stderr: "" };
}

async function reexportFixtureDefinitionsSummary(
  fixture: Awaited<ReturnType<typeof buildFixture>>
): Promise<RagicDefinitionsExportResult> {
  await reexportFixtureDefinitions(fixture);
  return {
    forms: 1,
    fields: 2,
    formulas: 1,
    workflows: 1,
    namespaces: "default",
    outDir: fixture.root,
  };
}

function versionStatus(
  fixture: Awaited<ReturnType<typeof buildFixture>>,
  patch: Partial<Awaited<ReturnType<RagicDefinitionsVersionControlService["getStatus"]>>> = {}
): Awaited<ReturnType<RagicDefinitionsVersionControlService["getStatus"]>> {
  return {
    gitAvailable: true,
    repoRoot: fixture.root,
    definitionsRoot: fixture.root,
    definitionsPathspec: "ragic-definitions",
    branch: "main",
    lastCommit: "abc1234",
    remoteTrackingBranch: "origin/main",
    ahead: 0,
    behind: 0,
    clean: true,
    definitionsClean: true,
    canCommit: false,
    canPush: false,
    canAutoSyncPush: false,
    entries: [],
    definitionsEntries: [],
    outsideEntries: [],
    blockers: [],
    warnings: [],
    error: null,
    ...patch,
  };
}

function verifyToken(header: string | undefined) {
  const raw = String(header ?? "").trim();
  if (!raw) throw new HttpError(401, "no token", "NOTICE_TOKEN_MISSING");
  const [scheme, token] = raw.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || token !== VALID_TOKEN) {
    throw new HttpError(401, "bad token", "NOTICE_TOKEN_INVALID");
  }
  return { username: "dev-user", expiresAt: "2099-01-01T00:00:00.000Z" };
}

async function withTestServer(
  fixture: Awaited<ReturnType<typeof buildFixture>>,
  run: (baseUrl: string) => Promise<void>,
  overrides: {
    versionControlService?: RagicDefinitionsVersionControlService;
    formulaSiblingsService?: RagicFormulaSiblingsService;
    formulaAiSuggestionService?: RagicFormulaAiSuggestionService;
    devAiChatService?: DevAiChatService;
    devAiFeedbackService?: DevAiFeedbackService;
    devAiKnowledgeCompilerService?: DevAiKnowledgeCompilerService;
    reExport?: {
      exportDefinitions?: (params: {
        builderRoot: string;
        definitionsRoot: string;
        namespaces: string;
      }) => RagicDefinitionsExportResult | Promise<RagicDefinitionsExportResult>;
    };
  } = {}
) {
  const app = express();
  app.use(express.json());
  const service = createRagicDefinitionsReadService({
    definitionsRoot: fixture.root,
    repoRoot: fixture.root,
  });
  const formulaPatchDryRunService = createRagicFormulaPatchDryRunService({
    definitionsService: service,
    builderRoot: fixture.builderRoot,
  });
  app.use(
    "/api/dev/ragic-definitions",
    createDevRagicDefinitionsRouter({
      service,
      formulaPatchDryRunService,
      formulaPatchApplyService: createRagicFormulaPatchApplyService({
        definitionsService: service,
        dryRunService: formulaPatchDryRunService,
        builderRoot: fixture.builderRoot,
        backupRoot: join(fixture.root, "backups"),
        auditFilePath: join(fixture.root, "audit.jsonl"),
        exportDefinitions: () => reexportFixtureDefinitions(fixture),
      }),
      versionControlService: overrides.versionControlService,
      formulaSiblingsService: overrides.formulaSiblingsService,
      formulaAiSuggestionService: overrides.formulaAiSuggestionService,
      devAiChatService: overrides.devAiChatService,
      devAiFeedbackService: overrides.devAiFeedbackService,
      devAiKnowledgeCompilerService: overrides.devAiKnowledgeCompilerService,
      reExportService: createRagicDefinitionsReExportService({
        definitionsService: service,
        versionControlService: overrides.versionControlService,
        builderRoot: fixture.builderRoot,
        exportDefinitions: overrides.reExport?.exportDefinitions,
      }),
      verifyToken,
    })
  );
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, () => resolve(next));
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

test("GET state 無 token 回 401", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/state`);
      assert.equal(res.status, 401);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST ai/formula/suggest 無 token 會先被 Dev auth 擋下", async () => {
  const fixture = await buildFixture();
  let called = false;
  const formulaAiSuggestionService: RagicFormulaAiSuggestionService = {
    async suggestFormula() {
      called = true;
      throw new Error("should not be called");
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/formula/suggest`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            formPath: "default/devtest/51",
            fieldId: "1036641",
            formulaKind: "formula",
            objective: "測試",
          }),
        });
        assert.equal(res.status, 401);
        assert.equal(called, false);
      },
      { formulaAiSuggestionService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST ai/chat 無 token 會先被 Dev auth 擋下", async () => {
  const fixture = await buildFixture();
  let called = false;
  const devAiChatService: DevAiChatService = {
    async ask() {
      called = true;
      throw new Error("should not be called");
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "Funda 是什麼？" }),
        });
        assert.equal(res.status, 401);
        assert.equal(called, false);
      },
      { devAiChatService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST ai/feedback 無 token 會先被 Dev auth 擋下", async () => {
  const fixture = await buildFixture();
  let called = false;
  const devAiFeedbackService: DevAiFeedbackService = {
    async store() {
      called = true;
      throw new Error("should not be called");
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "chat-answer",
            question: "Funda 是什麼？",
            answer: "依內部文件回答。",
          }),
        });
        assert.equal(res.status, 401);
        assert.equal(called, false);
      },
      { devAiFeedbackService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST ai/feedback 會呼叫 feedback service 並帶 dev actor", async () => {
  const fixture = await buildFixture();
  let seenActor: string | null | undefined;
  const devAiFeedbackService: DevAiFeedbackService = {
    async store(request, options) {
      assert.equal(request.kind, "chat-answer");
      assert.equal(request.question, "Funda 是什麼？");
      assert.equal(request.answer, "依 approved example 回答。");
      seenActor = options?.actor;
      return {
        feedbackId: "feedback-route",
        stored: true,
        knowledgePath: "/tmp/approved-examples.jsonl",
        title: "Approved chat answer",
      };
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/feedback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${VALID_TOKEN}`,
          },
          body: JSON.stringify({
            kind: "chat-answer",
            question: "Funda 是什麼？",
            answer: "依 approved example 回答。",
          }),
        });
        assert.equal(res.status, 200);
        assert.equal(seenActor, "dev-user");
        assert.equal((await res.json()).data.feedbackId, "feedback-route");
      },
      { devAiFeedbackService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET ai/knowledge/status 無 token 會先被 Dev auth 擋下", async () => {
  const fixture = await buildFixture();
  let called = false;
  const devAiKnowledgeCompilerService: DevAiKnowledgeCompilerService = {
    async getStatus() {
      called = true;
      throw new Error("should not be called");
    },
    async compile() {
      throw new Error("should not be called");
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/knowledge/status`);
        assert.equal(res.status, 401);
        assert.equal(called, false);
      },
      { devAiKnowledgeCompilerService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET ai/knowledge/status 會回傳 compiler status", async () => {
  const fixture = await buildFixture();
  let called = false;
  const devAiKnowledgeCompilerService: DevAiKnowledgeCompilerService = {
    async getStatus() {
      called = true;
      return {
        enabled: true,
        approvedExamplesPath: "/tmp/approved-examples.jsonl",
        compiledDir: "/tmp/compiled",
        approvedExamples: {
          exists: true,
          total: 2,
          chatAnswers: 1,
          formulaSuggestions: 1,
          malformed: 0,
          bytes: 512,
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
        compiled: {
          exists: true,
          needsCompile: false,
          files: [
            {
              kind: "chat-answer",
              path: "approved-chat-answers.md",
              entries: 1,
              bytes: 128,
            },
          ],
          totalBytes: 128,
          lastCompiledAt: "2026-07-03T00:01:00.000Z",
        },
      };
    },
    async compile() {
      throw new Error("should not be called");
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/knowledge/status`, {
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { data: { approvedExamples: { total: number } } };
        assert.equal(body.data.approvedExamples.total, 2);
        assert.equal(called, true);
      },
      { devAiKnowledgeCompilerService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST ai/knowledge/compile 會呼叫 compiler service 並帶 dev actor", async () => {
  const fixture = await buildFixture();
  let seenActor: string | null | undefined;
  const devAiKnowledgeCompilerService: DevAiKnowledgeCompilerService = {
    async getStatus() {
      throw new Error("should not be called");
    },
    async compile(options) {
      seenActor = options?.actor;
      return {
        compiledAt: "2026-07-03T00:00:00.000Z",
        approvedExamplesPath: "/tmp/approved-examples.jsonl",
        compiledDir: "/tmp/compiled",
        wroteFiles: [
          {
            kind: "chat-answer",
            path: "approved-chat-answers.md",
            entries: 1,
            bytes: 128,
          },
        ],
        skippedMalformed: 0,
        status: {
          enabled: true,
          approvedExamplesPath: "/tmp/approved-examples.jsonl",
          compiledDir: "/tmp/compiled",
          approvedExamples: {
            exists: true,
            total: 1,
            chatAnswers: 1,
            formulaSuggestions: 0,
            malformed: 0,
            bytes: 256,
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
          compiled: {
            exists: true,
            needsCompile: false,
            files: [
              {
                kind: "chat-answer",
                path: "approved-chat-answers.md",
                entries: 1,
                bytes: 128,
              },
            ],
            totalBytes: 128,
            lastCompiledAt: "2026-07-03T00:00:00.000Z",
          },
        },
      };
    },
  };
  try {
    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/ai/knowledge/compile`, {
          method: "POST",
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        assert.equal(res.status, 200);
        assert.equal(seenActor, "dev-user");
        assert.equal((await res.json()).data.status.compiled.files[0].entries, 1);
      },
      { devAiKnowledgeCompilerService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST re-export 無 token 回 401", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/re-export`, {
        method: "POST",
      });
      assert.equal(res.status, 401);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST re-export 同步 builder .nui、清掉 read cache 並回最新 state/status", async () => {
  const fixture = await buildFixture();
  try {
    let exportCalls = 0;
    let statusCalls = 0;
    const versionControlService: RagicDefinitionsVersionControlService = {
      getStatus: async () => {
        statusCalls += 1;
        return versionStatus(fixture, {
          clean: false,
          definitionsClean: false,
          canCommit: true,
          definitionsEntries: [
            {
              raw: " M ragic-definitions/forms/default/devtest/51/formulas.json",
              status: " M",
              path: "ragic-definitions/forms/default/devtest/51/formulas.json",
              inDefinitions: true,
              formPath: "default/devtest/51",
            },
          ],
        });
      },
      commitBaseline: async () => {
        throw new Error("not used");
      },
      pushBaseline: async () => {
        throw new Error("not used");
      },
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const before = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
            "default/devtest/51"
          )}`,
          { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        );
        assert.equal(before.status, 200);
        const beforeBody = await before.json();
        assert.equal(beforeBody.data.formulas[0].nuiFormula, "F6*D6+123456");

        await writeFile(
          fixture.nuiFilePath,
          Array.from({ length: 26 }, (_, index) =>
            index === 23
              ? "D,7,6,1036641,測試,text=1&f=F6*D6%2B654321"
              : index === 12
                ? "D,1,2,1036615,編號,text=1"
                : `# filler ${index + 1}`
          ).join("\n"),
          "utf-8"
        );

        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/re-export`, {
          method: "POST",
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.exported, true);
        assert.equal(body.data.message, "已同步 Ragic 現況，definitions 有差異");
        assert.equal(body.data.summary.formulas, 1);
        assert.equal(body.data.state.manifest.counts.forms, 1);
        assert.equal(body.data.versionStatus.definitionsEntries.length, 1);
        assert.equal(body.data.fieldIndexRefresh, "not-needed");
        assert.equal(exportCalls, 1);
        assert.equal(statusCalls, 1);

        const after = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
            "default/devtest/51"
          )}`,
          { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        );
        assert.equal(after.status, 200);
        const afterBody = await after.json();
        assert.equal(afterBody.data.formulas[0].nuiFormula, "F6*D6+654321");
      },
      {
        versionControlService,
        reExport: {
          exportDefinitions: async ({ builderRoot, definitionsRoot, namespaces }) => {
            exportCalls += 1;
            assert.equal(builderRoot, fixture.builderRoot);
            assert.equal(definitionsRoot, fixture.root);
            assert.equal(namespaces, "default");
            return reexportFixtureDefinitionsSummary(fixture);
          },
        },
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST re-export 匯出失敗時不清掉舊 read cache", async () => {
  const fixture = await buildFixture();
  try {
    const versionControlService: RagicDefinitionsVersionControlService = {
      getStatus: async () => versionStatus(fixture),
      commitBaseline: async () => {
        throw new Error("not used");
      },
      pushBaseline: async () => {
        throw new Error("not used");
      },
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const before = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
            "default/devtest/51"
          )}`,
          { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        );
        assert.equal(before.status, 200);
        const beforeBody = await before.json();
        assert.equal(beforeBody.data.formulas[0].nuiFormula, "F6*D6+123456");

        const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/re-export`, {
          method: "POST",
          headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        });
        assert.equal(res.status, 500);

        const after = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
            "default/devtest/51"
          )}`,
          { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        );
        assert.equal(after.status, 200);
        const afterBody = await after.json();
        assert.equal(afterBody.data.formulas[0].nuiFormula, "F6*D6+123456");
      },
      {
        versionControlService,
        reExport: {
          exportDefinitions: async () => {
            await writeJson(join(fixture.formDir, "formulas.json"), [
              {
                fieldId: "1036641",
                fieldName: "測試",
                position: "G6",
                formulaKind: "formula",
                nuiFormula: "F6*D6+999999",
                displayFormula: "F6*D6+999999",
                sourceLine: 24,
              },
            ]);
            throw new Error("export failed");
          },
        },
      }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET forms 回 baseline 表單清單", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/forms?q=devtest`, {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].formPath, "default/devtest/51");
      assert.equal(body.data[0].counts.formulas, 1);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET search 可用 fieldId 找到欄位與公式", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/dev/ragic-definitions/search?fieldId=1036641`,
        { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.length, 2);
      assert.deepEqual(
        body.data.map((item: { type: string }) => item.type).sort(),
        ["field", "formula"]
      );
      assert.equal(
        body.data.find((item: { type: string }) => item.type === "formula")
          .displayFormula,
        "F6*D6+123456"
      );
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET form 回欄位、公式與 workflow 原文", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
          "default/devtest/51"
        )}`,
        { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.form.formName, "luo test");
      assert.equal(body.data.fields.length, 2);
      assert.equal(body.data.formulas.length, 1);
      assert.equal(body.data.workflows[0].scope, "post");
      assert.match(body.data.workflows[0].content, /getUpdatedEntry/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET form 拒絕不合法 path", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/api/dev/ragic-definitions/form?path=${encodeURIComponent(
          "../default/devtest/51"
        )}`,
        { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
      );
      assert.equal(res.status, 400);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET formula/siblings client abort 時會取消後端 siblings 查詢", async () => {
  const fixture = await buildFixture();
  try {
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const abortedPromise = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const formulaSiblingsService: RagicFormulaSiblingsService = {
      async listSiblings(request) {
        seenSignal = request.signal;
        started();
        request.signal?.addEventListener("abort", aborted, { once: true });
        await abortedPromise;
        throw new DOMException("formula siblings query aborted", "AbortError");
      },
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const controller = new AbortController();
        const responsePromise = fetch(
          `${baseUrl}/api/dev/ragic-definitions/formula/siblings?formPath=${encodeURIComponent(
            "default/devtest/51"
          )}&fieldId=1036641&formulaKind=formula&includeFreshness=true`,
          {
            headers: { Authorization: `Bearer ${VALID_TOKEN}` },
            signal: controller.signal,
          }
        ).catch((error: unknown) => error);

        await startedPromise;
        assert.equal(seenSignal?.aborted, false);
        controller.abort();
        await abortedPromise;
        const response = await responsePromise;
        assert.ok(response instanceof DOMException || response instanceof Error);
        assert.equal(seenSignal?.aborted, true);
      },
      { formulaSiblingsService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 回公式 patch preview 但不寫 .nui", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "F6*D6+654321",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, true);
      assert.equal(body.data.mode, "dry-run");
      assert.equal(body.data.formName, "luo test");
      assert.equal(body.data.fieldName, "測試");
      assert.equal(body.data.oldFormula, "F6*D6+123456");
      assert.equal(body.data.newFormula, "F6*D6+654321");
      assert.equal(body.data.sourceLine, 24);
      assert.match(body.data.oldLinePreview, /f=F6\*D6\+123456/);
      assert.match(body.data.newLinePreview, /f=F6\*D6\+654321/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 空白公式 preview 保留 raw 空白，不轉成 %20", async () => {
  const fixture = await buildFixture();
  try {
    await writeJson(join(fixture.formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "B6",
        displayFormula: "B6",
        sourceLine: 24,
      },
    ]);
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=B6"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "B6 * 2",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, true);
      assert.match(body.data.newLinePreview, /f=B6 \* 2/);
      assert.doesNotMatch(body.data.newLinePreview, /%20/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 多行公式 preview 正規化為單行，不寫成 %0A", async () => {
  const fixture = await buildFixture();
  try {
    await writeJson(join(fixture.formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "B6",
        displayFormula: "B6",
        sourceLine: 24,
      },
    ]);
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=B6"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "B6\r\n\t*  2",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, true);
      assert.equal(body.data.newFormula, "B6 * 2");
      assert.match(body.data.newLinePreview, /f=B6 \* 2/);
      assert.doesNotMatch(body.data.newLinePreview, /%0A|%0D/i);
      assert.match(body.data.warnings.join("\n"), /公式換行或 Tab 正規化/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 舊 .nui 若用 %2B，新 preview 正規化為 raw +", async () => {
  const fixture = await buildFixture();
  try {
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=F6*D6%2B123456"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "F6*D6+654321",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, true);
      assert.match(body.data.oldLinePreview, /f=F6\*D6%2B123456/);
      assert.match(body.data.newLinePreview, /f=F6\*D6\+654321/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 欄位存在但沒有既有公式時可新增 f= attr", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036615",
          formulaKind: "formula",
          newFormula: "G6",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, true);
      assert.equal(body.data.oldFormula, null);
      assert.equal(body.data.fieldName, "編號");
      assert.equal(body.data.position, "A2");
      assert.equal(body.data.sourceLine, 13);
      assert.match(body.data.oldLinePreview, /D,1,2,1036615,編號,text=1/);
      assert.match(body.data.newLinePreview, /D,1,2,1036615,編號,text=1&f=G6/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 找不到 baseline 欄位時禁止", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "9999999",
          formulaKind: "formula",
          newFormula: "A2",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, false);
      assert.match(body.data.blockers.join("\n"), /baseline fields\.json 找不到指定欄位/);
      assert.equal(body.data.oldLinePreview, null);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/dry-run 實際 .nui 與 baseline 公式不同時禁止", async () => {
  const fixture = await buildFixture();
  try {
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=F6*D6%2B999999"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/dry-run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "F6*D6+654321",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.allowed, false);
      assert.match(body.data.blockers.join("\n"), /請先按重新匯入同步 definitions 後再試算/);
      assert.match(body.data.newLinePreview, /f=F6\*D6\+654321/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/apply 寫入 .nui、備份、re-export 並寫 audit", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "F6*D6+654321",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.applied, true);
      assert.equal(body.data.mode, "apply");
      assert.equal(body.data.rolledBack, false);
      assert.equal(body.data.verifiedFormula.nuiFormula, "F6*D6+654321");
      assert.match(body.data.exportOutput, /\[test\] exported/);

      const nui = await readFile(fixture.nuiFilePath, "utf-8");
      assert.match(nui, /f=F6\*D6\+654321/);

      const backup = await readFile(body.data.backupFilePath, "utf-8");
      assert.match(backup, /f=F6\*D6\+123456/);

      const formulas = JSON.parse(
        await readFile(join(fixture.formDir, "formulas.json"), "utf-8")
      );
      assert.equal(formulas[0].nuiFormula, "F6*D6+654321");

      const audit = await readFile(body.data.auditFilePath, "utf-8");
      assert.match(audit, /"status":"applied"/);
      assert.match(audit, /"newFormula":"F6\*D6\+654321"/);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/apply 寫入空白公式時保留 raw 空白，不寫成 %20", async () => {
  const fixture = await buildFixture();
  try {
    await writeJson(join(fixture.formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "B6",
        displayFormula: "B6",
        sourceLine: 24,
      },
    ]);
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=B6"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "B6 * 2",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.applied, true);
      assert.equal(body.data.verifiedFormula.nuiFormula, "B6 * 2");

      const nui = await readFile(fixture.nuiFilePath, "utf-8");
      assert.match(nui, /f=B6 \* 2/);
      assert.doesNotMatch(nui, /%20/);

      const formulas = JSON.parse(
        await readFile(join(fixture.formDir, "formulas.json"), "utf-8")
      );
      assert.equal(formulas[0].nuiFormula, "B6 * 2");
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/apply 寫入多行公式時正規化為單行，不寫成 %0A", async () => {
  const fixture = await buildFixture();
  try {
    await writeJson(join(fixture.formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "B6",
        displayFormula: "B6",
        sourceLine: 24,
      },
    ]);
    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet51_index.nui"),
      Array.from({ length: 26 }, (_, index) =>
        index === 23
          ? "D,7,6,1036641,測試,text=1&f=B6"
          : `# filler ${index + 1}`
      ).join("\n"),
      "utf-8"
    );
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula: "B6\r\n\t*  2",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.applied, true);
      assert.equal(body.data.verifiedFormula.nuiFormula, "B6 * 2");

      const nui = await readFile(fixture.nuiFilePath, "utf-8");
      assert.match(nui, /f=B6 \* 2/);
      assert.doesNotMatch(nui, /%0A|%0D/i);

      const formulas = JSON.parse(
        await readFile(join(fixture.formDir, "formulas.json"), "utf-8")
      );
      assert.equal(formulas[0].nuiFormula, "B6 * 2");
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/apply 支援 raw 風格公式中的中文內容", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const newFormula = 'F6*D6+"這是開發者轉過去的測試"';
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
          newFormula,
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.applied, true);
      assert.equal(body.data.verifiedFormula.nuiFormula, newFormula);

      const nui = await readFile(fixture.nuiFilePath, "utf-8");
      assert.ok(nui.includes(`f=F6*D6+"這是開發者轉過去的測試"`));

      const formulas = JSON.parse(
        await readFile(join(fixture.formDir, "formulas.json"), "utf-8")
      );
      assert.equal(formulas[0].nuiFormula, newFormula);
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST formula/apply 欄位存在但沒有既有公式時新增 f= attr 並 re-export 驗證", async () => {
  const fixture = await buildFixture();
  try {
    await withTestServer(fixture, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/dev/ragic-definitions/formula/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          formPath: "default/devtest/51",
          fieldId: "1036615",
          formulaKind: "formula",
          newFormula: "G6",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.applied, true);
      assert.equal(body.data.dryRun.oldFormula, null);
      assert.equal(body.data.verifiedFormula.fieldId, "1036615");
      assert.equal(body.data.verifiedFormula.nuiFormula, "G6");

      const nui = await readFile(fixture.nuiFilePath, "utf-8");
      assert.match(nui, /D,1,2,1036615,編號,text=1&f=G6/);
      const formulas = JSON.parse(
        await readFile(join(fixture.formDir, "formulas.json"), "utf-8")
      );
      assert.ok(
        formulas.some(
          (formula: { fieldId: string; nuiFormula: string }) =>
            formula.fieldId === "1036615" && formula.nuiFormula === "G6"
        )
      );
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GET version-control/status 回 definitions baseline 版控狀態", async () => {
  const fixture = await buildFixture();
  try {
    const versionControlService: RagicDefinitionsVersionControlService = {
      getStatus: async () => ({
        gitAvailable: true,
        repoRoot: fixture.root,
        definitionsRoot: fixture.root,
        definitionsPathspec: "ragic-definitions",
        branch: "main",
        lastCommit: "abc1234",
        remoteTrackingBranch: "origin/main",
        ahead: 1,
        behind: 0,
        clean: false,
        definitionsClean: false,
        canCommit: true,
        canPush: false,
        canAutoSyncPush: false,
        entries: [],
        definitionsEntries: [
          {
            raw: " M ragic-definitions/forms/default/devtest/51/formulas.json",
            status: " M",
            path: "ragic-definitions/forms/default/devtest/51/formulas.json",
            inDefinitions: true,
            formPath: "default/devtest/51",
          },
        ],
        outsideEntries: [],
        blockers: [],
        warnings: [],
        error: null,
      }),
      commitBaseline: async () => {
        throw new Error("not used");
      },
      pushBaseline: async () => {
        throw new Error("not used");
      },
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/version-control/status`,
          { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.canCommit, true);
        assert.equal(body.data.definitionsEntries.length, 1);
      },
      { versionControlService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST version-control/commit 送 commit message 與 dev actor 給受限 service", async () => {
  const fixture = await buildFixture();
  try {
    let receivedMessage = "";
    let receivedActor = "";
    let receivedFormPaths: string[] | null | undefined = null;
    const versionControlService: RagicDefinitionsVersionControlService = {
      getStatus: async () => {
        throw new Error("not used");
      },
      commitBaseline: async (message, options) => {
        receivedMessage = message ?? "";
        receivedActor = options?.actor ?? "";
        receivedFormPaths = options?.formPaths;
        return {
          committed: true,
          commit: "def5678",
          message: receivedMessage,
          stdout: "[main def5678] chore(ragic): 更新 definitions baseline",
          stderr: "",
          status: {
            gitAvailable: true,
            repoRoot: fixture.root,
            definitionsRoot: fixture.root,
            definitionsPathspec: "ragic-definitions",
            branch: "main",
            lastCommit: "def5678",
            remoteTrackingBranch: "origin/main",
            ahead: 1,
            behind: 0,
            clean: true,
            definitionsClean: true,
            canCommit: false,
            canPush: true,
            canAutoSyncPush: false,
            entries: [],
            definitionsEntries: [],
            outsideEntries: [],
            blockers: [],
            warnings: [],
            error: null,
          },
          blockers: [],
          warnings: [],
        };
      },
      pushBaseline: async () => {
        throw new Error("not used");
      },
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/version-control/commit`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${VALID_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: "chore(ragic): 更新 definitions baseline",
              formPaths: ["default/devtest/51"],
            }),
          }
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.committed, true);
        assert.equal(body.data.commit, "def5678");
        assert.equal(receivedMessage, "chore(ragic): 更新 definitions baseline");
        assert.equal(receivedActor, "dev-user");
        assert.deepEqual(receivedFormPaths, ["default/devtest/51"]);
      },
      { versionControlService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("POST version-control/push 回 push 結果", async () => {
  const fixture = await buildFixture();
  try {
    const versionControlService: RagicDefinitionsVersionControlService = {
      getStatus: async () => {
        throw new Error("not used");
      },
      commitBaseline: async () => {
        throw new Error("not used");
      },
      pushBaseline: async () => ({
        pushed: true,
        stdout: "",
        stderr: "Everything up-to-date",
        status: {
          gitAvailable: true,
          repoRoot: fixture.root,
          definitionsRoot: fixture.root,
          definitionsPathspec: "ragic-definitions",
          branch: "main",
          lastCommit: "def5678",
          remoteTrackingBranch: "origin/main",
          ahead: 1,
          behind: 0,
          clean: true,
          definitionsClean: true,
          canCommit: false,
          canPush: true,
          canAutoSyncPush: false,
          entries: [],
          definitionsEntries: [],
          outsideEntries: [],
          blockers: [],
          warnings: [],
          error: null,
        },
        blockers: [],
        warnings: [],
      }),
    };

    await withTestServer(
      fixture,
      async (baseUrl) => {
        const res = await fetch(
          `${baseUrl}/api/dev/ragic-definitions/version-control/push`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${VALID_TOKEN}` },
          }
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.pushed, true);
      },
      { versionControlService }
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
