import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { HttpError } from "../../src/utils/httpError";
import { ItSopDocumentService, type ItSopDocument } from "../../src/services/itSopDocumentService";

async function createService(t: TestContext): Promise<ItSopDocumentService> {
  const root = await mkdtemp(join(tmpdir(), "it-sop-documents-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return new ItSopDocumentService(root);
}

function createDocument(): ItSopDocument {
  return {
    id: "wk-e-pc-001",
    title: "新電腦設置",
    summary: "測試文件",
    templateVersion: 4,
    updatedAt: new Date(0).toISOString(),
    updatedByLabel: null,
    sections: [
      {
        id: "section-1",
        title: "交付檢查",
        kind: "checklist",
        text: "",
        rows: [],
        collapsed: false,
        items: [
          {
            id: "item-1",
            text: "確認網域登入",
            checked: false,
          },
        ],
      },
    ],
  };
}

function cloneDocument(document: ItSopDocument): ItSopDocument {
  return JSON.parse(JSON.stringify(document)) as ItSopDocument;
}

test("IT SOP document：不存在時回預設文件但不寫入正式檔", async (t) => {
  const service = await createService(t);
  const document = await service.getDocument("wk-e-pc-001");

  assert.equal(document.id, "wk-e-pc-001");
  assert.equal(document.title, "新電腦設置");
  assert.ok(document.templateVersion >= 4);
  assert.ok(document.sections.length >= 16);
  assert.ok(!document.sections.some((section) => section.id === "goshen-status"));
  assert.ok(document.sections.some((section) => section.title.includes("印表機")));
  assert.ok(document.sections.some((section) => section.text.includes("linkDisk")));
  assert.ok(document.sections.some((section) => section.title.includes("第一步")));
});

test("IT SOP document：儲存後可讀回 server 正式版本", async (t) => {
  const service = await createService(t);
  const saved = await service.saveDocument("wk-e-pc-001", createDocument(), "FD0287");
  const reloaded = await service.getDocument("wk-e-pc-001");

  assert.equal(saved.updatedByLabel, "FD0287");
  assert.equal(reloaded.title, "新電腦設置");
  assert.equal(reloaded.updatedByLabel, "FD0287");
  assert.equal(reloaded.sections[0]?.items[0]?.text, "確認網域登入");
});

test("IT SOP document：讀取舊版範本會升級標題並移除已下架章節", async (t) => {
  const service = await createService(t);
  const legacy = createDocument();
  legacy.title = "WK-E-PC-001 新電腦建置紀錄 / index";
  legacy.summary = "LINE、MIS、GOSHEN 仍需依後續章節處理。";
  legacy.templateVersion = 2;
  legacy.sections.push({
    id: "goshen-status",
    title: "十、已下架舊系統狀態",
    kind: "table",
    text: "",
    rows: [{ id: "goshen-row", cells: ["系統名稱", "GOSHEN"] }],
    collapsed: false,
    items: [],
  });

  await service.saveDocument("wk-e-pc-001", legacy, "FD0287");
  const reloaded = await service.getDocument("wk-e-pc-001");
  const serialized = JSON.stringify(reloaded);

  assert.equal(reloaded.title, "新電腦設置");
  assert.equal(reloaded.templateVersion, 4);
  assert.ok(!serialized.includes("GOSHEN"));
  assert.ok(!reloaded.sections.some((section) => section.id === "goshen-status"));
  assert.ok(reloaded.sections.some((section) => section.title.includes("第一步")));
});

test("IT SOP document：儲存舊版 payload 前會移除已下架內容", async (t) => {
  const service = await createService(t);
  const current = await service.getDocument("wk-e-pc-001");
  const legacyPayload = cloneDocument(current);
  legacyPayload.title = "WK-E-PC-001 新電腦建置紀錄 / index";
  legacyPayload.summary = "LINE、MIS、GOSHEN 仍需依後續章節處理。";
  legacyPayload.templateVersion = 2;
  legacyPayload.sections.push({
    id: "goshen-command",
    title: "十-1、已下架舊系統指令",
    kind: "code",
    text: "GOSHEN.EXE",
    rows: [],
    collapsed: false,
    items: [],
  });

  const saved = await service.saveDocument("wk-e-pc-001", legacyPayload, "FD0287");
  const reloaded = await service.getDocument("wk-e-pc-001");
  const serialized = JSON.stringify(reloaded);

  assert.equal(saved.title, "新電腦設置");
  assert.equal(saved.templateVersion, 4);
  assert.equal(reloaded.templateVersion, 4);
  assert.ok(!serialized.includes("GOSHEN"));
  assert.ok(!reloaded.sections.some((section) => section.id === "goshen-command"));
});

test("IT SOP document：新版文件允許保留使用者輸入的 GOSHEN 字樣", async (t) => {
  const service = await createService(t);
  const document = createDocument();
  document.summary = "日後若需要記錄 GOSHEN 相關歷史，不能被存檔流程刪除。";
  document.sections.push({
    id: "legacy-note",
    title: "舊系統備註",
    kind: "table",
    text: "",
    rows: [{ id: "legacy-note-row", cells: ["系統", "GOSHEN"] }],
    collapsed: false,
    items: [],
  });

  const saved = await service.saveDocument("wk-e-pc-001", document, "FD0287");
  const serialized = JSON.stringify(saved);

  assert.equal(saved.templateVersion, 4);
  assert.ok(serialized.includes("GOSHEN"));
  assert.ok(saved.sections.some((section) => section.id === "legacy-note"));
});

test("IT SOP document：缺 updatedAt 不可儲存", async (t) => {
  const service = await createService(t);
  const document = createDocument() as unknown as Record<string, unknown>;
  delete document.updatedAt;

  await assert.rejects(
    () => service.saveDocument("wk-e-pc-001", document, "FD0287"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "IT_SOP_EXPECTED_UPDATED_AT_REQUIRED"
  );
});

test("IT SOP document：stale updatedAt 會擋下覆寫", async (t) => {
  const service = await createService(t);
  const original = createDocument();
  const saved = await service.saveDocument("wk-e-pc-001", original, "FD0287");
  const stale = cloneDocument(original);
  stale.title = "舊草稿覆寫";

  await assert.rejects(
    () => service.saveDocument("wk-e-pc-001", stale, "FD0287"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "IT_SOP_VERSION_CONFLICT"
  );

  const reloaded = await service.getDocument("wk-e-pc-001");
  assert.equal(reloaded.updatedAt, saved.updatedAt);
  assert.equal(reloaded.title, "新電腦設置");
});

test("IT SOP document：非法 document id 會被拒絕", async (t) => {
  const service = await createService(t);

  await assert.rejects(
    () => service.getDocument("../secrets"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 400 &&
      error.code === "IT_SOP_DOCUMENT_ID_INVALID"
  );
});
