import test from "node:test";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";
import { createRagicFormulaPatchDryRunService } from "../../../src/services/dev/ragicFormulaPatchDryRunService";
import {
  cleanupRagicFormulaPatchArtifacts,
  createRagicFormulaPatchApplyService,
} from "../../../src/services/dev/ragicFormulaPatchApplyService";
import { withDefinitionsWriteLock } from "../../../src/services/dev/ragicDefinitionsIoLock";

// 雙表 fixture：批次套用是 all-or-nothing（全部 dry-run → 逐張寫 .nui →
// 一次 re-export → 逐張 verify），驗證三條業務規則：
//   1. 兩張都可套 → 一次 export、兩張 .nui 都更新
//   2. 任一張被擋 → 整批不動（兩個 .nui 原樣）
//   3. verify 失敗 → 整批回滾（兩個 .nui 還原）

const FORMS = [
  { id: "51", fieldId: "1036641", oldFormula: "F6*D6+1" },
  { id: "56", fieldId: "1036641", oldFormula: "F6*C6+2" },
];

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

async function syncFixtureDefinitionCounts(
  fixture: Awaited<ReturnType<typeof buildFixture>>
): Promise<void> {
  const counts = { forms: FORMS.length, fields: 0, formulas: 0, workflows: 0 };
  for (const form of FORMS) {
    const formDir = join(fixture.root, "forms", "default", "devtest", form.id);
    const formDefinition = await readJson<Record<string, unknown>>(
      join(formDir, "form.json")
    );
    const fields = await readJson<unknown[]>(join(formDir, "fields.json"));
    const formulas = await readJson<unknown[]>(join(formDir, "formulas.json"));
    counts.fields += fields.length;
    counts.formulas += formulas.length;
    await writeJson(join(formDir, "form.json"), {
      ...formDefinition,
      counts: { fields: fields.length, formulas: formulas.length, workflows: 0 },
    });
  }
  const manifest = await readJson<Record<string, unknown>>(
    join(fixture.root, "manifest.json")
  );
  await writeJson(join(fixture.root, "manifest.json"), { ...manifest, counts });
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "ragic-batch-test-"));
  const builderRoot = join(root, "builder");
  const nuiDir = join(builderRoot, "default", "devtest");
  await mkdir(nuiDir, { recursive: true });
  await writeJson(join(root, "manifest.json"), {
    schemaVersion: 1,
    namespaceFilter: { mode: "include", namespaces: ["default"] },
    counts: {
      forms: FORMS.length,
      fields: FORMS.length,
      formulas: FORMS.length,
      workflows: 0,
    },
  });

  for (const form of FORMS) {
    const formDir = join(root, "forms", "default", "devtest", form.id);
    await mkdir(formDir, { recursive: true });
    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: `default/devtest/${form.id}`,
      formName: `test-${form.id}`,
      nuiFile: `${form.id}_Sheet${form.id}_index.nui`,
      sourceEncoding: "utf-8",
      sourceRelativePath: `default/devtest/${form.id}_Sheet${form.id}_index.nui`,
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "fields.json"), [
      {
        fieldId: form.fieldId,
        fieldName: "測試",
        kind: "D",
        position: "G6",
        sourceLine: 24,
        attrs: { text: "1" },
      },
    ]);
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: form.fieldId,
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: form.oldFormula,
        displayFormula: form.oldFormula,
        sourceLine: 24,
      },
    ]);
    const nuiLines = Array.from({ length: 26 }, (_, index) => `# filler ${index + 1}`);
    nuiLines[23] = `D,7,6,${form.fieldId},測試,text=1&f=${form.oldFormula}`;
    await writeFile(
      join(nuiDir, `${form.id}_Sheet${form.id}_index.nui`),
      `${nuiLines.join("\n")}\n`,
      "utf-8"
    );
  }
  return { root, builderRoot, nuiDir };
}

/** 模擬 re-export：從實際 .nui 抽 f= 公式回寫 formulas.json（兩張表都做） */
async function reexportFromNui(
  fixture: Awaited<ReturnType<typeof buildFixture>>,
  options: { sourceEncoding?: string; forms?: typeof FORMS } = {}
) {
  const sourceEncoding = options.sourceEncoding ?? "utf-8";
  const forms = options.forms ?? FORMS;
  for (const form of forms) {
    const content = await readFile(
      join(fixture.nuiDir, `${form.id}_Sheet${form.id}_index.nui`),
      undefined
    );
    const line = iconv.decode(content, sourceEncoding).split(/\r?\n/)[23] ?? "";
    const rawFormula =
      line
        .split(",")
        .slice(5)
        .join(",")
        .split("&")
        .find((part) => part.startsWith("f="))
        ?.slice(2) ?? "";
    const decodedFormula = (() => {
      try {
        return decodeURIComponent(rawFormula);
      } catch {
        return rawFormula;
      }
    })();
    await writeJson(join(fixture.root, "forms", "default", "devtest", form.id, "formulas.json"), [
      {
        fieldId: form.fieldId,
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: decodedFormula,
        displayFormula: decodedFormula,
        sourceLine: 24,
      },
    ]);
  }
  await syncFixtureDefinitionCounts(fixture);
  return { stdout: "[test] exported", stderr: "" };
}

function findLineRangeInBytes(
  bytes: Buffer,
  sourceLine: number
): { start: number; end: number } {
  let line = 1;
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    const end = index > start && bytes[index - 1] === 13 ? index - 1 : index;
    if (line === sourceLine) return { start, end };
    line += 1;
    start = index + 1;
  }
  if (line === sourceLine) return { start, end: bytes.length };
  throw new Error(`nui 沒有第 ${sourceLine} 行`);
}

function buildNuiFileWithLine(fieldLine: string, encoding: string): Buffer {
  const lines = Array.from({ length: 26 }, (_, index) =>
    index === 23 ? fieldLine : `# filler ${index + 1}`
  );
  lines[23] = fieldLine;
  return iconv.encode(`${lines.join("\n")}\n`, encoding);
}

function buildServices(
  fixture: Awaited<ReturnType<typeof buildFixture>>,
  exportImpl?: () => Promise<{ stdout: string; stderr: string }>,
  options: {
    auditFilePath?: string;
    gitStatusEntries?: string[];
    withDefinitionsWriteLock?: typeof withDefinitionsWriteLock;
  } = {}
) {
  const definitionsServiceBase = createRagicDefinitionsReadService({
    definitionsRoot: fixture.root,
    repoRoot: fixture.root,
    cacheTtlMs: 0,
  });
  const definitionsService = options.gitStatusEntries
    ? {
        ...definitionsServiceBase,
        getState: async () => {
          const state = await definitionsServiceBase.getState();
          return {
            ...state,
            gitStatus: {
              available: true,
              clean: options.gitStatusEntries?.length === 0,
              entries: options.gitStatusEntries ?? [],
              error: null,
            },
          };
        },
        getStateUnlocked: async () => {
          const state = await definitionsServiceBase.getStateUnlocked();
          return {
            ...state,
            gitStatus: {
              available: true,
              clean: options.gitStatusEntries?.length === 0,
              entries: options.gitStatusEntries ?? [],
              error: null,
            },
          };
        },
      }
    : definitionsServiceBase;
  const dryRunService = createRagicFormulaPatchDryRunService({
    definitionsService,
    builderRoot: fixture.builderRoot,
    // git 檢查在 fixture 環境恆 clean：repoRoot 不是 git repo 時 dry-run 會略過
  });
  const applyService = createRagicFormulaPatchApplyService({
    definitionsService,
    dryRunService,
    builderRoot: fixture.builderRoot,
    backupRoot: join(fixture.root, "backups"),
    rollbackSafetyRoot: join(fixture.root, "rollback-safety"),
    auditFilePath: options.auditFilePath ?? join(fixture.root, "audit.jsonl"),
    withDefinitionsWriteLock: options.withDefinitionsWriteLock,
    exportDefinitions: exportImpl ?? (() => reexportFromNui(fixture)),
  });
  return { applyService };
}

async function listBackupFiles(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, "backups"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function batchTargets(newFormulas: [string, string]) {
  return FORMS.map((form, index) => ({
    formPath: `default/devtest/${form.id}`,
    fieldId: form.fieldId,
    formulaKind: "formula" as const,
    newFormula: newFormulas[index],
  }));
}

test("單張 formula apply 會在 definitions write lock 內建立備份", async () => {
  const fixture = await buildFixture();
  try {
    let firstLock = true;
    const { applyService } = buildServices(fixture, undefined, {
      withDefinitionsWriteLock: async (fn) => {
        if (firstLock) {
          firstLock = false;
          assert.deepEqual(await listBackupFiles(fixture.root), []);
        }
        return withDefinitionsWriteLock(fn);
      },
    });

    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A1+10",
    });

    assert.equal(result.applied, true);
    assert.equal((await listBackupFiles(fixture.root)).length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("批次兩張全可套 → all applied、一次 export、兩個 .nui 都更新", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((target) => target.applied));
    assert.equal(result.results[0].verifiedFormula?.nuiFormula, "A1+10");
    assert.equal(result.results[1].verifiedFormula?.nuiFormula, "A1+20");

    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
    assert.ok(nui56.includes("f=A1+20"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：最近一次批次套用可用備份回復 .nui 並重新 export", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);

    const rollback = await applyService.rollbackLatestFormulaPatch();

    assert.equal(rollback.rolledBack, true);
    assert.equal(rollback.restoredCount, 2);
    assert.equal(rollback.targets.length, 2);
    assert.ok(rollback.targets.every((target) => target.restored));
    assert.ok(rollback.targets.every((target) => target.safetyBackupFilePath));
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=F6*D6+1"));
    assert.ok(nui56.includes("f=F6*C6+2"));

    const formulas51 = JSON.parse(
      await readFile(join(fixture.root, "forms", "default", "devtest", "51", "formulas.json"), "utf-8")
    ) as Array<{ nuiFormula: string }>;
    const formulas56 = JSON.parse(
      await readFile(join(fixture.root, "forms", "default", "devtest", "56", "formulas.json"), "utf-8")
    ) as Array<{ nuiFormula: string }>;
    assert.equal(formulas51[0]?.nuiFormula, "F6*D6+1");
    assert.equal(formulas56[0]?.nuiFormula, "F6*C6+2");

    const audit = await readFile(join(fixture.root, "audit.jsonl"), "utf-8");
    assert.match(audit, /"status":"rollback_applied"/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：等待並發 apply 完成後才讀最新 audit", async () => {
  const fixture = await buildFixture();
  try {
    let exportCalls = 0;
    let markSecondExportStarted!: () => void;
    let releaseSecondExport!: () => void;
    const secondExportStarted = new Promise<void>((resolve) => {
      markSecondExportStarted = resolve;
    });
    const releaseSecondExportPromise = new Promise<void>((resolve) => {
      releaseSecondExport = resolve;
    });
    const exportImpl = async () => {
      exportCalls += 1;
      if (exportCalls === 2) {
        markSecondExportStarted();
        await releaseSecondExportPromise;
      }
      return reexportFromNui(fixture);
    };
    const { applyService } = buildServices(fixture, exportImpl);

    const first = await applyService.applyFormulaPatchBatch(batchTargets(["A1+10", "A1+20"]));
    assert.equal(first.applied, true);

    const secondApply = applyService.applyFormulaPatchBatch(batchTargets(["A1+30", "A1+40"]));
    await secondExportStarted;
    const rollback = applyService.rollbackLatestFormulaPatch();
    await new Promise((r) => setTimeout(r, 20));
    releaseSecondExport();

    const second = await secondApply;
    assert.equal(second.applied, true);
    const rolledBack = await rollback;
    assert.equal(rolledBack.rolledBack, true);
    assert.equal(rolledBack.restoredCount, 2);

    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
    assert.ok(nui56.includes("f=A1+20"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("artifact cleanup：刪除舊備份但保留最新一次可 rollback 的備份", async () => {
  const fixture = await buildFixture();
  try {
    const auditFilePath = join(fixture.root, "audit.jsonl");
    const backupRoot = join(fixture.root, "backups");
    const rollbackSafetyRoot = join(fixture.root, "rollback-safety");
    const { applyService } = buildServices(fixture, undefined, { auditFilePath });
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);

    const oldBackupPath = join(backupRoot, "old.nui");
    const oldSafetyPath = join(rollbackSafetyRoot, "old-safety.nui");
    await mkdir(backupRoot, { recursive: true });
    await mkdir(rollbackSafetyRoot, { recursive: true });
    await writeFile(oldBackupPath, "old", "utf-8");
    await writeFile(oldSafetyPath, "old", "utf-8");
    const oldDate = new Date("2025-01-01T00:00:00.000Z");
    await utimes(oldBackupPath, oldDate, oldDate);
    await utimes(oldSafetyPath, oldDate, oldDate);

    const cleanup = await cleanupRagicFormulaPatchArtifacts({
      backupRoot,
      rollbackSafetyRoot,
      auditFilePath,
      retentionDays: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(cleanup.deletedBackupFiles, 1);
    assert.equal(cleanup.deletedRollbackSafetyFiles, 1);
    assert.equal(cleanup.protectedBackupFiles, 2);
    await assert.rejects(readFile(oldBackupPath), /ENOENT/);
    await assert.rejects(readFile(oldSafetyPath), /ENOENT/);

    const rollback = await applyService.rollbackLatestFormulaPatch();
    assert.equal(rollback.rolledBack, true);
    assert.equal(rollback.restoredCount, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：備份缺失時不覆寫 live .nui", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);
    const audit = await readFile(join(fixture.root, "audit.jsonl"), "utf-8");
    const backupFilePath = audit
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { backupFilePath?: string })
      .find((entry) => entry.backupFilePath)?.backupFilePath;
    assert.ok(backupFilePath);
    await rm(backupFilePath, { force: true });

    const rollback = await applyService.rollbackLatestFormulaPatch();

    assert.equal(rollback.rolledBack, false);
    assert.equal(rollback.restoredCount, 0);
    assert.ok(rollback.blockers.some((blocker) => /公式套用備份/.test(blocker)));
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
    assert.ok(nui56.includes("f=A1+20"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：回復中途失敗時會用已建立的 safety backup 還原", async () => {
  const fixture = await buildFixture();
  let unreadableBackupFilePath: string | null = null;
  try {
    const { applyService } = buildServices(fixture);
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);
    const audit = await readFile(join(fixture.root, "audit.jsonl"), "utf-8");
    unreadableBackupFilePath =
      audit
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { backupFilePath?: string })
        .find((entry) => entry.backupFilePath)?.backupFilePath ?? null;
    assert.ok(unreadableBackupFilePath);
    await chmod(unreadableBackupFilePath, 0o000);

    const rollback = await applyService.rollbackLatestFormulaPatch();

    assert.equal(rollback.rolledBack, false);
    assert.equal(rollback.restoredCount, 0);
    assert.ok(rollback.targets[0]?.warnings.includes("回復失敗後已還原 safety backup"));
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
  } finally {
    if (unreadableBackupFilePath) {
      await chmod(unreadableBackupFilePath, 0o600).catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：definitions 差異無法對應表單時不回復舊備份", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);

    const guarded = buildServices(fixture, undefined, {
      gitStatusEntries: [" M ragic-definitions/manifest.json"],
    }).applyService;
    const rollback = await guarded.rollbackLatestFormulaPatch();

    assert.equal(rollback.rolledBack, false);
    assert.equal(rollback.restoredCount, 0);
    assert.ok(
      rollback.blockers.some((blocker) => blocker.includes("差異無法對應"))
    );
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
    assert.ok(nui56.includes("f=A1+20"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rollback latest：definitions 差異對應最近一次表單時允許回復", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const applied = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );
    assert.equal(applied.applied, true);

    const guarded = buildServices(fixture, undefined, {
      gitStatusEntries: [" M ragic-definitions/forms/default/devtest/51/formulas.json"],
    }).applyService;
    const rollback = await guarded.rollbackLatestFormulaPatch();

    assert.equal(rollback.rolledBack, true);
    assert.equal(rollback.restoredCount, 2);
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=F6*D6+1"));
    assert.ok(nui56.includes("f=F6*C6+2"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("批次套用：兄弟表欄位存在但沒有既有公式時可新增 f= attr", async () => {
  const fixture = await buildFixture();
  try {
    const form56Dir = join(fixture.root, "forms", "default", "devtest", "56");
    await writeJson(join(form56Dir, "formulas.json"), []);
    await syncFixtureDefinitionCounts(fixture);
    const nui56Lines = Array.from({ length: 26 }, (_, index) => `# filler ${index + 1}`);
    nui56Lines[23] = "D,7,6,1036641,測試,text=1";
    await writeFile(
      join(fixture.nuiDir, "56_Sheet56_index.nui"),
      `${nui56Lines.join("\n")}\n`,
      "utf-8"
    );

    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.results[1].dryRun.oldFormula, null);
    assert.equal(result.results[1].verifiedFormula?.nuiFormula, "A1+20");

    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui56.includes("text=1&f=A1+20"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：顯示用逗號公式會以 Ragic .nui backtick canonical 寫入並驗證", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "IF(A1`B1`C1)",
        displayFormula: "IF(A1,B1,C1)",
        sourceLine: 24,
      },
    ]);
    const nuiLines = Array.from({ length: 26 }, (_, index) => `# filler ${index + 1}`);
    nuiLines[23] = "D,7,6,1036641,測試,text=1&f=IF(A1`B1`C1)";
    await writeFile(
      join(fixture.nuiDir, "51_Sheet51_index.nui"),
      `${nuiLines.join("\n")}\n`,
      "utf-8"
    );

    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "IF(A1,B1,D1)",
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.dryRun.newFormula, "IF(A1`B1`D1)");
    assert.equal(result.verifiedFormula?.nuiFormula, "IF(A1`B1`D1)");
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=IF(A1`B1`D1)"));
    assert.ok(!nui51.includes("f=IF(A1,B1,D1)"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：UTF-8 old formula raw 含非 ASCII 時可套用", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const oldFormula = 'F6*D6+“測試”';
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: oldFormula,
        displayFormula: oldFormula,
        sourceLine: 24,
      },
    ]);
    const nuiLines = Array.from({ length: 26 }, (_, index) => `# filler ${index + 1}`);
    nuiLines[23] = `D,7,6,1036641,測試,text=1&f=${oldFormula}`;
    await writeFile(
      join(fixture.nuiDir, "51_Sheet51_index.nui"),
      `${nuiLines.join("\n")}\n`,
      "utf-8"
    );

    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A1+10",
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.verifiedFormula?.nuiFormula, "A1+10");
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：UTF-8 新公式含中文時可原文寫入", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: 'A1+"中文"',
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.verifiedFormula?.nuiFormula, 'A1+"中文"');
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    assert.ok(nui51.includes('f=A1+"中文"'));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：Big5 sourceEncoding 可成功 patch 中文公式且不動其他 attr bytes", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");
    const oldFormula = "F6*D6+測試";

    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "test-51",
      nuiFile: "51_Sheet51_index.nui",
      sourceEncoding: "big5",
      sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: oldFormula,
        displayFormula: oldFormula,
        sourceLine: 24,
      },
    ]);

    const beforeLineKeepSegment = Buffer.from("note=KEEP", "ascii");
    const big5NuiLine = `D,7,6,1036641,測試,text=1&note=KEEP&f=${oldFormula}`;
    await writeFile(nuiPath, buildNuiFileWithLine(big5NuiLine, "big5"));

    const beforeNui = await readFile(nuiPath);
    const beforeLineRange = findLineRangeInBytes(beforeNui, 24);
    const beforeLine = beforeNui.subarray(beforeLineRange.start, beforeLineRange.end);
    const beforeKeepIndex = beforeLine.indexOf(beforeLineKeepSegment);
    assert.ok(beforeKeepIndex >= 0);

    const { applyService } = buildServices(
      fixture,
      () => reexportFromNui(fixture, { sourceEncoding: "big5", forms: [FORMS[0]] })
    );
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: 'A1+"中文"',
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.verifiedFormula?.nuiFormula, 'A1+"中文"');

    const afterNui = await readFile(nuiPath);
    const afterLineRange = findLineRangeInBytes(afterNui, 24);
    const afterLine = afterNui.subarray(afterLineRange.start, afterLineRange.end);
    const afterKeepIndex = afterLine.indexOf(beforeLineKeepSegment);
    assert.ok(afterKeepIndex >= 0);
    assert.deepEqual(
      beforeLine.subarray(beforeKeepIndex, beforeKeepIndex + beforeLineKeepSegment.length),
      afterLine.subarray(afterKeepIndex, afterKeepIndex + beforeLineKeepSegment.length)
    );

    const decoded = iconv.decode(afterNui, "big5");
    assert.ok(decoded.includes('f=A1+"中文"'));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：Big5 不可表示字元應阻擋 patch，避免被寫成 ?", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");
    const oldFormula = "中";

    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "test-51",
      nuiFile: "51_Sheet51_index.nui",
      sourceEncoding: "big5",
      sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: oldFormula,
        displayFormula: oldFormula,
        sourceLine: 24,
      },
    ]);

    const big5NuiLine = `D,7,6,1036641,測試,text=1&f=${oldFormula}`;
    await writeFile(nuiPath, buildNuiFileWithLine(big5NuiLine, "big5"));

    const beforeNui = await readFile(nuiPath);
    const { applyService } = buildServices(
      fixture,
      () => reexportFromNui(fixture, { sourceEncoding: "big5", forms: [FORMS[0]] })
    );
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: 'A1+"😀"',
    });

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    assert.ok(
      result.blockers.some((blocker) => /無法表示的字元/.test(blocker))
    );
    const afterNui = await readFile(nuiPath);
    assert.equal(afterNui.toString("hex"), beforeNui.toString("hex"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：非 UTF-8 下 old attr 位元組找不到時安全失敗", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");

    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "test-51",
      nuiFile: "51_Sheet51_index.nui",
      sourceEncoding: "ascii",
      sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "¤¤",
        displayFormula: "¤¤",
        sourceLine: 24,
      },
    ]);

    const mismatchLine = `D,7,6,1036641,測試,text=1&note=KEEP&f=${"中"}`;
    await writeFile(nuiPath, buildNuiFileWithLine(mismatchLine, "big5"));

    const beforeNui = await readFile(nuiPath);
    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A1+10",
    });

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    assert.ok(
      result.blockers.some((blocker) => blocker.includes("sourceLine 找不到可替換的 f= raw attr"))
    );
    const afterNui = await readFile(nuiPath);
    assert.equal(afterNui.toString("hex"), beforeNui.toString("hex"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("非 UTF-8：f 殘留在 dv_f 前綴中時仍只會替換正確 f attr", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");
    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "test-51",
      nuiFile: "51_Sheet51_index.nui",
      sourceEncoding: "big5",
      sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "A1",
        displayFormula: "A1",
        sourceLine: 24,
      },
    ]);

    const line = "D,7,6,1036641,測試,text=1&dv_f=A1&f=A1&note=KEEP";
    await writeFile(nuiPath, buildNuiFileWithLine(line, "big5"));
    const beforeNui = await readFile(nuiPath);
    const beforeKeepSegment = Buffer.from("note=KEEP", "ascii");
    const beforeKeepIndex = beforeNui.indexOf(beforeKeepSegment);

    const { applyService } = buildServices(
      fixture,
      () => reexportFromNui(fixture, { sourceEncoding: "big5", forms: [FORMS[0]] })
    );
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "B1",
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.blockers.length, 0);
    const afterNui = await readFile(nuiPath);
    const afterKeepIndex = afterNui.indexOf(beforeKeepSegment);
    assert.ok(beforeKeepIndex >= 0 && afterKeepIndex >= 0, "note attr 未丟失");
    assert.equal(beforeKeepIndex, afterKeepIndex);
    const decoded = iconv.decode(afterNui, "big5");
    assert.equal(
      decoded.includes("dv_f=A1"),
      true,
      "dv_f 不能被誤改"
    );
    assert.ok(decoded.includes("f=B1"));
    assert.ok(beforeNui.indexOf(beforeKeepSegment) === afterKeepIndex);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("非 UTF-8：new formula 只對 &,\r,\n 編碼，% 保留字面", async () => {
  const fixture = await buildFixture();
  try {
    const formDir = join(fixture.root, "forms", "default", "devtest", "51");
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");
    await writeJson(join(formDir, "form.json"), {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "test-51",
      nuiFile: "51_Sheet51_index.nui",
      sourceEncoding: "big5",
      sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
      counts: { fields: 1, formulas: 1, workflows: 0 },
    });
    await writeJson(join(formDir, "formulas.json"), [
      {
        fieldId: "1036641",
        fieldName: "測試",
        position: "G6",
        formulaKind: "formula",
        nuiFormula: "A1",
        displayFormula: "A1",
        sourceLine: 24,
      },
    ]);

    const line = 'D,7,6,1036641,測試,text=1&f=A1&note=KEEP';
    await writeFile(nuiPath, buildNuiFileWithLine(line, "big5"));

    const { applyService } = buildServices(
      fixture,
      () => reexportFromNui(fixture, { sourceEncoding: "big5", forms: [FORMS[0]] })
    );
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: 'A1&"50%"',
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.blockers.length, 0);
    const afterNui = await readFile(nuiPath);
    const decoded = iconv.decode(afterNui, "big5");
    assert.ok(decoded.includes('f=A1%26'));
    assert.ok(decoded.includes("50%"));
    assert.ok(!decoded.includes("50%25"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：audit 寫入失敗只降級 warning，不回滾已驗證成功的套用", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture, undefined, {
      auditFilePath: fixture.root,
    });
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A1+10",
    });

    assert.equal(result.applied, true);
    assert.equal(result.rolledBack, false);
    assert.ok(result.warnings.some((warning) => /audit 紀錄寫入失敗/.test(warning)));
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=A1+10"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("單筆 apply：rollback 還原失敗時不得標示 rolledBack=true", async () => {
  const fixture = await buildFixture();
  try {
    const nuiPath = join(fixture.nuiDir, "51_Sheet51_index.nui");
    const { applyService } = buildServices(fixture, async () => {
      await rm(nuiPath, { force: true });
      await mkdir(nuiPath);
      return { stdout: "[test] exported stale", stderr: "" };
    });
    const result = await applyService.applyFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A1+10",
    });

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    assert.ok(result.blockers.some((blocker) => /rollback 還原失敗/.test(blocker)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("任一張 dry-run 被擋（baseline 不符）→ 整批不動，兩個 .nui 原樣", async () => {
  const fixture = await buildFixture();
  try {
    // 把 56 的 baseline formulas.json 改成跟 .nui 不一致 → dry-run 會擋
    await writeJson(
      join(fixture.root, "forms", "default", "devtest", "56", "formulas.json"),
      [
        {
          fieldId: "1036641",
          fieldName: "測試",
          position: "G6",
          formulaKind: "formula",
          nuiFormula: "STALE+999",
          displayFormula: "STALE+999",
          sourceLine: 24,
        },
      ]
    );
    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    // 可套的那張也被整批擋下並說明原因
    assert.ok(
      result.results[0].blockers.some((item) => /整批未套用/.test(item))
    );
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=F6*D6+1"));
    assert.ok(nui56.includes("f=F6*C6+2"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("批次 target formPath 格式不合法 → 以 per-target blocker 回傳，不丟整個 route error", async () => {
  const fixture = await buildFixture();
  try {
    const { applyService } = buildServices(fixture);
    const result = await applyService.applyFormulaPatchBatch([
      {
        formPath: "bad-path",
        fieldId: "1036641",
        formulaKind: "formula",
        newFormula: "A1+10",
      },
    ]);

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].blockers.some((blocker) => /formPath 格式不合法/.test(blocker)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify 失敗（export 沒更新 baseline）→ 整批回滾，兩個 .nui 還原", async () => {
  const fixture = await buildFixture();
  try {
    // export mock 什麼都不做 → re-export 後 formulas.json 還是舊公式 → verify 失敗
    const { applyService } = buildServices(fixture, async () => ({
      stdout: "[test] noop export",
      stderr: "",
    }));
    const result = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, true);
    assert.ok(result.results.every((target) => !target.applied));
    assert.ok(
      result.results[0].blockers.some((item) => /整批回滾/.test(item))
    );
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=F6*D6+1"), "51 應還原為舊公式");
    assert.ok(nui56.includes("f=F6*C6+2"), "56 應還原為舊公式");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("批次 rollback 還原 .nui 後 re-export 失敗時不得標示 rolledBack=true", async () => {
  const fixture = await buildFixture();
  try {
    let exportCalls = 0;
    const { applyService } = buildServices(fixture, async () => {
      exportCalls += 1;
      if (exportCalls === 1) {
        return { stdout: "[test] noop export", stderr: "" };
      }
      throw new Error("rollback export failed");
    });
    const result = await applyService.applyFormulaPatchBatch(
      batchTargets(["A1+10", "A1+20"])
    );

    assert.equal(result.applied, false);
    assert.equal(result.rolledBack, false);
    assert.ok(
      result.results.every((target) =>
        target.warnings.some((warning) => /rollback 後 re-export 失敗/.test(warning))
      )
    );
    const nui51 = await readFile(join(fixture.nuiDir, "51_Sheet51_index.nui"), "utf-8");
    const nui56 = await readFile(join(fixture.nuiDir, "56_Sheet56_index.nui"), "utf-8");
    assert.ok(nui51.includes("f=F6*D6+1"), "51 .nui 應已還原為舊公式");
    assert.ok(nui56.includes("f=F6*C6+2"), "56 .nui 應已還原為舊公式");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
