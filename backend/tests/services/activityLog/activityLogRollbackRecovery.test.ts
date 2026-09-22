import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../../src/config/env";
import { ragicClient, type RagicEntryObservationRead } from "../../../src/ragic/client";
import { activityLogClientRowKeyRepository, type ActivityLogClientRowKeyRecord } from "../../../src/storage/sqlite/activityLogClientRowKeyRepository";
import { checkOrCreateActivityLogEntry } from "../../../src/services/activityLog/activityLogIdempotencyService";
import { verifyNewlyCreatedActivityLogEntryOrRollback } from "../../../src/services/activityLog/activityLogWriteVerifier";
import { ActivityLogWriteReverifyService } from "../../../src/services/activityLog/activityLogWriteReverifyService";

for (const outcome of ["gone", "found", "read-error", "delete-error"] as const) {
  test(`rollback ${outcome}: only confirmed absence permits another create`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "activityLog-rollback-contract-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const storeFile = join(dir, "tasks.json");
    const service = new ActivityLogWriteReverifyService({ enabled: true, storeFile });
    let row: ActivityLogClientRowKeyRecord | null = null;
    t.mock.method(activityLogClientRowKeyRepository, "reservePending", async (input: Parameters<typeof activityLogClientRowKeyRepository.reservePending>[0]) => {
      if (row) return { reserved: false, record: row };
      row = { ...input, entryId: "", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return { reserved: true, record: row };
    });
    t.mock.method(activityLogClientRowKeyRepository, "markIndeterminate", async () => {
      if (row) row.status = "indeterminate";
    });
    t.mock.method(activityLogClientRowKeyRepository, "releasePending", async () => { row = null; return 1; });
    t.mock.method(activityLogClientRowKeyRepository, "confirm", async () => 1);
    const removeMapping = t.mock.method(activityLogClientRowKeyRepository, "deleteByReservationIdentity", async (input: Parameters<typeof activityLogClientRowKeyRepository.deleteByReservationIdentity>[0]) => {
      assert.equal(input.reservationToken, row?.reservationToken);
      assert.equal(input.entryId, "42");
      row = null;
      return 1;
    });
    const found: RagicEntryObservationRead = { kind: "found", record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: "WRONG",
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: "PA",
    } };
    let reads = 0;
    let recovery = false;
    let matchingAfterRollback = false;
    const observe = t.mock.method(ragicClient, "observeEntry", async (): Promise<RagicEntryObservationRead> => {
      if (matchingAfterRollback) return { kind: "found", record: {
        [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: "EXPECTED",
        [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: "PA",
      } };
      if (recovery) return { kind: "gone" };
      if (++reads === 1) return found;
      if (outcome === "read-error") throw new Error("read unavailable");
      return outcome === "gone" ? { kind: "gone" } : found;
    });
    const remove = t.mock.method(ragicClient, "deleteEntry", async () => {
      if (outcome === "delete-error") throw new Error("delete response lost");
    });
    const input = {
      clientRowKey: "rollback-key", source: "downtime",
      create: async (reservation?: ActivityLogClientRowKeyRecord) => {
        await verifyNewlyCreatedActivityLogEntryOrRollback({
          activityLogPath: "/16", entryId: "42", expected: { workOrderNo: "EXPECTED", type: "PA" },
          createOperationId: reservation!.reservationToken!,
          options: { onReadIndeterminate: async payload => {
            await service.enqueue({ ...payload, source: "downtime", clientRowKey: "rollback-key",
              idempotencySource: "downtime", idempotencyReservationToken: reservation!.reservationToken! });
          } },
        });
        return { entryId: "42" };
      },
    };
    await assert.rejects(checkOrCreateActivityLogEntry(input), {
      code: outcome === "gone" ? "RAGIC_WRITE_ROLLBACK_CONFIRMED" : "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
    });
    if (outcome !== "gone") {
      await assert.rejects(checkOrCreateActivityLogEntry(input), { code: "ACTIVITY_LOG_WRITE_INDETERMINATE" });
      const restarted = new ActivityLogWriteReverifyService({ enabled: true, storeFile });
      const task = (await restarted.listTasks())[0]!;
      assert.equal(task.rollbackPending, true);
      if (outcome === "found") {
        matchingAfterRollback = true;
        await restarted.runOnce();
        assert.equal((await restarted.listTasks())[0]?.status, "conflict");
        assert.equal(removeMapping.mock.callCount(), 0);
        assert.equal(remove.mock.callCount(), 1);
        await assert.rejects(checkOrCreateActivityLogEntry(input), { code: "ACTIVITY_LOG_WRITE_INDETERMINATE" });
        matchingAfterRollback = false;
        await restarted.retryTask(task.key);
      }
      recovery = true;
      await restarted.runOnce();
      assert.equal(removeMapping.mock.callCount(), 1);
    }
    let creates = 0;
    await checkOrCreateActivityLogEntry({ ...input, create: async () => { creates++; return { entryId: "43" }; } });
    assert.equal(creates, 1);
    assert.equal(remove.mock.callCount(), 1);
    assert.ok(observe.mock.callCount() >= 1);
  });
}
