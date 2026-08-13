import { describe, expect, it } from "vitest";
import {
  isDowntimeCreateQueueTask,
  isDowntimeSynchronousMutationRecord,
  isDowntimeTaskRunning,
  isIndeterminateDowntimeCreateTask,
  isRetryableDowntimeCreateTask,
} from "./downtimeTaskSemantics";

describe("downtimeTaskSemantics", () => {
  it("只把 pending/running 視為進行中", () => {
    expect(isDowntimeTaskRunning("pending")).toBe(true);
    expect(isDowntimeTaskRunning("running")).toBe(true);
    expect(isDowntimeTaskRunning("success")).toBe(false);
    expect(isDowntimeTaskRunning("failed")).toBe(false);
  });

  it("create-downtime 是 queued create task，update/delete 是同步 mutation record", () => {
    expect(isDowntimeCreateQueueTask({ taskType: "create-downtime" })).toBe(true);
    expect(isDowntimeCreateQueueTask({ taskType: "update-downtime" })).toBe(false);
    expect(isDowntimeCreateQueueTask({ taskType: "delete-downtime" })).toBe(false);

    expect(isDowntimeSynchronousMutationRecord({ taskType: "create-downtime" })).toBe(false);
    expect(isDowntimeSynchronousMutationRecord({ taskType: "update-downtime" })).toBe(true);
    expect(isDowntimeSynchronousMutationRecord({ taskType: "delete-downtime" })).toBe(true);
  });

  it("只有 failed create-downtime 可進入本機 payload retry 判斷", () => {
    expect(isRetryableDowntimeCreateTask({ taskType: "create-downtime", status: "failed" }))
      .toBe(true);
    expect(isRetryableDowntimeCreateTask({ taskType: "create-downtime", status: "running" }))
      .toBe(false);
    expect(isRetryableDowntimeCreateTask({ taskType: "update-downtime", status: "failed" }))
      .toBe(false);
    expect(isRetryableDowntimeCreateTask({ taskType: "delete-downtime", status: "failed" }))
      .toBe(false);
  });

  it("寫入結果不明的 create-downtime 不可直接重送", () => {
    for (const errorCode of [
      "FORM16_WRITE_INDETERMINATE",
      "RAGIC_ACTION_BUTTON_INDETERMINATE",
      "RAGIC_WRITE_FAILED",
      "RAGIC_WRITE_GONE",
      "RAGIC_WRITE_ROLLBACK_DELETED",
      "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
    ]) {
      const task = { taskType: "create-downtime" as const, status: "failed" as const, errorCode };
      expect(isIndeterminateDowntimeCreateTask(task), errorCode).toBe(true);
      expect(isRetryableDowntimeCreateTask(task), errorCode).toBe(false);
    }

    expect(
      isRetryableDowntimeCreateTask({
        taskType: "create-downtime",
        status: "failed",
        errorCode: "RAGIC_ACTION_BUTTON_FAILED",
      })
    ).toBe(true);
    expect(
      isIndeterminateDowntimeCreateTask({
        taskType: "create-downtime",
        status: "failed",
        writeIndeterminate: true,
      })
    ).toBe(true);
    expect(
      isRetryableDowntimeCreateTask({
        taskType: "create-downtime",
        status: "failed",
        writeIndeterminate: false,
        errorCode: "RAGIC_WRITE_FAILED",
      })
    ).toBe(true);
  });
});
