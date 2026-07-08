import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import iconv from "iconv-lite";
import {
  createRagicFormulaPatchDryRunService,
  encodeReplacementAttrValue,
  encodeRawStyleAttrValue,
  maskSecrets,
  normalizeFormulaForNuiStorage,
} from "../../../src/services/dev/ragicFormulaPatchDryRunService";
import type { RagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";

// raw-style attr 編碼規則：結構符號 (& CR LF) 轉成 percent-encoding，其他字元維持原文。
// 這對 UTF-8 表單很關鍵：中文等字元要保留原文，才能對齊 .nui 實際儲存格式。

test("encodeRawStyleAttrValue：純 ASCII 公式原樣保留", () => {
  assert.equal(encodeRawStyleAttrValue('F6*D6+"x"'), 'F6*D6+"x"');
  assert.equal(encodeRawStyleAttrValue("B6 * 2"), "B6 * 2");
});

test("encodeRawStyleAttrValue：中文保留原文，不做 percent-encoding", () => {
  assert.equal(encodeRawStyleAttrValue("測試"), "測試");
});

test("encodeRawStyleAttrValue：& CR LF 都轉碼，% 保留原文", () => {
  assert.equal(encodeRawStyleAttrValue("a&b%c\rd\ne"), "a%26b%c%0Dd%0Ae");
});

test("encodeRawStyleAttrValue：中文 + & 混合公式 → 結構字元轉碼、中文保留", () => {
  const input = 'F6*D6+"中文&測"';
  const out = encodeRawStyleAttrValue(input);
  assert.equal(out, 'F6*D6+"中文%26測"');
  assert.ok(out.startsWith('F6*D6+"'), "ASCII 公式骨架保留");
  assert.ok(!out.includes(encodeURIComponent("中")), "中文未 percent-encoding");
  assert.equal(decodeURIComponent(out), input, "逐段 round-trip 回原值");
});

test("encodeRawStyleAttrValue：% 保留為字面，避免與 Ragic 顯示行為衝突", () => {
  assert.equal(encodeRawStyleAttrValue("50%OFF"), "50%OFF");
  assert.equal(encodeRawStyleAttrValue("A%2BB"), "A%2BB");
});

test("encodeReplacementAttrValue：空白與運算子用 raw-style 寫入，不整段 URL encode", () => {
  assert.equal(encodeReplacementAttrValue("B6 * 2", "B6"), "B6 * 2");
  assert.notEqual(encodeReplacementAttrValue("B6 * 2", "B6"), "B6%20*%202");
});

test("encodeReplacementAttrValue：舊 raw 若含 %2B，新公式也正規化為 raw +", () => {
  assert.equal(
    encodeReplacementAttrValue("F6*D6+654321", "F6*D6%2B123456"),
    "F6*D6+654321"
  );
});

test("normalizeFormulaForNuiStorage：顯示用逗號轉回 Ragic .nui backtick，字串內逗號保留", () => {
  assert.equal(
    normalizeFormulaForNuiStorage('IF(AND(A1,B1),"x,y",C1)'),
    'IF(AND(A1`B1)`"x,y"`C1)'
  );
});

test("normalizeFormulaForNuiStorage：單引號字串內逗號保留", () => {
  assert.equal(
    normalizeFormulaForNuiStorage("SUBSTITUTE(B4,',',';[br][/br]')"),
    "SUBSTITUTE(B4`','`';[br][/br]')"
  );
});

test("normalizeFormulaForNuiStorage：反斜線不會讓後續結構逗號漏轉", () => {
  assert.equal(
    normalizeFormulaForNuiStorage('IF(A1="c:\\\\temp",B1,C1)'),
    'IF(A1="c:\\\\temp"`B1`C1)'
  );
});

test("normalizeFormulaForNuiStorage：換行與 Tab 正規化成單一空白，避免公式 attr 寫入 %0A", () => {
  const normalized = normalizeFormulaForNuiStorage("B6\r\n\t*  2");
  assert.equal(normalized, "B6 * 2");
  assert.equal(encodeReplacementAttrValue(normalized, "B6"), "B6 * 2");
  assert.doesNotMatch(encodeReplacementAttrValue(normalized, "B6"), /%0A|%0D/i);
});

test("normalizeFormulaForNuiStorage：字串內換行也正規化成空白", () => {
  assert.equal(normalizeFormulaForNuiStorage('A1&"x\ny"'), 'A1&"x y"');
});

test("maskSecrets：不把長公式加總誤判成 generic key", () => {
  const formula = Array.from({ length: 70 }, (_, index) => `A${index + 1}`).join("+");
  assert.equal(maskSecrets(formula), formula);
});

async function buildDryRunFixture(entries: string[]) {
  return buildDryRunFixtureWithOptions(entries, {});
}

async function buildDryRunFixtureWithOptions(
  entries: string[],
  options: {
    sourceEncoding?: string;
    sourceLineFormula?: string;
    oldFormula?: string;
    fileEncoding?: string;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "ragic-dryrun-scope-"));
  const builderRoot = join(root, "builder");
  const sourceRelativePath = "default/devtest/51_Sheet51_index.nui";
  const sourceEncoding = options.sourceEncoding ?? "utf-8";
  const formula = options.oldFormula ?? "A1";
  const lineFormula = options.sourceLineFormula ?? formula;
  const fileEncoding = options.fileEncoding ?? "utf-8";
  await mkdir(join(builderRoot, "default", "devtest"), { recursive: true });
  const line = `D,7,6,1036641,測試,text=1&f=${lineFormula}\n`;
  const lineBytes =
    fileEncoding === "utf-8" || fileEncoding === "utf8"
      ? line
      : iconv.encode(line, fileEncoding);
  await writeFile(
    join(builderRoot, sourceRelativePath),
    lineBytes,
    fileEncoding === "utf-8" || fileEncoding === "utf8" ? "utf-8" : undefined
  );
  const definitionsService = {
    getState: async () => ({
      definitionsRoot: join(root, "ragic-definitions"),
      exists: true,
      manifest: null,
      gitStatus: {
        available: true,
        clean: entries.length === 0,
        entries,
        error: null,
      },
    }),
    readForm: async () => ({
      form: {
        schemaVersion: 1,
        formPath: "default/devtest/51",
        formName: "scope-test",
        nuiFile: "51_Sheet51_index.nui",
        sourceEncoding,
        sourceRelativePath,
        counts: { fields: 1, formulas: 1, workflows: 0 },
      },
      fields: [],
      formulas: [
        {
          fieldId: "1036641",
          fieldName: "測試",
          position: "A1",
          formulaKind: "formula" as const,
          nuiFormula: formula,
          displayFormula: formula,
          sourceLine: 1,
        },
      ],
      workflows: [],
    }),
  } as unknown as RagicDefinitionsReadService;
  const service = createRagicFormulaPatchDryRunService({ definitionsService, builderRoot });
  return { root, service };
}

async function buildFormulaGraphFixture(
  formulas: Array<{ fieldId: string; position: string; fieldName: string; formula: string }>
) {
  const root = await mkdtemp(join(tmpdir(), "ragic-dryrun-cycle-"));
  const builderRoot = join(root, "builder");
  const sourceRelativePath = "default/devtest/51_Sheet51_index.nui";
  await mkdir(join(builderRoot, "default", "devtest"), { recursive: true });

  const fields = [
    { fieldId: "1001", fieldName: "A欄", position: "A6", column: 1, row: 6 },
    { fieldId: "1002", fieldName: "B欄", position: "B6", column: 2, row: 6 },
    { fieldId: "1003", fieldName: "C欄", position: "C6", column: 3, row: 6 },
  ];
  const formulaByFieldId = new Map(formulas.map((formula) => [formula.fieldId, formula]));
  await writeFile(
    join(builderRoot, sourceRelativePath),
    fields
      .map((field) => {
        const formula = formulaByFieldId.get(field.fieldId);
        const formulaAttr = formula ? `&f=${formula.formula}` : "";
        return `D,${field.column},${field.row},${field.fieldId},${field.fieldName},text=1${formulaAttr}`;
      })
      .join("\n"),
    "utf-8"
  );

  const definitionsService = {
    getState: async () => ({
      definitionsRoot: join(root, "ragic-definitions"),
      exists: true,
      manifest: null,
      gitStatus: {
        available: true,
        clean: true,
        entries: [],
        error: null,
      },
    }),
    readForm: async () => ({
      form: {
        schemaVersion: 1,
        formPath: "default/devtest/51",
        formName: "cycle-test",
        nuiFile: "51_Sheet51_index.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath,
        counts: { fields: fields.length, formulas: formulas.length, workflows: 0 },
      },
      fields: fields.map((field, index) => ({
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        kind: "D",
        position: field.position,
        sourceLine: index + 1,
        attrs: { text: "1" },
      })),
      formulas: formulas.map((formula) => {
        const sourceLine = fields.findIndex((field) => field.fieldId === formula.fieldId) + 1;
        return {
          fieldId: formula.fieldId,
          fieldName: formula.fieldName,
          position: formula.position,
          formulaKind: "formula" as const,
          nuiFormula: formula.formula,
          displayFormula: formula.formula,
          sourceLine,
        };
      }),
      workflows: [],
    }),
  } as unknown as RagicDefinitionsReadService;
  const service = createRagicFormulaPatchDryRunService({ definitionsService, builderRoot });
  return { root, service };
}

test("dry-run：其他表單 definitions dirty 只警告，不阻擋目前表單公式套用", async () => {
  const fixture = await buildDryRunFixture([
    " M ragic-definitions/forms/default/devtest/56/formulas.json",
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A2",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
    assert.match(result.warnings.join("\n"), /其他表單或非表單差異/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：同一表單 definitions dirty 仍阻擋，避免覆蓋未提交 baseline", async () => {
  const fixture = await buildDryRunFixture([
    "M  ragic-definitions/forms/default/devtest/51/formulas.json",
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A2",
    });
    assert.equal(result.allowed, false);
    assert.match(result.blockers.join("\n"), /目前表單 default\/devtest\/51/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：直接循環參照會阻擋", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
    { fieldId: "1002", fieldName: "B欄", position: "B6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "A6 * 5",
    });
    assert.equal(result.allowed, false);
    assert.match(result.blockers.join("\n"), /公式會造成循環參照：B6 -> A6 -> B6/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：欄位存在但沒有既有公式時可新增公式", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "A6 * 5",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.oldFormula, null);
    assert.equal(result.fieldName, "B欄");
    assert.equal(result.position, "B6");
    assert.equal(result.sourceLine, 2);
    assert.match(result.newLinePreview ?? "", /text=1&f=A6 \* 5/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：sourceEncoding 非支援值時直接 blocker", async () => {
  const fixture = await buildDryRunFixtureWithOptions([], {
    sourceEncoding: "x-unsupported-encoding",
  });
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A2",
    });
    assert.equal(result.allowed, false);
    assert.match(
      result.blockers.join("\n"),
      /sourceEncoding=.*不在.*TextDecoder|TextDecoder.*不在.*支援範圍/i
    );
    assert.equal(result.blockers.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：非 UTF-8（big5）舊 attr 混合，newFormula 僅 &, CR/LF 做規則化轉碼", async () => {
  const fixture = await buildDryRunFixtureWithOptions([], {
    sourceEncoding: "big5",
    fileEncoding: "big5",
    oldFormula: "A6&成品",
    sourceLineFormula: "A6%26成品&memo=%25legacy",
  });
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: 'IF(A6&成品,"x%y",B6)',
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.oldFormula, "A6&成品");
    assert.match(result.newLinePreview ?? "", /&f=IF\(A6%26成品`"x%y"`B6\)/);
    assert.match(result.newLinePreview ?? "", /&memo=%25legacy/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：UTF-8 舊公式含中文與智慧引號仍可通過比對", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-dryrun-non-ascii-"));
  const builderRoot = join(root, "builder");
  const sourceRelativePath = "default/devtest/51_Sheet51_index.nui";
  await mkdir(join(builderRoot, "default", "devtest"), { recursive: true });
  const oldFormula = 'F6*D6+“測試”';
  await writeFile(
    join(builderRoot, sourceRelativePath),
    `D,7,6,1036641,測試,text=1&f=${oldFormula}\n`,
    "utf-8"
  );
  const definitionsService = {
    getState: async () => ({
      definitionsRoot: join(root, "ragic-definitions"),
      exists: true,
      manifest: null,
      gitStatus: {
        available: true,
        clean: true,
        entries: [],
        error: null,
      },
    }),
    readForm: async () => ({
      form: {
        schemaVersion: 1,
        formPath: "default/devtest/51",
        formName: "scope-test",
        nuiFile: "51_Sheet51_index.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath,
        counts: { fields: 1, formulas: 1, workflows: 0 },
      },
      fields: [],
      formulas: [
        {
          fieldId: "1036641",
          fieldName: "測試",
          position: "A1",
          formulaKind: "formula" as const,
          nuiFormula: oldFormula,
          displayFormula: oldFormula,
          sourceLine: 1,
        },
      ],
      workflows: [],
    }),
  } as unknown as RagicDefinitionsReadService;
  const service = createRagicFormulaPatchDryRunService({ definitionsService, builderRoot });

  try {
    const result = await service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula",
      newFormula: "A2",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.oldFormula, oldFormula);
    assert.equal(result.oldLinePreview, `D,7,6,1036641,測試,text=1&f=${oldFormula}`);
    assert.match(result.newLinePreview ?? "", /&f=A2$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run：新增公式若造成循環參照仍會阻擋", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "A6 * 5",
    });
    assert.equal(result.allowed, false);
    assert.match(result.blockers.join("\n"), /公式會造成循環參照：B6 -> A6 -> B6/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：間接循環參照會阻擋", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
    { fieldId: "1002", fieldName: "B欄", position: "B6", formula: "C6" },
    { fieldId: "1003", fieldName: "C欄", position: "C6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1003",
      formulaKind: "formula",
      newFormula: "A6",
    });
    assert.equal(result.allowed, false);
    assert.match(result.blockers.join("\n"), /公式會造成循環參照：C6 -> A6 -> B6 -> C6/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：沒有回指目標欄位的公式仍可套用", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
    { fieldId: "1002", fieldName: "B欄", position: "B6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "C6 * 2",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：字串字面值內的 cell ref 不算循環參照", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
    { fieldId: "1002", fieldName: "B欄", position: "B6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "\"A6\"",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run：單引號字串字面值內的 cell ref 不算循環參照", async () => {
  const fixture = await buildFormulaGraphFixture([
    { fieldId: "1001", fieldName: "A欄", position: "A6", formula: "B6" },
    { fieldId: "1002", fieldName: "B欄", position: "B6", formula: "1" },
  ]);
  try {
    const result = await fixture.service.dryRunFormulaPatch({
      formPath: "default/devtest/51",
      fieldId: "1002",
      formulaKind: "formula",
      newFormula: "'A6'",
    });
    assert.equal(result.allowed, true);
    assert.equal(result.blockers.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
