import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { MeetingLibraryAccessService } from "../../../src/services/meeting-minutes/meetingLibraryAccessService";
import { createMeetingLibraryViewerAuth } from "../../../src/services/meeting-minutes/meetingLibraryViewerAuth";
import { MeetingLibraryRepository } from "../../../src/storage/meeting-minutes/meetingLibraryRepository";

const LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEPPER = "meeting-library-test-pepper-at-least-32-bytes";
const COOKIE_SECRET = "meeting-viewer-cookie-secret-at-least-32-bytes";

function requestWithCookie(cookie = ""): Request {
  return {
    header(name: string) {
      return name.toLowerCase() === "cookie" ? cookie : undefined;
    },
    secure: false,
  } as Request;
}

function responseCapture(): { response: Response; cookies: string[] } {
  const cookies: string[] = [];
  return {
    cookies,
    response: {
      append(name: string, value: string) {
        if (name.toLowerCase() === "set-cookie") cookies.push(value);
        return this;
      },
    } as Response,
  };
}

test("Library Code 建立一次、格式可正規化且不影響 pepper disabled 錄音入口", async () => {
  const disabledRepository = new MeetingLibraryRepository(":memory:");
  const disabled = new MeetingLibraryAccessService({
    repository: disabledRepository,
    pepper: "",
  });
  assert.deepEqual(await disabled.ensureLibrary(LIBRARY_ID), {
    enabled: false,
    library: null,
    code: null,
    created: false,
  });
  await disabled.close();

  const repository = new MeetingLibraryRepository(":memory:");
  const codes = ["nw8-k9q", "Q7MX8P"];
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => codes.shift() ?? "Q7MX8P",
    now: () => new Date("2026-07-16T08:00:00.000Z"),
  });
  try {
    const created = await service.ensureLibrary(LIBRARY_ID, " 2026 年 品管會議 ");
    assert.equal(created.enabled, true);
    assert.equal(created.created, true);
    assert.equal(created.code, "NW8-K9Q");
    assert.equal(created.library?.displayName, "2026 年 品管會議");
    assert.equal(created.library?.codeHint, "N**-**Q");
    assert.equal(created.library?.accessVersion, 1);

    const reused = await service.ensureLibrary(LIBRARY_ID);
    assert.equal(reused.created, false);
    assert.equal(reused.code, null);
    assert.equal((await service.authorize("nw8 k9q")).libraryId, LIBRARY_ID);
    const renamed = await service.renameLibrary(LIBRARY_ID, "每月品質檢討會");
    assert.equal(renamed.displayName, "每月品質檢討會");
  } finally {
    await service.close();
  }
});

test("Code 重設會讓舊 Code 與既有 viewer cookie 一起失效", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const codes = ["NW8K9Q", "NW8K9Q", "Q7MX8P"];
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => codes.shift() ?? "Q7MX8P",
  });
  const auth = createMeetingLibraryViewerAuth({
    repository,
    secret: COOKIE_SECRET,
    secureCookie: false,
    isSharingEnabled: () => service.enabled,
  });
  try {
    await service.ensureLibrary(LIBRARY_ID, "品管錄音庫");
    const library = await service.authorize("NW8-K9Q");
    await service.assertSessionCapabilityActive(LIBRARY_ID, 1);
    const capture = responseCapture();
    auth.setViewer(requestWithCookie(), capture.response, library);
    const cookie = capture.cookies[0]?.split(";", 1)[0] ?? "";
    assert.equal((await auth.requireViewer(requestWithCookie(cookie))).libraryId, LIBRARY_ID);

    const rotated = await service.rotateCode(LIBRARY_ID);
    assert.equal(rotated.code, "Q7M-X8P");
    assert.equal(rotated.library.codeHint, "Q**-**P");
    await assert.rejects(
      service.assertSessionCapabilityActive(LIBRARY_ID, 1),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED"
        )
    );
    await service.assertSessionCapabilityActive(LIBRARY_ID, 2);
    await assert.rejects(
      auth.requireViewer(requestWithCookie(cookie)),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_VIEWER_EXPIRED"
        )
    );
    await assert.rejects(
      service.authorize("NW8-K9Q"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_CODE_INVALID"
        )
    );
    assert.equal((await service.authorize("q7m-x8p")).accessVersion, 2);
  } finally {
    await service.close();
  }
});

test("錄音庫名稱拒絕空白與過長內容", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => "NW8K9Q",
  });
  try {
    await assert.rejects(
      service.ensureLibrary(LIBRARY_ID),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_NAME_REQUIRED"
        )
    );
    await assert.rejects(
      service.ensureLibrary(LIBRARY_ID, "   "),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_NAME_REQUIRED"
        )
    );
    await assert.rejects(
      service.ensureLibrary(LIBRARY_ID, "會".repeat(61)),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_NAME_INVALID"
        )
    );
  } finally {
    await service.close();
  }
});

test("舊 Code 提示回填遇到同步重設時不會取得新版錄音庫權限", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => "Q7MX8P",
  });
  const oldDigest = createHmac("sha256", PEPPER)
    .update("meeting-library-code-v1.NW8K9Q")
    .digest("hex");
  try {
    await repository.createLibrary({
      libraryId: LIBRARY_ID,
      codeDigest: oldDigest,
      displayName: "舊錄音庫",
      codeHint: null,
      now: "2026-07-16T08:00:00.000Z",
    });
    const updateCodeHintIfMissing = repository.updateCodeHintIfMissing.bind(repository);
    repository.updateCodeHintIfMissing = async (input) => {
      await service.rotateCode(LIBRARY_ID);
      return updateCodeHintIfMissing(input);
    };

    await assert.rejects(
      service.authorize("NW8-K9Q"),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_CODE_INVALID"
        )
    );
    const current = await repository.getLibrary(LIBRARY_ID);
    assert.equal(current?.accessVersion, 2);
    assert.equal(current?.codeHint, "Q**-**P");
    assert.equal((await service.authorize("Q7M-X8P")).accessVersion, 2);
  } finally {
    await service.close();
  }
});

test("viewer cookie 由 server 驗證到期時間，且分享功能停用後立即失效", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => "NW8K9Q",
  });
  let nowMs = 1_000;
  let sharingEnabled = true;
  const auth = createMeetingLibraryViewerAuth({
    repository,
    secret: COOKIE_SECRET,
    secureCookie: false,
    nowMs: () => nowMs,
    maxAgeMs: 5_000,
    isSharingEnabled: () => sharingEnabled,
  });
  try {
    await service.ensureLibrary(LIBRARY_ID, "品管錄音庫");
    const library = await service.authorize("NW8-K9Q");
    const capture = responseCapture();
    auth.setViewer(requestWithCookie(), capture.response, library);
    const cookie = capture.cookies[0]?.split(";", 1)[0] ?? "";

    assert.equal((await auth.requireViewer(requestWithCookie(cookie))).libraryId, LIBRARY_ID);

    nowMs = 6_000;
    await assert.rejects(
      auth.requireViewer(requestWithCookie(cookie)),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_VIEWER_EXPIRED"
        )
    );

    nowMs = 2_000;
    sharingEnabled = false;
    await assert.rejects(
      auth.requireViewer(requestWithCookie(cookie)),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED"
        )
    );
  } finally {
    await service.close();
  }
});

test("同一 library 同時重設時只允許一筆進入 mutation", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const codes = ["NW8K9Q", "Q7MX8P"];
  const service = new MeetingLibraryAccessService({
    repository,
    pepper: PEPPER,
    codeFactory: () => codes.shift() ?? "Q7MX8P",
  });
  const originalRotateCode = repository.rotateCode.bind(repository);
  let releaseRotation!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  repository.rotateCode = async (input) => {
    markEntered();
    await release;
    return originalRotateCode(input);
  };
  try {
    await service.ensureLibrary(LIBRARY_ID, "品管錄音庫");
    const first = service.rotateCode(LIBRARY_ID);
    await entered;
    await assert.rejects(
      service.rotateCode(LIBRARY_ID),
      (error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "MEETING_LIBRARY_CODE_ROTATION_IN_PROGRESS"
        )
    );
    releaseRotation();
    assert.equal((await first).code, "Q7M-X8P");
  } finally {
    releaseRotation?.();
    await service.close();
  }
});
