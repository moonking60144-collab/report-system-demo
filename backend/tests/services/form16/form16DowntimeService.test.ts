import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../../src/config/env";
import { FORM_104_CONFIG } from "../../../src/config/forms/form-104";
import { ragicClient } from "../../../src/ragic/client";
import { form16DowntimeService } from "../../../src/services/form16/form16DowntimeService";
import { form16DowntimeSqliteRepository } from "../../../src/storage/sqlite/form16DowntimeSqliteRepository";
import { HttpError } from "../../../src/utils/httpError";

test("停機紀錄 snapshot hash 相同時允許 mutation", async (t) => {
  const getHashMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "same-hash"
  );

  await form16DowntimeService.assertRecordSnapshotUnchanged("123", "same-hash");

  assert.equal(getHashMock.mock.callCount(), 1);
});

test("停機紀錄 snapshot hash 不同時擋下 stale mutation", async (t) => {
  t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "current-hash"
  );

  await assert.rejects(
    () => form16DowntimeService.assertRecordSnapshotUnchanged("123", "old-hash"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "DOWNTIME_RECORD_STALE");
      return true;
    }
  );
});

test("停機紀錄沒有 expected snapshot hash 時維持舊流程", async (t) => {
  const getHashMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "current-hash"
  );

  await form16DowntimeService.assertRecordSnapshotUnchanged("123", null);

  assert.equal(getHashMock.mock.callCount(), 0);
});

test("停機紀錄 create payload 必須直寫 Type報工類別（Ragic 必填驗證先於公式，缺了會被 202 拒絕）", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertNoDuplicatePlannedIdle: (...args: unknown[]) => Promise<void>;
    resolveForm16RequiredFields: (
      ...args: unknown[]
    ) => Promise<{ depUnit: string; prodType: string; source: string }>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  t.mock.method(service, "assertNoDuplicatePlannedIdle", async () => {});
  t.mock.method(service, "resolveForm16RequiredFields", async () => ({
    depUnit: "C02搓牙組",
    prodType: "TI",
    source: "test",
  }));
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});

  let createPayload: Record<string, unknown> | null = null;
  t.mock.method(ragicClient, "createEntry", async (
    _path: string,
    payload: Record<string, unknown>
  ) => {
    createPayload = payload;
    return { ragicId: "990001" };
  });
  t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: "",
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: "TI搓牙",
  }));
  t.mock.method(ragicClient, "executeActionButton", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => {});

  const result = await form16DowntimeService.createRecord({
    date: "2026/07/06",
    machineId: "A1",
    processCode: "BU01",
  });

  assert.equal(result.entryId, "990001");
  assert.ok(createPayload, "應有呼叫 ragicClient.createEntry");
  const requiredCreateTimeFields = [
    FORM_104_CONFIG.writeConfig.subtableWriteFields.date,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdle,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.machineId,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.inputOptions,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.shiftType,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.startTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.endTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.breakTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes,
    env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
    env.RAGIC_FORM_16_TYPE_FIELD_ID,
    env.RAGIC_FORM_16_DEP_FIELD_ID,
    env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID,
  ];
  for (const fieldId of requiredCreateTimeFields) {
    assert.notEqual(
      (createPayload as Record<string, unknown>)[fieldId],
      undefined,
      `create-time required field ${fieldId} 不可從 payload 消失`
    );
  }
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_TYPE_FIELD_ID],
    "TI搓牙"
  );
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_DEP_FIELD_ID],
    "C02搓牙組"
  );
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID],
    "TI"
  );
});

test("停機紀錄 update 變更 processCode 時必須同步寫回 Type報工類別與 lookup 欄位", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertRecordSnapshotUnchanged: (...args: unknown[]) => Promise<void>;
    resolveForm16RequiredFields: (
      ...args: unknown[]
    ) => Promise<{ depUnit: string; prodType: string; source: string }>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  t.mock.method(service, "assertRecordSnapshotUnchanged", async () => {});
  t.mock.method(service, "resolveForm16RequiredFields", async () => ({
    depUnit: "C02搓牙組",
    prodType: "TI",
    source: "test",
  }));
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});

  let updatePayload: Record<string, unknown> | null = null;
  t.mock.method(ragicClient, "updateEntry", async (
    _path: string,
    _entryId: string,
    payload: Record<string, unknown>
  ) => {
    updatePayload = payload;
    return {};
  });

  const result = await form16DowntimeService.updateRecord("990001", {
    processCode: "BU01",
  });

  assert.equal(result.id, "990001");
  assert.ok(updatePayload, "應有呼叫 ragicClient.updateEntry");
  assert.equal(
    (updatePayload as Record<string, unknown>)[
      FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode
    ],
    "BU01"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_TYPE_FIELD_ID],
    "TI搓牙"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_DEP_FIELD_ID],
    "C02搓牙組"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID],
    "TI"
  );
});
