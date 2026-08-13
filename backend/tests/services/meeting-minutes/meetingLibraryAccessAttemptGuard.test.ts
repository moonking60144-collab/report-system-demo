import test from "node:test";
import assert from "node:assert/strict";
import { MeetingLibraryAccessAttemptGuard } from "../../../src/services/meeting-minutes/meetingLibraryAccessAttemptGuard";
import { HttpError } from "../../../src/utils/httpError";

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.statusCode === 429 &&
    error.code === "MEETING_LIBRARY_ACCESS_RATE_LIMITED"
  );
}

test("Meeting 錄音庫存取碼：低門檻只限制同一個 browser client", () => {
  const guard = new MeetingLibraryAccessAttemptGuard({
    clientMaxFailures: 2,
    ipMaxFailures: 10,
  });
  const firstClient = { clientId: "client-browser-a", ip: "192.168.1.28" };
  const secondClient = { clientId: "client-browser-b", ip: "192.168.1.28" };

  guard.recordFailure(firstClient);
  assert.throws(() => guard.recordFailure(firstClient), isRateLimited);
  assert.throws(() => guard.assertAllowed(firstClient), isRateLimited);
  assert.doesNotThrow(() => guard.assertAllowed(secondClient));
});

test("Meeting 錄音庫存取碼：高門檻 IP bucket 可阻擋輪換 client id", () => {
  const guard = new MeetingLibraryAccessAttemptGuard({
    clientMaxFailures: 10,
    ipMaxFailures: 3,
  });

  guard.recordFailure({ clientId: "client-browser-a", ip: "192.168.1.28" });
  guard.recordFailure({ clientId: "client-browser-b", ip: "192.168.1.28" });
  assert.throws(
    () =>
      guard.recordFailure({ clientId: "client-browser-c", ip: "192.168.1.28" }),
    isRateLimited
  );
});

test("Meeting 錄音庫存取碼：成功授權只清除該 browser 的失敗紀錄", () => {
  const guard = new MeetingLibraryAccessAttemptGuard({
    clientMaxFailures: 2,
    ipMaxFailures: 100,
  });
  const identity = { clientId: "client-browser-a", ip: "192.168.1.28" };

  guard.recordFailure(identity);
  guard.recordSuccess(identity);
  assert.doesNotThrow(() => guard.recordFailure(identity));
});

test("Meeting 錄音庫存取碼：單一 browser 成功不會清除共用 IP 防繞過計數", () => {
  const guard = new MeetingLibraryAccessAttemptGuard({
    clientMaxFailures: 10,
    ipMaxFailures: 2,
  });

  guard.recordFailure({ clientId: "client-browser-a", ip: "192.168.1.28" });
  guard.recordSuccess({ clientId: "client-browser-a", ip: "192.168.1.28" });
  assert.throws(
    () => guard.recordFailure({ clientId: "client-browser-b", ip: "192.168.1.28" }),
    isRateLimited
  );
});
