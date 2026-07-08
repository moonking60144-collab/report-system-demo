import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createRagicFieldIndexRepository } from "../../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../../src/storage/sqlite/ragicFieldIndexSchema";
import { createRagicFormulaSiblingsService } from "../../../src/services/dev/ragicFormulaSiblingsService";
import type { RagicDefinitionFormDetail } from "../../../src/services/dev/ragicDefinitionsReadService";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

// 兩張多版本工令單（同 mainKey 1005987）+ 一張不相干表單（不同 mainKey 但故意
// 撞同號 fieldId，驗證不會被誤抓）
const ENTRIES = [
  {
    formPath: "default/forms8/92",
    formName: "[92] 工令單",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "A6",
    fieldName: "規格",
    fieldId: "1036621",
  },
  {
    formPath: "default/forms8/92",
    formName: "[92] 工令單",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "B6",
    fieldName: "數量",
    fieldId: "1036622",
  },
  {
    formPath: "default/forms8/92",
    formName: "[92] 工令單",
    scope: "subtable" as const,
    subtableKey: "2000001",
    fieldPos: "A6",
    fieldName: "子表規格碰撞",
    fieldId: "2099001",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] 工令單搓牙報工+排程",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "C3",
    fieldName: "規格",
    fieldId: "1036621",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] 工令單搓牙報工+排程",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "D2",
    fieldName: "數量",
    fieldId: "1036622",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] 工令單搓牙報工+排程",
    scope: "subtable" as const,
    subtableKey: "2000001",
    fieldPos: "C3",
    fieldName: "子表規格碰撞",
    fieldId: "2099001",
  },
  // 版本表單但缺「數量」欄位（驗 hasField 與拒譯）
  {
    formPath: "default/forms8/77",
    formName: "[77] 工令單-檢驗基準列印用",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "F1",
    fieldName: "規格",
    fieldId: "1036621",
  },
  // 不同 mainKey、撞同號 fieldId 的不相干表單
  {
    formPath: "default/it/6",
    formName: "IT帳號資訊",
    scope: "main" as const,
    subtableKey: "9999999",
    fieldPos: "A1",
    fieldName: "帳號",
    fieldId: "1036621",
  },
];

function formDetail(
  formPath: string,
  formulas: Array<{
    fieldId: string;
    formulaKind: "formula" | "defaultFormula";
    nuiFormula: string;
    displayFormula: string;
    position?: string;
    sourceLine?: number;
  }>
): RagicDefinitionFormDetail {
  const fields = ENTRIES.filter((entry) => entry.formPath === formPath).map((entry, index) => ({
    fieldId: entry.fieldId,
    fieldName: entry.fieldName,
    kind: "D",
    position: entry.fieldPos,
    sourceLine: index + 1,
    attrs: {},
  }));
  return {
    form: {
      schemaVersion: 1,
      formPath,
      formName: formPath,
      nuiFile: "x.nui",
      sourceEncoding: "utf-8",
      sourceRelativePath: "x.nui",
      counts: { fields: fields.length, formulas: formulas.length, workflows: 0 },
    },
    fields,
    formulas: formulas.map((formula) => ({
      fieldId: formula.fieldId,
      fieldName: "規格",
      position: formula.position ?? "A6",
      formulaKind: formula.formulaKind,
      nuiFormula: formula.nuiFormula,
      displayFormula: formula.displayFormula,
      sourceLine: formula.sourceLine ?? 1,
    })),
    workflows: [],
  } as unknown as RagicDefinitionFormDetail;
}

async function buildService(overrides?: {
  readForm?: (formPath: string) => Promise<RagicDefinitionFormDetail>;
  builderRoot?: string;
}) {
  const { db, repo } = await buildRepo();
  await repo.replaceAll(ENTRIES, new Date("2026-06-11T00:00:00Z").toISOString());
  const readForm =
    overrides?.readForm ??
    (async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
        },
      ]));
  const service = createRagicFormulaSiblingsService({
    fieldIndexRepository: repo,
    definitionsService: { readForm },
    builderRoot: overrides?.builderRoot,
  });
  return { db, repo, service };
}

test("同 mainKey 找齊兄弟表單、排除自己，不同 mainKey 同號 fieldId 不誤抓", async () => {
  const { db, service } = await buildService();
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
  });

  const paths = result.siblings.map((sibling) => sibling.formPath).sort();
  assert.deepEqual(paths, ["default/forms8/104", "default/forms8/77"].sort());
  // it/6 撞同號 fieldId 但不同 mainKey，不得出現
  assert.ok(!paths.includes("default/it/6"));
  await db.close();
});

test("includeCurrent=true 會把目前表單納入同一套 freshness 判定", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-current-"));
  await mkdir(root, { recursive: true });
  await writeFile(root + "/x.nui", "D,1,6,1036621,規格,f=C3+D2\n", "utf-8");
  const { db, service } = await buildService({ builderRoot: root });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
      includeCurrent: true,
    });

    const paths = result.siblings.map((sibling) => sibling.formPath).sort();
    assert.deepEqual(
      paths,
      ["default/forms8/92", "default/forms8/104", "default/forms8/77"].sort()
    );
    const current = result.siblings.find((sibling) => sibling.formPath === "default/forms8/92");
    assert.equal(current?.freshness.checked, true);
    assert.equal(current?.freshness.fresh, true);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("hasField 正確標示；現行公式從 definitions 取得", async () => {
  const { db, service } = await buildService();
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036622",
    formulaKind: "formula",
  });

  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  const form77 = result.siblings.find((s) => s.formPath === "default/forms8/77");
  assert.equal(form104?.hasField, true);
  assert.equal(form104?.fieldPosition, "D2");
  // 77 沒有「數量」欄位
  assert.equal(form77?.hasField, false);
  assert.equal(form77?.fieldPosition, null);
  await db.close();
});

test("帶 newFormula 時附位置翻譯：92 的 A6+B6 → 104 的 C3+D2", async () => {
  const { db, service } = await buildService();
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
    newFormula: "A6+B6",
  });

  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  assert.equal(form104?.translation?.translated, "C3+D2");
  assert.equal(form104?.translation?.mapping.length, 2);

  // 77 缺「數量」欄位 → 拒譯
  const form77 = result.siblings.find((s) => s.formPath === "default/forms8/77");
  assert.equal(form77?.hasField, true);
  assert.equal(form77?.translation?.translated, null);
  assert.ok(
    form77?.translation?.untranslatable.some((item) => /數量/.test(item.reason))
  );
  await db.close();
});

test("跨版本公式推估只用 main 欄位，主表與子表同位置時不被子表覆蓋", async () => {
  const { db, service } = await buildService();
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
    newFormula: "A6+B6",
  });

  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  assert.equal(form104?.translation?.translated, "C3+D2");
  assert.deepEqual(
    form104?.translation?.mapping.map((item) => item.fieldId),
    ["1036621", "1036622"]
  );
  await db.close();
});

test("目標表同 fieldId 對到多個位置時拒絕自動推估，避免靜默取錯位置", async () => {
  const { db, repo, service } = await buildService();
  await repo.replaceAll(
    [
      ...ENTRIES,
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單搓牙報工+排程",
        scope: "main" as const,
        subtableKey: "1005987",
        fieldPos: "Z9",
        fieldName: "數量副本",
        fieldId: "1036622",
      },
    ],
    new Date("2026-06-11T00:01:00Z").toISOString()
  );

  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
    newFormula: "A6+B6",
  });

  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  assert.equal(form104?.translation?.translated, null);
  assert.ok(
    form104?.translation?.untranslatable.some((item) => /多個位置/.test(item.reason))
  );
  await db.close();
});

test("單一版本表單（無同 mainKey 兄弟）回空 siblings", async () => {
  const { db, service } = await buildService();
  const result = await service.listSiblings({
    formPath: "default/it/6",
    fieldId: "1036621",
    formulaKind: "formula",
  });
  assert.deepEqual(result.siblings, []);
  await db.close();
});

test("definitions 缺某版本表單匯出檔 → definitionsMissing 標記、查詢不炸", async () => {
  const { db, service } = await buildService({
    readForm: async (formPath: string) => {
      if (formPath === "default/forms8/77") {
        throw new Error("ENOENT: no such file or directory");
      }
      return formDetail(formPath, []);
    },
  });
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
  });

  const form77 = result.siblings.find((s) => s.formPath === "default/forms8/77");
  assert.equal(form77?.definitionsMissing, true);
  assert.equal(form77?.currentFormula, null);
  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  assert.equal(form104?.definitionsMissing, false);
  await db.close();
});

test("欄位存在但沒有既有公式且 live 也無公式 → freshness fresh，可由 apply 新增公式", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  await mkdir(root, { recursive: true });
  await writeFile(root + "/x.nui", "D,3,3,1036621,規格,text=1\n", "utf-8");
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) => formDetail(formPath, []),
  });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.hasField, true);
    assert.equal(form104?.currentNuiFormula, null);
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, true);
    assert.equal(form104?.freshness.baselinePosition, "C3");
    assert.equal(form104?.freshness.actualPosition, "C3");
    assert.deepEqual(form104?.freshness.staleReasons, []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live .nui 欄位位置與 definitions 不一致時標記 stale，避免跨版本推估吃舊 baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  await mkdir(root, { recursive: true });
  await writeFile(root + "/x.nui", "D,4,14,1036621,規格,f=C3+D2\n", "utf-8");
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, false);
    assert.equal(form104?.freshness.baselinePosition, "C3");
    assert.equal(form104?.freshness.actualPosition, "D14");
    assert.ok(
      form104?.freshness.staleReasons.some((reason) =>
        /欄位位置不同步：baseline=C3，live=D14/.test(reason)
      )
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness baseline position 使用 definitions，不被已刷新 field-index 覆蓋", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  await mkdir(root, { recursive: true });
  await writeFile(root + "/x.nui", "D,4,14,1036621,規格,f=C3+D2\n", "utf-8");
  const { db, repo, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    await repo.replaceAll(
      ENTRIES.map((entry) =>
        entry.formPath === "default/forms8/104" && entry.fieldId === "1036621"
          ? { ...entry, fieldPos: "D14" }
          : entry
      ),
      new Date("2026-06-11T00:02:00Z").toISOString()
    );

    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, false);
    assert.equal(form104?.freshness.baselinePosition, "C3");
    assert.equal(form104?.freshness.actualPosition, "D14");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness 使用 definitions sourceLine，不 fallback 掃描同 fieldId", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    root + "/x.nui",
    [
      "D,9,9,9999999,其他,f=C3+D2",
      "D,4,14,1036621,規格,f=C3+D2",
    ].join("\n"),
    "utf-8"
  );
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, false);
    assert.equal(form104?.freshness.actualPosition, "I9");
    assert.ok(
      form104?.freshness.staleReasons.some((reason) =>
        /sourceLine fieldId 不一致/.test(reason)
      )
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("includeFreshness=false 只回 definitions baseline，不讀 live .nui", async () => {
  const { db, service } = await buildService({
    builderRoot: "/path/that/does/not/exist",
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  const result = await service.listSiblings({
    formPath: "default/forms8/92",
    fieldId: "1036621",
    formulaKind: "formula",
    includeFreshness: false,
  });

  const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
  assert.equal(form104?.freshness.checked, false);
  assert.equal(form104?.freshness.fresh, true);
  assert.equal(form104?.freshness.baselinePosition, "C3");
  assert.deepEqual(form104?.freshness.warnings, []);
  await db.close();
});

test("signal 取消時停止 siblings 查詢並回 AbortError", async () => {
  const controller = new AbortController();
  let readFormCalls = 0;
  const { db, service } = await buildService({
    readForm: async (formPath: string) => {
      readFormCalls += 1;
      controller.abort();
      return formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]);
    },
  });

  try {
    await assert.rejects(
      () =>
        service.listSiblings({
          formPath: "default/forms8/92",
          fieldId: "1036621",
          formulaKind: "formula",
          signal: controller.signal,
        }),
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError"
    );
    assert.ok(readFormCalls > 0);
  } finally {
    await db.close();
  }
});

test("live .nui 公式含 redaction 形狀時不可判定 fresh，避免遮蔽後 false fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    root + "/x.nui",
    "D,3,3,1036621,規格,f=sk-1234567890123456\n",
    "utf-8"
  );
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "sk-***REDACTED***",
          displayFormula: "sk-***REDACTED***",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, false);
    assert.equal(form104?.freshness.actualFormula, "sk-***REDACTED***");
    assert.ok(
      form104?.freshness.staleReasons.some((reason) =>
        /已遮蔽敏感片段/.test(reason)
      )
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live .nui UTF-8 非 ASCII 公式含中文與智慧引號時不誤判 stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-live-"));
  const sourceFormula = "F6*D6+“測試”";
  await mkdir(root, { recursive: true });
  await writeFile(
    root + "/x.nui",
    `D,3,3,1036621,規格,f=${encodeURIComponent(sourceFormula)}\n`,
    "utf-8"
  );
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: sourceFormula,
          displayFormula: sourceFormula,
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    const result = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });

    const form104 = result.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(form104?.freshness.checked, true);
    assert.equal(form104?.freshness.fresh, true);
    assert.deepEqual(form104?.freshness.staleReasons, []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live .nui cache 會依 mtime/size 失效，不會在 Builder 寫入後讀舊公式", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-siblings-cache-"));
  const nuiPath = join(root, "x.nui");
  await mkdir(root, { recursive: true });
  await writeFile(nuiPath, "D,3,3,1036621,規格,f=C3+D2\n", "utf-8");
  const { db, service } = await buildService({
    builderRoot: root,
    readForm: async (formPath: string) =>
      formDetail(formPath, [
        {
          fieldId: "1036621",
          formulaKind: "formula",
          nuiFormula: "C3+D2",
          displayFormula: "C3+D2",
          position: "C3",
          sourceLine: 1,
        },
      ]),
  });
  try {
    const first = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });
    const firstForm104 = first.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(firstForm104?.freshness.fresh, true);

    await writeFile(nuiPath, "D,3,3,1036621,規格,f=C3+D9\n", "utf-8");
    await utimes(
      nuiPath,
      new Date("2026-06-16T00:00:00.000Z"),
      new Date("2026-06-16T00:00:00.000Z")
    );

    const second = await service.listSiblings({
      formPath: "default/forms8/92",
      fieldId: "1036621",
      formulaKind: "formula",
    });
    const secondForm104 = second.siblings.find((s) => s.formPath === "default/forms8/104");
    assert.equal(secondForm104?.freshness.fresh, false);
    assert.equal(secondForm104?.freshness.actualFormula, "C3+D9");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
