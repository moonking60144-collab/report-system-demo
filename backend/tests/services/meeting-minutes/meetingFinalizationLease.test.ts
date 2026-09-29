import test from "node:test";
import assert from "node:assert/strict";
import { MeetingOneShotService } from "../../../src/services/meeting-minutes/meetingOneShotService";

test("Server 在 API finalize 期間續租 operation，完成後停止 heartbeat 並釋放", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let complete!: (result: string) => void;
  const service = new MeetingOneShotService({
    recorderLeaseMs: 90_000,
    repository: {
      acquireFinalizationLease: async () => { calls.push("acquire"); return "operation"; },
      renewFinalizationLease: async () => { calls.push("renew"); },
      markRecordingFinalized: async () => { calls.push("finalized"); },
      releaseFinalizationLease: async () => { calls.push("release"); },
    } as never,
  });
  const result = service.finalizeRecording("session", "owner", "tab", () => {
    entered();
    return new Promise<string>(resolve => { complete = resolve; });
  });
  await started;
  context.mock.timers.tick(30_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["acquire", "renew"]);
  complete("saved");
  assert.equal(await result, "saved");
  assert.deepEqual(calls, ["acquire", "renew", "finalized", "release"]);
  context.mock.timers.tick(90_000);
  assert.equal(calls.filter(call => call === "renew").length, 1);
});

test("API finalize 失敗也停止 heartbeat 並釋放 operation，不發布 finalized marker", async () => {
  const calls: string[] = [];
  const service = new MeetingOneShotService({
    repository: {
      acquireFinalizationLease: async () => "operation",
      renewFinalizationLease: async () => undefined,
      markRecordingFinalized: async () => { calls.push("finalized"); },
      releaseFinalizationLease: async () => { calls.push("release"); },
    } as never,
  });
  await assert.rejects(service.finalizeRecording("session", "owner", "tab", async () => { throw new Error("copy failed"); }), /copy failed/);
  assert.deepEqual(calls, ["release"]);
});
