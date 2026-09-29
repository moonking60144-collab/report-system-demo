import test from "node:test";
import assert from "node:assert/strict";
import { MeetingOneShotRepository } from "../../src/storage/meeting-minutes/meetingOneShotRepository";
import { subscribeMeetingStateChanges } from "../../src/events/meetingStateEvents";

test("Meeting lifecycle invalidation follows commit; failed admission and routine checks do not emit", async () => {
  const repository = new MeetingOneShotRepository(":memory:");
  let events = 0;
  const unsubscribe = subscribeMeetingStateChanges(() => { events++; });
  const brokenSubscriber = subscribeMeetingStateChanges(() => { throw new Error("disconnected transport"); });
  const input = (sessionId: string, ownerId: string) => ({
    sessionId, ownerId, recorderId: "tab", title: "meeting", createdAt: new Date().toISOString(), maxPipelines: 1,
  });
  try {
    await repository.registerForOwner(input("one", "owner"));
    assert.equal(events, 1);
    assert.ok(await repository.get("one"), "notification failure cannot roll back committed state");
    await assert.rejects(repository.registerForOwner(input("two", "other")));
    assert.equal(events, 1);
    await repository.checked("one", new Date().toISOString());
    assert.equal(events, 1, "routine checks are not state-change events");
    await repository.checked("one", new Date().toISOString(), "FAILED");
    assert.equal(events, 2);
    await repository.releaseTerminalFailure("one", new Date().toISOString());
    await repository.releaseCurrent("one", "owner", new Date().toISOString(), true);
    assert.equal(events, 4);
    const beforeRead = events;
    assert.equal(await repository.currentForOwnerContext("owner", new Date().toISOString(), "tab"), null);
    assert.equal(events, beforeRead);
    const nextMeeting = await repository.registerForOwner(input("new", "owner"));
    assert.equal(nextMeeting.created, true);
    assert.ok((await repository.get("one"))?.deviceSessionReleasedAt);
  } finally { unsubscribe(); brokenSubscriber(); await repository.close(); }
});

test("recorder lease 到期只提交一次 invalidation，晚到核對不能清除已續租的 lease", async () => {
  const repository = new MeetingOneShotRepository(":memory:");
  let events = 0;
  const unsubscribe = subscribeMeetingStateChanges(() => { events++; });
  try {
    await repository.registerForOwner({ sessionId: "recording", ownerId: "owner", recorderId: "tab", title: "meeting",
      createdAt: "2026-09-16T00:00:00.000Z", recorderLeaseUntil: "2026-09-16T00:01:30.000Z", maxPipelines: 2 });
    await repository.renewRecorderLease({ sessionId: "recording", ownerId: "owner", recorderId: "tab",
      now: "2026-09-16T00:01:20.000Z", leaseUntil: "2026-09-16T00:02:50.000Z", maxPipelines: 2 });
    await repository.expireRecorderLeases("2026-09-16T00:01:40.000Z");
    assert.equal(events, 1, "LATE_SWEEP_MUST_NOT_EXPIRE_RENEWED_RECORDER");
    await repository.expireRecorderLeases("2026-09-16T00:02:51.000Z");
    assert.equal(events, 2);
    const expired = await repository.get("recording");
    assert.equal(expired?.recorderLeaseUntil, null);
    assert.equal(expired?.pipelineReleasedAt, null, "EXPIRY_PRESERVES_RECOVERY_SESSION");
    await repository.expireRecorderLeases("2026-09-16T00:03:00.000Z");
    assert.equal(events, 2, "UNCHANGED_SWEEP_MUST_NOT_REPEAT_EVENTS");
  } finally { unsubscribe(); await repository.close(); }
});
