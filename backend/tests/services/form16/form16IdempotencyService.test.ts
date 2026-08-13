import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  form16ClientRowKeyRepository,
  type Form16ClientRowKeyRecord,
} from "../../../src/storage/sqlite/form16ClientRowKeyRepository";
import { checkOrCreateForm16Entry } from "../../../src/services/form16/form16IdempotencyService";
import { HttpError } from "../../../src/utils/httpError";

// 用 t.mock.method 暫時 stub repository，不打真實 SQLite，只驗 service 層 idempotency 邏輯。
//
// 已知未涵蓋：`if (!env.SQLITE_ENABLED)` 那條分支。
// env 是 module-load const，runtime 改不了；要測這條只能 refactor 成 DI 注入 env-checker。
// 取捨上 keep production code 簡單，這條 branch 用 manual review 守住。

function buildRecord(
  overrides: Partial<Form16ClientRowKeyRecord> = {}
): Form16ClientRowKeyRecord {
  return {
    clientRowKey: "uuid-existing",
    entryId: "E-EXISTING",
    source: "downtime",
    status: "confirmed",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockReservePending(
  t: TestContext,
  result: Awaited<ReturnType<typeof form16ClientRowKeyRepository.reservePending>>
) {
  return t.mock.method(form16ClientRowKeyRepository, "reservePending", async () => result);
}

test("clientRowKey 為空字串 → 直接 create、不 reserve、不 confirm", async (t) => {
  const reserveMock = mockReservePending(t, { record: null, reserved: false });
  const confirmMock = t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-NEW");
  assert.equal(result.reused, false);
  assert.equal(reserveMock.mock.callCount(), 0);
  assert.equal(confirmMock.mock.callCount(), 0);
  assert.equal(createMock.mock.callCount(), 1);
});

test("clientRowKey 為純空白 → 視為空，直接 create", async (t) => {
  const reserveMock = mockReservePending(t, { record: null, reserved: false });
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "   ",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.reused, false);
  assert.equal(reserveMock.mock.callCount(), 0);
  assert.equal(createMock.mock.callCount(), 1);
});

test("clientRowKey null / undefined 都當空 key 處理", async (t) => {
  mockReservePending(t, { record: null, reserved: false });
  const createMock = t.mock.fn(async () => ({ entryId: "E-1" }));

  await checkOrCreateForm16Entry({
    clientRowKey: null,
    source: "downtime",
    create: createMock,
  });
  await checkOrCreateForm16Entry({
    clientRowKey: undefined,
    source: "downtime",
    create: createMock,
  });

  assert.equal(createMock.mock.callCount(), 2);
});

test("reserve 命中 confirmed 映射 → reused=true、不 call create", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-1", entryId: "E-EXISTING" }),
    reserved: false,
  });
  const confirmMock = t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-1",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-EXISTING");
  assert.equal(result.reused, true);
  assert.equal(createMock.mock.callCount(), 0);
  assert.equal(confirmMock.mock.callCount(), 0);
});

test("部署前 confirmed 映射缺 fingerprint 時沿用既有 entry、不重新 create", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-legacy-confirmed",
      entryId: "E-LEGACY-CONFIRMED",
      operationFingerprint: undefined,
    }),
    reserved: false,
  });
  const createMock = t.mock.fn(async () => ({ entryId: "E-SHOULD-NOT-CREATE" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-legacy-confirmed",
    source: "downtime",
    operationFingerprint: "fingerprint-current-release",
    create: createMock,
  });

  assert.deepEqual(result, {
    entryId: "E-LEGACY-CONFIRMED",
    reused: true,
  });
  assert.equal(createMock.mock.callCount(), 0);
});

test("部署前映射缺 fingerprint 仍不可跨 source 重用", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-legacy-other-source",
      entryId: "E-LEGACY-OTHER-SOURCE",
      source: "work-report-104",
      operationFingerprint: undefined,
    }),
    reserved: false,
  });
  const createMock = t.mock.fn(async () => ({ entryId: "E-SHOULD-NOT-CREATE" }));

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-legacy-other-source",
        source: "downtime",
        operationFingerprint: "fingerprint-current-release",
        create: createMock,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "FORM16_IDEMPOTENCY_KEY_CONFLICT"
  );
  assert.equal(createMock.mock.callCount(), 0);
});

test("部署前 pending 映射缺 fingerprint 時仍回寫入不可確認、不重新 create", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-legacy-pending",
      entryId: "",
      status: "pending",
      operationFingerprint: undefined,
    }),
    reserved: false,
  });
  const createMock = t.mock.fn(async () => ({ entryId: "E-SHOULD-NOT-CREATE" }));

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-legacy-pending",
        source: "downtime",
        operationFingerprint: "fingerprint-current-release",
        create: createMock,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "FORM16_WRITE_INDETERMINATE"
  );
  assert.equal(createMock.mock.callCount(), 0);
});

test("部署前 indeterminate 映射缺 fingerprint 時仍回寫入不可確認、不重新 create", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-legacy-indeterminate",
      entryId: "",
      status: "indeterminate",
      errorMessage: "部署前寫入結果未確認",
      operationFingerprint: undefined,
    }),
    reserved: false,
  });
  const createMock = t.mock.fn(async () => ({ entryId: "E-SHOULD-NOT-CREATE" }));

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-legacy-indeterminate",
        source: "downtime",
        operationFingerprint: "fingerprint-current-release",
        create: createMock,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "FORM16_WRITE_INDETERMINATE"
  );
  assert.equal(createMock.mock.callCount(), 0);
});

test("相同 clientRowKey 但 operation fingerprint 不同時拒絕重用 Form 16 映射", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-fingerprint-conflict",
      entryId: "E-EXISTING",
      operationFingerprint: "fingerprint-original",
    }),
    reserved: false,
  });
  const createMock = t.mock.fn(async () => ({ entryId: "E-SHOULD-NOT-CREATE" }));

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-fingerprint-conflict",
        source: "downtime",
        operationFingerprint: "fingerprint-new-payload",
        create: createMock,
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "FORM16_IDEMPOTENCY_KEY_CONFLICT"
  );

  assert.equal(createMock.mock.callCount(), 0);
});

test("reserve 成功 → create + confirm 映射", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-2", entryId: "", status: "pending" }),
    reserved: true,
  });
  const confirmMock = t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-2",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-NEW");
  assert.equal(result.reused, false);
  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(confirmMock.mock.callCount(), 1);
  assert.deepEqual(confirmMock.mock.calls[0]?.arguments[0], {
    clientRowKey: "uuid-2",
    entryId: "E-NEW",
    source: "downtime",
  });
});

test("Ragic 已建立但 confirm 不再擁有 reservation 時回不可確認", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-lost-owner", entryId: "", status: "pending" }),
    reserved: true,
  });
  t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 0);
  const createMock = t.mock.fn(async () => ({ entryId: "E-CREATED" }));

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-lost-owner",
        source: "downtime",
        create: createMock,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "FORM16_WRITE_INDETERMINATE"
  );

  assert.equal(createMock.mock.callCount(), 1);
});

test("create 回 entryId=null → release pending，讓下次 retry 同 key 能重新嘗試", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-3", entryId: "", status: "pending" }),
    reserved: true,
  });
  const confirmMock = t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  const releaseMock = t.mock.method(
    form16ClientRowKeyRepository,
    "releasePending",
    async () => 1
  );
  const createMock = t.mock.fn(async () => ({ entryId: null }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-3",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, null);
  assert.equal(result.reused, false);
  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(confirmMock.mock.callCount(), 0);
  assert.equal(releaseMock.mock.callCount(), 1);
});

test("create 拋出一般錯誤 → release pending、原 error 往外丟（同 key retry 可重新嘗試）", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-4", entryId: "", status: "pending" }),
    reserved: true,
  });
  const releaseMock = t.mock.method(
    form16ClientRowKeyRepository,
    "releasePending",
    async () => 1
  );
  const markIndeterminateMock = t.mock.method(
    form16ClientRowKeyRepository,
    "markIndeterminate",
    async () => undefined
  );
  const createMock = t.mock.fn(async () => {
    throw new Error("validation-failed");
  });

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-4",
        source: "downtime",
        create: createMock,
      }),
    /validation-failed/
  );

  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(releaseMock.mock.callCount(), 1);
  assert.equal(markIndeterminateMock.mock.callCount(), 0);
});

test("create 拋出 RAGIC_WRITE_FAILED 5xx → mark indeterminate，後續同 key 不重送", async (t) => {
  let reserveCalls = 0;
  t.mock.method(form16ClientRowKeyRepository, "reservePending", async () => {
    reserveCalls += 1;
    if (reserveCalls === 1) {
      return {
        record: buildRecord({
          clientRowKey: "uuid-indeterminate",
          entryId: "",
          status: "pending",
        }),
        reserved: true,
      };
    }
    return {
      record: buildRecord({
        clientRowKey: "uuid-indeterminate",
        entryId: "",
        status: "indeterminate",
        errorMessage: "Bad gateway",
      }),
      reserved: false,
    };
  });
  const releaseMock = t.mock.method(
    form16ClientRowKeyRepository,
    "releasePending",
    async () => 1
  );
  const markIndeterminateMock = t.mock.method(
    form16ClientRowKeyRepository,
    "markIndeterminate",
    async () => undefined
  );
  const createMock = t.mock.fn(async () => {
    throw new HttpError(502, "建立 Ragic 紀錄失敗：Bad gateway", "RAGIC_WRITE_FAILED");
  });

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-indeterminate",
        source: "downtime",
        create: createMock,
      }),
    /Bad gateway/
  );
  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-indeterminate",
        source: "downtime",
        create: createMock,
      }),
    /寫入結果尚未確認/
  );

  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(markIndeterminateMock.mock.callCount(), 1);
  assert.equal(releaseMock.mock.callCount(), 0);
});

test("create 拋出 RAGIC_ACTION_BUTTON_INDETERMINATE → mark indeterminate，後續同 key 不重送", async (t) => {
  let reserveCalls = 0;
  t.mock.method(form16ClientRowKeyRepository, "reservePending", async () => {
    reserveCalls += 1;
    if (reserveCalls === 1) {
      return {
        record: buildRecord({
          clientRowKey: "uuid-action-indeterminate",
          entryId: "",
          status: "pending",
        }),
        reserved: true,
      };
    }
    return {
      record: buildRecord({
        clientRowKey: "uuid-action-indeterminate",
        entryId: "",
        status: "indeterminate",
        errorMessage: "rollback delete 未確認",
      }),
      reserved: false,
    };
  });
  const releaseMock = t.mock.method(
    form16ClientRowKeyRepository,
    "releasePending",
    async () => 1
  );
  const markIndeterminateMock = t.mock.method(
    form16ClientRowKeyRepository,
    "markIndeterminate",
    async () => undefined
  );
  const createMock = t.mock.fn(async () => {
    throw new HttpError(
      502,
      "Form 16 action button 48 失敗，且 rollback delete 未確認",
      "RAGIC_ACTION_BUTTON_INDETERMINATE"
    );
  });

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-action-indeterminate",
        source: "downtime",
        create: createMock,
      }),
    /rollback delete 未確認/
  );
  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-action-indeterminate",
        source: "downtime",
        create: createMock,
      }),
    /寫入結果尚未確認/
  );

  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(markIndeterminateMock.mock.callCount(), 1);
  assert.equal(releaseMock.mock.callCount(), 0);
});

test("create 拋出 Ragic 寫入後結果不可確認 code → mark indeterminate、不 release pending", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-ragic-result-unknown", entryId: "", status: "pending" }),
    reserved: true,
  });
  const releaseMock = t.mock.method(
    form16ClientRowKeyRepository,
    "releasePending",
    async () => 1
  );
  const markIndeterminateMock = t.mock.method(
    form16ClientRowKeyRepository,
    "markIndeterminate",
    async () => undefined
  );

  for (const code of ["RAGIC_WRITE_GONE", "RAGIC_WRITE_ROLLBACK_UNCONFIRMED"]) {
    await assert.rejects(
      () =>
        checkOrCreateForm16Entry({
          clientRowKey: `uuid-${code}`,
          source: "downtime",
          create: async () => {
            throw new HttpError(502, `Form 16 寫入結果不可確認：${code}`, code);
          },
        }),
      new RegExp(code)
    );
  }

  assert.equal(markIndeterminateMock.mock.callCount(), 2);
  assert.equal(releaseMock.mock.callCount(), 0);
});

test("同 key 並發（TOCTOU）→ 只 create 一次，後到者共享結果且 reused=true", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-race", entryId: "", status: "pending" }),
    reserved: true,
  });
  const confirmMock = t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  let resolveCreate!: (value: { entryId: string }) => void;
  const createMock = t.mock.fn(
    () =>
      new Promise<{ entryId: string }>((resolve) => {
        resolveCreate = resolve;
      })
  );

  const first = checkOrCreateForm16Entry({
    clientRowKey: "uuid-race",
    source: "downtime",
    create: createMock,
  });
  const second = checkOrCreateForm16Entry({
    clientRowKey: "uuid-race",
    source: "downtime",
    create: createMock,
  });

  await new Promise((resolve) => setImmediate(resolve));
  resolveCreate({ entryId: "E-ONCE" });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(firstResult.entryId, "E-ONCE");
  assert.equal(firstResult.reused, false);
  assert.equal(secondResult.entryId, "E-ONCE");
  assert.equal(secondResult.reused, true);
  assert.equal(confirmMock.mock.callCount(), 1);
});

test("同 key 並發但 operation fingerprint 不同時後到者不共用進行中結果", async (t) => {
  mockReservePending(t, {
    record: buildRecord({
      clientRowKey: "uuid-race-fingerprint",
      entryId: "",
      status: "pending",
      operationFingerprint: "fingerprint-a",
    }),
    reserved: true,
  });
  t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  let resolveCreate!: (value: { entryId: string }) => void;
  const first = checkOrCreateForm16Entry({
    clientRowKey: "uuid-race-fingerprint",
    source: "downtime",
    operationFingerprint: "fingerprint-a",
    create: () =>
      new Promise<{ entryId: string }>((resolve) => {
        resolveCreate = resolve;
      }),
  });

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-race-fingerprint",
        source: "downtime",
        operationFingerprint: "fingerprint-b",
        create: async () => ({ entryId: "E-SHOULD-NOT-CREATE" }),
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "FORM16_IDEMPOTENCY_KEY_CONFLICT"
  );

  resolveCreate({ entryId: "E-FIRST" });
  assert.equal((await first).entryId, "E-FIRST");
});

test("不同 key 並發 → 各自 create，互不收斂", async (t) => {
  t.mock.method(
    form16ClientRowKeyRepository,
    "reservePending",
    async (input: { clientRowKey?: string }) => ({
    record: buildRecord({
      clientRowKey: String(input?.clientRowKey ?? ""),
      entryId: "",
      status: "pending",
    }),
    reserved: true,
  }));
  t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  const createMock = t.mock.fn(async () => ({ entryId: "E-ANY" }));

  const [left, right] = await Promise.all([
    checkOrCreateForm16Entry({
      clientRowKey: "uuid-left",
      source: "downtime",
      create: createMock,
    }),
    checkOrCreateForm16Entry({
      clientRowKey: "uuid-right",
      source: "downtime",
      create: createMock,
    }),
  ]);

  assert.equal(createMock.mock.callCount(), 2);
  assert.equal(left.reused, false);
  assert.equal(right.reused, false);
});

test("並發時先到者 create 拋一般錯誤 → 等待者收到同一錯誤，之後 retry 會重新 create", async (t) => {
  mockReservePending(t, {
    record: buildRecord({ clientRowKey: "uuid-race-fail", entryId: "", status: "pending" }),
    reserved: true,
  });
  t.mock.method(form16ClientRowKeyRepository, "confirm", async () => 1);
  t.mock.method(form16ClientRowKeyRepository, "releasePending", async () => 1);
  let createCalls = 0;
  const createMock = t.mock.fn(async () => {
    createCalls += 1;
    if (createCalls === 1) {
      throw new Error("validation-failed");
    }
    return { entryId: "E-RETRY" };
  });

  const first = checkOrCreateForm16Entry({
    clientRowKey: "uuid-race-fail",
    source: "downtime",
    create: createMock,
  });
  const second = checkOrCreateForm16Entry({
    clientRowKey: "uuid-race-fail",
    source: "downtime",
    create: createMock,
  });

  await assert.rejects(() => first, /validation-failed/);
  await assert.rejects(() => second, /validation-failed/);

  const retried = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-race-fail",
    source: "downtime",
    create: createMock,
  });
  assert.equal(retried.entryId, "E-RETRY");
  assert.equal(retried.reused, false);
  assert.equal(createMock.mock.callCount(), 2);
});
