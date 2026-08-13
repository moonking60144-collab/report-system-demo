import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorHandler } from "../../src/middleware/errorHandler";
import { createMeetingRecordingsRouter } from "../../src/routes/meetingRecordings";
import { createMeetingRecordingOwnerAuth } from "../../src/services/meeting-minutes/meetingRecordingOwnerAuth";
import { MeetingLibraryAccessService } from "../../src/services/meeting-minutes/meetingLibraryAccessService";
import { MeetingLibraryAccessAttemptGuard } from "../../src/services/meeting-minutes/meetingLibraryAccessAttemptGuard";
import { createMeetingLibraryViewerAuth } from "../../src/services/meeting-minutes/meetingLibraryViewerAuth";
import { MeetingRecordingStorageService } from "../../src/services/meeting-minutes/meetingRecordingStorageService";
import { MeetingProcessingService } from "../../src/services/meeting-minutes/meetingProcessingService";
import { MeetingTranscriptionService } from "../../src/services/meeting-minutes/meetingTranscriptionService";
import { MeetingMinutesService } from "../../src/services/meeting-minutes/meetingMinutesService";
import { MeetingMinutesPackageService } from "../../src/services/meeting-minutes/meetingMinutesPackageService";
import type { MeetingMinutesProviderLike } from "../../src/services/meeting-minutes/meetingMinutesProvider";
import type { MeetingTranscriptProcessorLike } from "../../src/services/meeting-minutes/meetingTranscriptProcessor";
import { MeetingProcessingJobRepository } from "../../src/storage/meeting-minutes/meetingProcessingJobRepository";
import { MeetingTranscriptionJobRepository } from "../../src/storage/meeting-minutes/meetingTranscriptionJobRepository";
import { MeetingMinutesJobRepository } from "../../src/storage/meeting-minutes/meetingMinutesJobRepository";
import { MeetingLibraryRepository } from "../../src/storage/meeting-minutes/meetingLibraryRepository";
import { HttpError } from "../../src/utils/httpError";

const SESSION_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const OWNER_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const OWNER_LIBRARY_CODES = ["NW8-K9Q", "Q7M-X8P"];
const PROCESSING_JOB_IDS = [
  "99999999-9999-4999-8999-999999999999",
  "88888888-8888-4888-8888-888888888888",
];
const TRANSCRIPTION_JOB_IDS = [
  "77777777-7777-4777-8777-777777777777",
  "66666666-6666-4666-8666-666666666666",
];

function ownerCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

function namedCookie(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  assert.ok(match, `missing ${name} cookie`);
  return `${name}=${match[1]}`;
}

function ownerHeaders(cookie: string, headers: Record<string, string> = {}) {
  return { Cookie: cookie, "X-Meeting-Request": "1", ...headers };
}

async function withTestServer(
  run: (
    baseUrl: string,
    root: string,
    context: {
      processingRepository: MeetingProcessingJobRepository;
      processingService: MeetingProcessingService;
      transcriptionRepository: MeetingTranscriptionJobRepository;
      transcriptionService: MeetingTranscriptionService;
      minutesRepository: MeetingMinutesJobRepository;
      minutesService: MeetingMinutesService;
      libraryRepository: MeetingLibraryRepository;
      libraryService: MeetingLibraryAccessService;
    }
  ) => Promise<void>,
  options: {
    ownerSecret?: string;
    secureCookie?: boolean;
    workerEnabled?: boolean;
    transcriptionProviderEnabled?: boolean;
    minutesProviderEnabled?: boolean;
    libraryPepper?: string;
    adminToken?: string;
    nowMs?: () => number;
    recorderMaxAgeMs?: number;
    sessionCapabilityMaxAgeMs?: number;
    failSessionCapabilityCookie?: boolean;
    precreateLibraries?: boolean;
    libraryAccessAttemptGuard?: MeetingLibraryAccessAttemptGuard;
  } = {}
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-route-"));
  let sessionIndex = 0;
  let ownerIndex = 0;
  let processingJobIndex = 0;
  let transcriptionJobIndex = 0;
  const service = new MeetingRecordingStorageService({
    storageDir: root,
    maxTotalBytes: 1024,
    maxSessionBytes: 1024,
    maxChunkBytes: 128,
    staleSessionMs: 60_000,
    now: options.nowMs ? () => new Date(options.nowMs!()) : undefined,
    idFactory: () => SESSION_IDS[sessionIndex++] ?? SESSION_IDS[SESSION_IDS.length - 1],
  });
  const ownerAuth = createMeetingRecordingOwnerAuth({
    secret: options.ownerSecret ?? "meeting-route-test-secret-at-least-32-bytes",
    secureCookie: options.secureCookie ?? false,
    ownerIdFactory: () => OWNER_IDS[ownerIndex++] ?? OWNER_IDS[OWNER_IDS.length - 1],
  });
  const processingDir = path.join(root, "processing");
  const processingRepository = new MeetingProcessingJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const processingService = new MeetingProcessingService({
    repository: processingRepository,
    recordingStorage: service,
    audioProcessor: {
      process: async () => [],
      resolveArtifactPath: (relativePath) => path.join(processingDir, relativePath),
      cleanupTrash: async () => undefined,
      removeSessionAudioArtifacts: async () => false,
    },
    idFactory: () =>
      PROCESSING_JOB_IDS[processingJobIndex++] ??
      PROCESSING_JOB_IDS[PROCESSING_JOB_IDS.length - 1],
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const transcriptionRepository = new MeetingTranscriptionJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const transcriptProcessor: MeetingTranscriptProcessorLike = {
    enabled: options.transcriptionProviderEnabled ?? true,
    providerName: options.transcriptionProviderEnabled === false ? "disabled" : "fake",
    model: options.transcriptionProviderEnabled === false ? "disabled" : "fake-model",
    process: async () => [],
    resolveArtifactPath: (relativePath) => path.join(processingDir, relativePath),
  };
  const transcriptionService = new MeetingTranscriptionService({
    repository: transcriptionRepository,
    processingRepository,
    processingService,
    transcriptProcessor,
    idFactory: () =>
      TRANSCRIPTION_JOB_IDS[transcriptionJobIndex++] ??
      TRANSCRIPTION_JOB_IDS[TRANSCRIPTION_JOB_IDS.length - 1],
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const minutesRepository = new MeetingMinutesJobRepository(
    path.join(root, "processing.sqlite3")
  );
  const minutesProvider: MeetingMinutesProviderLike = {
    enabled: options.minutesProviderEnabled ?? true,
    name: options.minutesProviderEnabled === false ? "disabled" : "fake-minutes",
    model: options.minutesProviderEnabled === false ? "disabled" : "fake-model",
    async summarize() {
      return {
        version: 1,
        title: "AI 會議",
        date: null,
        subtitle: "會議摘要",
        attendees: [],
        executiveSummary: "已整理會議重點。",
        discussionPoints: [],
        confirmedFacts: [],
        confirmedDecisions: [],
        systemRequirements: [],
        pendingItems: [],
        followUpActions: [],
        uncertainTerms: [],
      };
    },
  };
  let minutesId = 0;
  const minutesService = new MeetingMinutesService({
    repository: minutesRepository,
    transcriptionService,
    processingService,
    packageService: new MeetingMinutesPackageService({ processingDir }),
    provider: minutesProvider,
    idFactory: () => `minutes-id-${++minutesId}`,
    maxAttempts: 3,
    workerEnabled: options.workerEnabled ?? true,
  });
  const libraryRepository = new MeetingLibraryRepository(
    path.join(root, "processing.sqlite3")
  );
  const libraryService = new MeetingLibraryAccessService({
    repository: libraryRepository,
    pepper:
      options.libraryPepper ??
      "meeting-library-route-test-pepper-at-least-32-bytes",
    codeFactory: (() => {
      const codes = ["NW8K9Q", "Q7MX8P", "B6RC7T", "C8VD9W"];
      return () => codes.shift() ?? "D9XE2Y";
    })(),
  });
  if (libraryService.enabled && options.precreateLibraries !== false) {
    await libraryService.ensureLibrary(OWNER_IDS[0], "Quality Weekly");
    await libraryService.ensureLibrary(OWNER_IDS[1], "Production Daily");
  }
  const baseViewerAuth = createMeetingLibraryViewerAuth({
    repository: libraryRepository,
    secret: options.ownerSecret ?? "meeting-route-test-secret-at-least-32-bytes",
    secureCookie: options.secureCookie ?? false,
    nowMs: options.nowMs,
    maxAgeMs: options.recorderMaxAgeMs,
    isSharingEnabled: () => libraryService.enabled,
  });
  const viewerAuth = options.failSessionCapabilityCookie
    ? {
        ...baseViewerAuth,
        setSessionCapability() {
          throw new Error("injected session capability cookie failure");
        },
      }
    : baseViewerAuth;
  const adminToken = options.adminToken ?? "meeting-admin-token";
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api",
    createMeetingRecordingsRouter(
      service,
      ownerAuth,
      processingService,
      transcriptionService,
      minutesService,
      {
        libraryService,
        viewerAuth,
        libraryAccessAttemptGuard: options.libraryAccessAttemptGuard,
        nowMs: options.nowMs,
        sessionCapabilityMaxAgeMs: options.sessionCapabilityMaxAgeMs,
        verifyAdminToken: (authorizationHeader) => {
          if (authorizationHeader !== `Bearer ${adminToken}`) {
            throw new HttpError(401, "缺少授權資訊", "NOTICE_TOKEN_MISSING");
          }
          return { username: "meeting-admin" };
        },
      }
    )
  );
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, root, {
      processingRepository,
      processingService,
      transcriptionRepository,
      transcriptionService,
      minutesRepository,
      minutesService,
      libraryRepository,
      libraryService,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await minutesService.close();
    await transcriptionService.close();
    await processingService.close();
    await libraryService.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("recording owner cookie 可依 runtime 設定切換 Secure 屬性", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/i);
  });

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.match(response.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/i);
  }, { secureCookie: true });
});

test("Meeting 錄音庫兩個存取入口共用 browser 節流且不鎖住同 IP 其他 browser", async () => {
  const guard = new MeetingLibraryAccessAttemptGuard({
    clientMaxFailures: 2,
    ipMaxFailures: 100,
  });
  await withTestServer(
    async (baseUrl) => {
      const firstFailure = await fetch(`${baseUrl}/api/meetings/library-access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Meeting-Request": "1",
          "x-debug-client-id": "client-browser-a",
        },
        body: JSON.stringify({ code: "BAD-CODE" }),
      });
      assert.equal(firstFailure.status, 401);

      const limited = await fetch(
        `${baseUrl}/api/meetings/recordings/library-access`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Meeting-Request": "1",
            "x-debug-client-id": "client-browser-a",
          },
          body: JSON.stringify({ code: "BAD-CODE" }),
        }
      );
      assert.equal(limited.status, 429);
      const limitedPayload = (await limited.json()) as { error: { code: string } };
      assert.equal(
        limitedPayload.error.code,
        "MEETING_LIBRARY_ACCESS_RATE_LIMITED"
      );

      const otherBrowser = await fetch(`${baseUrl}/api/meetings/library-access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Meeting-Request": "1",
          "x-debug-client-id": "client-browser-b",
        },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
      });
      assert.equal(otherBrowser.status, 200);
    },
    { libraryAccessAttemptGuard: guard }
  );
});

test("recording API 完成 create → chunks → finalize，並支援播放器 Range request", async () => {
  await withTestServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "測試會議", sourceIds: ["room-mic"] }),
    });
    assert.equal(createResponse.status, 201);
    const cookie = ownerCookie(createResponse);
    const created = (await createResponse.json()) as { data: { sessionId: string } };

    const chunkResponse = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: ownerHeaders(cookie, { "Content-Type": "audio/webm" }),
        body: Buffer.from("audio-body"),
      }
    );
    assert.equal(chunkResponse.status, 200);

    const finalizeResponse = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    assert.equal(finalizeResponse.status, 200);

    const trackResponse = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(trackResponse.status, 200);
    assert.match(trackResponse.headers.get("content-type") ?? "", /^audio\/webm/);
    assert.equal(await trackResponse.text(), "audio-body");

    const rangeResponse = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic`,
      { headers: { Cookie: cookie, Range: "bytes=0-4" } }
    );
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("accept-ranges"), "bytes");
    assert.equal(rangeResponse.headers.get("content-range"), "bytes 0-4/10");
    assert.equal(await rangeResponse.text(), "audio");
  });
});

test("recording API 將不支援格式與不完整 finalize 回成 typed 4xx", async () => {
  await withTestServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ sourceIds: ["room-mic"] }),
      });
    const cookie = ownerCookie(createResponse);
    const created = (await createResponse.json()) as { data: { sessionId: string } };

    const invalidChunk = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({ audio: false }),
      }
    );
    assert.equal(invalidChunk.status, 400);

    const incomplete = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    assert.equal(incomplete.status, 409);
    const payload = (await incomplete.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "MEETING_RECORDING_CHUNKS_INCOMPLETE");
  });
});

test("recording API 以簽章 owner cookie 隔離列舉與所有 session 操作", async () => {
  await withTestServer(async (baseUrl) => {
    const unauthenticatedList = await fetch(`${baseUrl}/api/meetings/recordings`);
    assert.equal(unauthenticatedList.status, 401);

    const missingIntent = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.equal(missingIntent.status, 403);

    const firstCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "第一位 owner", sourceIds: ["room-mic"] }),
    });
    const firstCookie = ownerCookie(firstCreate);
    const first = (await firstCreate.json()) as { data: { sessionId: string } };

    const secondCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "第二位 owner", sourceIds: ["room-mic"] }),
    });
    const secondCookie = ownerCookie(secondCreate);
    const second = (await secondCreate.json()) as { data: { sessionId: string } };

    const firstList = await fetch(`${baseUrl}/api/meetings/recordings`, {
      headers: { Cookie: firstCookie },
    });
    assert.equal(firstList.status, 200);
    const firstSessions = (await firstList.json()) as { data: Array<{ sessionId: string }> };
    assert.deepEqual(firstSessions.data.map((item) => item.sessionId), [first.data.sessionId]);
    assert.notEqual(first.data.sessionId, second.data.sessionId);

    const crossOwnerRequests = [
      fetch(`${baseUrl}/api/meetings/recordings/${first.data.sessionId}`, {
        headers: { Cookie: secondCookie },
      }),
      fetch(
        `${baseUrl}/api/meetings/recordings/${first.data.sessionId}/tracks/room-mic/chunks/0`,
        {
          method: "PUT",
          headers: ownerHeaders(secondCookie, { "Content-Type": "audio/webm" }),
          body: Buffer.from("foreign-audio"),
        }
      ),
      fetch(`${baseUrl}/api/meetings/recordings/${first.data.sessionId}/finalize`, {
        method: "POST",
        headers: ownerHeaders(secondCookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          durationMs: 1_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }),
      fetch(`${baseUrl}/api/meetings/recordings/${first.data.sessionId}/abort`, {
        method: "POST",
        headers: ownerHeaders(secondCookie),
      }),
      fetch(
        `${baseUrl}/api/meetings/recordings/${first.data.sessionId}/tracks/room-mic`,
        { headers: { Cookie: secondCookie } }
      ),
    ];
    for (const response of await Promise.all(crossOwnerRequests)) {
      assert.equal(response.status, 404);
    }

    const ownerStillHasSession = await fetch(
      `${baseUrl}/api/meetings/recordings/${first.data.sessionId}`,
      { headers: { Cookie: firstCookie } }
    );
    assert.equal(ownerStillHasSession.status, 200);

    const tamperedCookie = `${firstCookie.slice(0, -1)}x`;
    const tamperedList = await fetch(`${baseUrl}/api/meetings/recordings`, {
      headers: { Cookie: tamperedCookie },
    });
    assert.equal(tamperedList.status, 401);
  });
});

test("recording owner secret 未設定時 Meeting API fail-closed，不影響 router 啟動", async () => {
  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "MEETING_RECORDING_AUTH_NOT_CONFIGURED");
  }, { ownerSecret: "" });
});

test("Library pepper 未設定時錄音仍可建立，分享功能回 disabled", async () => {
  await withTestServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.equal(createResponse.status, 201);
    const cookie = ownerCookie(createResponse);
    const payload = (await createResponse.json()) as {
      data: { sessionId: string };
      meta: {
        libraryAccessEnabled: boolean;
        library: null;
        libraryCode: null;
      };
    };
    assert.equal(payload.meta.libraryAccessEnabled, false);
    assert.equal(payload.meta.library, null);
    assert.equal(payload.meta.libraryCode, null);

    const library = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      headers: { Cookie: cookie },
    });
    assert.equal(library.status, 200);
    assert.deepEqual(await library.json(), {
      data: {
        enabled: false,
        library: null,
        ownedLibrary: null,
        accessMode: "owner",
      },
    });
  }, { libraryPepper: "" });
});

test("owner 可建立並重新命名錄音庫，所有存取面只回傳首尾明文的 Code 提示", async () => {
  await withTestServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ displayName: "  2026 年 品管會議  " }),
    });
    assert.equal(created.status, 201);
    const owner = ownerCookie(created);
    const createdPayload = (await created.json()) as {
      data: {
        library: { displayName: string; codeHint: string; setupState: string };
        code: string;
      };
    };
    assert.equal(createdPayload.data.library.displayName, "2026 年 品管會議");
    assert.equal(createdPayload.data.library.setupState, "ready");
    assert.equal(
      createdPayload.data.library.codeHint,
      `${createdPayload.data.code[0]}**-**${createdPayload.data.code.at(-1)}`
    );
    assert.match(createdPayload.data.library.codeHint, /^[2-9A-HJ-NP-Z]\*\*-\*\*[2-9A-HJ-NP-Z]$/);

    const renamed = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      method: "PATCH",
      headers: ownerHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: "七月品質週會" }),
    });
    assert.equal(renamed.status, 200);
    const renamedPayload = (await renamed.json()) as {
      data: { library: { displayName: string; codeHint: string }; code: null };
    };
    assert.equal(renamedPayload.data.library.displayName, "七月品質週會");
    assert.equal(renamedPayload.data.library.codeHint, createdPayload.data.library.codeHint);
    assert.equal(renamedPayload.data.code, null);

    const selected = await fetch(`${baseUrl}/api/meetings/recordings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: createdPayload.data.code }),
    });
    assert.equal(selected.status, 200);
    const recorder = namedCookie(selected, "meeting_library_recorder_v1");
    const selectedPayload = (await selected.json()) as {
      data: { library: { displayName: string; codeHint: string } };
    };
    assert.deepEqual(selectedPayload.data.library, renamedPayload.data.library);

    const recorderRename = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      method: "PATCH",
      headers: ownerHeaders(recorder, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: "不可修改" }),
    });
    assert.equal(recorderRename.status, 401);

    const invalidName = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      method: "PATCH",
      headers: ownerHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: "   " }),
    });
    assert.equal(invalidName.status, 400);
    const invalidPayload = (await invalidName.json()) as { error: { code: string } };
    assert.equal(invalidPayload.error.code, "MEETING_LIBRARY_NAME_REQUIRED");

    const duplicate = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      method: "POST",
      headers: ownerHeaders(owner, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: "第二個本機錄音庫" }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal(
      ((await duplicate.json()) as { error: { code: string } }).error.code,
      "MEETING_LIBRARY_ALREADY_EXISTS"
    );
  }, { precreateLibraries: false });
});

test("分享模式啟用時未完成錄音庫設定不會先建立 session", async () => {
  await withTestServer(async (baseUrl) => {
    const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.equal(create.status, 409);
    assert.equal(
      ((await create.json()) as { error: { code: string } }).error.code,
      "MEETING_LIBRARY_SETUP_REQUIRED"
    );
    const cookie = ownerCookie(create);
    const list = await fetch(`${baseUrl}/api/meetings/recordings`, {
      headers: { Cookie: cookie },
    });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { data: [] });
  }, { precreateLibraries: false });
});

test("owner 可確認舊 Code 補齊缺少的提示後再開始錄音", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const establishOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    const cookie = ownerCookie(establishOwner);
    const codeDigest = createHmac(
      "sha256",
      "meeting-library-route-test-pepper-at-least-32-bytes"
    )
      .update("meeting-library-code-v1.NW8K9Q")
      .digest("hex");
    await context.libraryRepository.createLibrary({
      libraryId: OWNER_IDS[0],
      codeDigest,
      displayName: "舊版品管錄音庫",
      codeHint: null,
      now: "2026-07-16T08:00:00.000Z",
    });

    const before = await fetch(`${baseUrl}/api/meetings/recordings/library`, {
      headers: { Cookie: cookie },
    });
    const beforePayload = (await before.json()) as {
      data: { library: { setupState: string; missingFields: string[] } };
    };
    assert.equal(beforePayload.data.library.setupState, "incomplete");
    assert.deepEqual(beforePayload.data.library.missingFields, ["codeHint"]);

    const confirm = await fetch(
      `${baseUrl}/api/meetings/recordings/library/confirm-code`,
      {
        method: "POST",
        headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({ code: "NW8-K9Q" }),
      }
    );
    assert.equal(confirm.status, 200);
    const confirmed = (await confirm.json()) as {
      data: { library: { setupState: string; codeHint: string } };
    };
    assert.equal(confirmed.data.library.setupState, "ready");
    assert.equal(confirmed.data.library.codeHint, "N**-**Q");

    const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    assert.equal(create.status, 201);
  }, { precreateLibraries: false });
});

test("Library Code 建立一次、viewer 唯讀且 rotate 會撤銷舊 Code 與 cookie", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "品管會議");
    await createReadyProcessingJob(baseUrl, root, context, recording);
    await createReadyTranscriptionJob(baseUrl, root, context, recording);

    const minutesAccepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes`,
      {
        method: "POST",
        headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          clientRequestKey: "viewer-minutes",
          title: "品管會議",
        }),
      }
    );
    assert.equal(minutesAccepted.status, 202);
    const claimedMinutes = await context.minutesRepository.claimNext({
      workerId: "viewer-minutes-worker",
      now: "2026-07-16T08:04:00.000Z",
      leaseExpiresAt: "2026-07-16T08:14:00.000Z",
    });
    assert.ok(claimedMinutes);
    const readyMinutes = await context.minutesService.processClaimedJob(
      claimedMinutes,
      "viewer-minutes-worker"
    );
    assert.equal(readyMinutes.status, "ready");

    const secondCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "第二場", sourceIds: ["room-mic"] }),
    });
    assert.equal(secondCreate.status, 201);
    const secondPayload = (await secondCreate.json()) as {
      meta: { libraryCode: string | null };
    };
    assert.equal(secondPayload.meta.libraryCode, null);

    const authorize = await fetch(`${baseUrl}/api/meetings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: recording.libraryCode.toLowerCase().replace("-", " ") }),
    });
    assert.equal(authorize.status, 200);
    const viewerCookie = ownerCookie(authorize);

    const list = await fetch(`${baseUrl}/api/meetings/library/recordings`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(list.status, 200);
    const listPayload = (await list.json()) as {
      data: Array<{ sessionId: string }>;
      meta: { nextCursor: string | null; hasMore: boolean };
    };
    assert.equal(listPayload.data.length, 2);
    assert.deepEqual(listPayload.meta, { nextCursor: null, hasMore: false });

    const detail = await fetch(
      `${baseUrl}/api/meetings/library/recordings/${recording.sessionId}`,
      { headers: { Cookie: viewerCookie } }
    );
    assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.doesNotMatch(detailText, /ownerId|relativePath|packageRelativePath/);
    const detailPayload = JSON.parse(detailText) as {
      data: {
        processingJob: { artifacts: Array<{ downloadUrl: string }> };
        transcriptionJob: { artifacts: Array<{ downloadUrl: string }> };
        minutesVersions: Array<{ packageUrl: string }>;
      };
    };
    const viewerDownloads = [
      detailPayload.data.processingJob.artifacts[0]?.downloadUrl,
      detailPayload.data.transcriptionJob.artifacts[0]?.downloadUrl,
      detailPayload.data.minutesVersions[0]?.packageUrl,
    ];
    for (const downloadUrl of viewerDownloads) {
      assert.ok(downloadUrl?.startsWith("/api/meetings/library/recordings/"));
      const response = await fetch(`${baseUrl}${downloadUrl}`, {
        headers: { Cookie: viewerCookie },
      });
      assert.equal(response.status, 200);
    }

    const track = await fetch(
      `${baseUrl}/api/meetings/library/recordings/${recording.sessionId}/tracks/room-mic`,
      { headers: { Cookie: viewerCookie, Range: "bytes=0-4" } }
    );
    assert.equal(track.status, 206);
    assert.equal(await track.text(), "audio");

    const viewerMutation = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/process`,
      { method: "POST", headers: ownerHeaders(viewerCookie) }
    );
    assert.equal(viewerMutation.status, 401);

    const otherOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "其他錄音庫", sourceIds: ["room-mic"] }),
    });
    const otherSession = (await otherOwner.json()) as { data: { sessionId: string } };
    const crossLibrary = await fetch(
      `${baseUrl}/api/meetings/library/recordings/${otherSession.data.sessionId}`,
      { headers: { Cookie: viewerCookie } }
    );
    assert.equal(crossLibrary.status, 404);

    const rotate = await fetch(
      `${baseUrl}/api/meetings/recordings/library/rotate-code`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    assert.equal(rotate.status, 200);
    const rotatePayload = (await rotate.json()) as { data: { code: string } };
    assert.notEqual(rotatePayload.data.code, recording.libraryCode);

    const revokedViewer = await fetch(`${baseUrl}/api/meetings/library/recordings`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(revokedViewer.status, 401);

    const revokedCode = await fetch(`${baseUrl}/api/meetings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: recording.libraryCode }),
    });
    assert.equal(revokedCode.status, 401);

    const replacementCode = await fetch(`${baseUrl}/api/meetings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: rotatePayload.data.code }),
    });
    assert.equal(replacementCode.status, 200);
  });
});

test("既有 Library Code 可選為錄音目的地，但不能取得 Code 管理權", async () => {
  await withTestServer(async (baseUrl) => {
    const firstCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "原錄音庫", sourceIds: ["room-mic"] }),
    });
    assert.equal(firstCreate.status, 201);
    const firstPayload = (await firstCreate.json()) as {
      data: { sessionId: string };
      meta: { library: { libraryId: string }; libraryCode: string };
    };
    const firstOwnerCookie = ownerCookie(firstCreate);

    const select = await fetch(`${baseUrl}/api/meetings/recordings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
    });
    assert.equal(select.status, 200);
    const recorderCookie = namedCookie(select, "meeting_library_recorder_v1");
    const selectedPayload = (await select.json()) as {
      data: { library: { libraryId: string }; accessMode: string };
    };
    assert.equal(selectedPayload.data.library.libraryId, firstPayload.meta.library.libraryId);
    assert.equal(selectedPayload.data.accessMode, "recorder");

    const secondCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(recorderCookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "接續錄音", sourceIds: ["room-mic"] }),
    });
    assert.equal(secondCreate.status, 201);

    const list = await fetch(`${baseUrl}/api/meetings/recordings`, {
      headers: { Cookie: recorderCookie },
    });
    assert.equal(list.status, 200);
    const listPayload = (await list.json()) as { data: Array<{ title: string }> };
    assert.deepEqual(
      listPayload.data.map((recording) => recording.title),
      ["接續錄音", "原錄音庫"]
    );

    const rotate = await fetch(`${baseUrl}/api/meetings/recordings/library/rotate-code`, {
      method: "POST",
      headers: ownerHeaders(recorderCookie),
    });
    assert.equal(rotate.status, 401);
    const rotatePayload = (await rotate.json()) as { error: { code: string } };
    assert.equal(rotatePayload.error.code, "MEETING_RECORDING_OWNER_REQUIRED");

    const ownerRotate = await fetch(
      `${baseUrl}/api/meetings/recordings/library/rotate-code`,
      { method: "POST", headers: ownerHeaders(firstOwnerCookie) }
    );
    assert.equal(ownerRotate.status, 200);

    const revokedRecorder = await fetch(`${baseUrl}/api/meetings/recordings`, {
      headers: { Cookie: recorderCookie },
    });
    assert.equal(revokedRecorder.status, 401);
    const revokedPayload = (await revokedRecorder.json()) as { error: { code: string } };
    assert.equal(revokedPayload.error.code, "MEETING_LIBRARY_RECORDER_EXPIRED");
  });
});

test("同一 Library Code 的不同 recorder 不能接管彼此 session，原分頁 capability 不受 cookie 切換影響", async () => {
  await withTestServer(async (baseUrl) => {
    const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "錄音庫來源", sourceIds: ["room-mic"] }),
    });
    const ownerPayload = (await ownerCreate.json()) as {
      meta: { library: { libraryId: string }; libraryCode: string };
    };
    const authorize = () =>
      fetch(`${baseUrl}/api/meetings/recordings/library-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
      });
    const firstSelect = await authorize();
    const secondSelect = await authorize();
    const firstRecorderCookie = namedCookie(
      firstSelect,
      "meeting_library_recorder_v1"
    );
    const secondRecorderCookie = namedCookie(
      secondSelect,
      "meeting_library_recorder_v1"
    );
    assert.notEqual(firstRecorderCookie, secondRecorderCookie);

    const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(firstRecorderCookie, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        title: "第一位錄音者",
        sourceIds: ["room-mic"],
        libraryId: ownerPayload.meta.library.libraryId,
      }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as {
      data: { sessionId: string };
      meta: { sessionCapability: string | null };
    };
    assert.match(created.meta.sessionCapability ?? "", /^[A-Za-z0-9_-]{43}$/);
    const sessionCapabilityCookie = namedCookie(
      create,
      "meeting_recording_session_v1"
    );
    const sessionSetCookie = create.headers.get("set-cookie") ?? "";
    assert.match(
      sessionSetCookie,
      new RegExp(
        `meeting_recording_session_v1=[A-Za-z0-9_-]{43}; Path=/api/meetings/recordings/${created.data.sessionId}`
      )
    );
    assert.match(sessionSetCookie, /HttpOnly/);

    const crossRecorderAbort = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/abort`,
      { method: "POST", headers: ownerHeaders(secondRecorderCookie) }
    );
    assert.equal(crossRecorderAbort.status, 401);
    assert.equal(
      ((await crossRecorderAbort.json()) as { error: { code: string } }).error.code,
      "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED"
    );

    const cookieOnlyAbort = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/abort`,
      {
        method: "POST",
        headers: ownerHeaders(
          `${secondRecorderCookie}; ${sessionCapabilityCookie}`
        ),
      }
    );
    assert.equal(cookieOnlyAbort.status, 401);
    assert.equal(
      ((await cookieOnlyAbort.json()) as { error: { code: string } }).error.code,
      "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED"
    );

    const capabilityHeaders = ownerHeaders(secondRecorderCookie, {
      "X-Meeting-Session-Capability": created.meta.sessionCapability!,
    });
    const chunk = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: { ...capabilityHeaders, "Content-Type": "audio/webm" },
        body: Buffer.from("recorder-audio"),
      }
    );
    assert.equal(chunk.status, 200);

    const finalized = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: { ...capabilityHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    assert.equal(finalized.status, 200);

    const directPlayback = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic`,
      {
        headers: {
          Cookie: `${secondRecorderCookie}; ${sessionCapabilityCookie}`,
        },
      }
    );
    assert.equal(directPlayback.status, 200);
    assert.equal(await directPlayback.text(), "recorder-audio");
  });
});

test("跨分頁恢復的 recorder job 可使用 session HttpOnly capability cookie", async () => {
  await withTestServer(async (baseUrl) => {
    const firstOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "本機 owner Library", sourceIds: ["room-mic"] }),
    });
    const firstOwnerCookie = ownerCookie(firstOwner);

    const secondOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "遠端 recorder Library", sourceIds: ["room-mic"] }),
    });
    const secondPayload = (await secondOwner.json()) as {
      meta: { library: { libraryId: string } };
    };

    const selectSecond = await fetch(
      `${baseUrl}/api/meetings/recordings/library-access`,
      {
        method: "POST",
        headers: {
          Cookie: firstOwnerCookie,
          "Content-Type": "application/json",
          "X-Meeting-Request": "1",
        },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[1] }),
      }
    );
    const recorderCookie = namedCookie(selectSecond, "meeting_library_recorder_v1");
    const ownerAndRecorderCookies = `${firstOwnerCookie}; ${recorderCookie}`;

    const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(ownerAndRecorderCookies, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        title: "跨分頁恢復錄音",
        sourceIds: ["room-mic"],
        libraryId: secondPayload.meta.library.libraryId,
      }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as {
      data: { sessionId: string };
      meta: { sessionCapability: string };
    };
    const sessionCapabilityCookie = namedCookie(
      create,
      "meeting_recording_session_v1"
    );
    const capabilityHeaders = ownerHeaders(ownerAndRecorderCookies, {
      "X-Meeting-Session-Capability": created.meta.sessionCapability,
    });

    const chunk = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: { ...capabilityHeaders, "Content-Type": "audio/webm" },
        body: Buffer.from("cross-tab-audio"),
      }
    );
    assert.equal(chunk.status, 200);
    const finalize = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: { ...capabilityHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    assert.equal(finalize.status, 200);

    const freshTabCookies = `${ownerAndRecorderCookies}; ${sessionCapabilityCookie}`;
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/process`,
      { method: "POST", headers: ownerHeaders(freshTabCookies) }
    );
    assert.equal(accepted.status, 202);
    const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/processing-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: freshTabCookies } }
    );
    assert.equal(status.status, 200);
  });
});

test("recorder 建立的新 session 使用獨立期限，跨過原 grant 到期點仍可完成錄音", async () => {
  const startedAtMs = Date.parse("2026-07-17T00:00:00.000Z");
  let nowMs = startedAtMs;
  await withTestServer(
    async (baseUrl) => {
      const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ title: "錄音庫來源", sourceIds: ["room-mic"] }),
      });
      const ownerPayload = (await ownerCreate.json()) as {
        meta: { library: { libraryId: string }; libraryCode: string };
      };
      const authorize = await fetch(
        `${baseUrl}/api/meetings/recordings/library-access`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
          body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
        }
      );
      const recorderCookie = namedCookie(authorize, "meeting_library_recorder_v1");

      nowMs = startedAtMs + 900;
      const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST",
        headers: ownerHeaders(recorderCookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          title: "跨 recorder grant 到期點",
          sourceIds: ["room-mic"],
          libraryId: ownerPayload.meta.library.libraryId,
        }),
      });
      assert.equal(create.status, 201);
      assert.match(create.headers.get("set-cookie") ?? "", /Max-Age=60/);
      const created = (await create.json()) as {
        data: { sessionId: string };
        meta: { sessionCapability: string };
      };

      nowMs = startedAtMs + 1_100;
      const capabilityHeaders = ownerHeaders(recorderCookie, {
        "X-Meeting-Session-Capability": created.meta.sessionCapability,
      });
      const chunk = await fetch(
        `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
        {
          method: "PUT",
          headers: { ...capabilityHeaders, "Content-Type": "audio/webm" },
          body: Buffer.from("recorder-audio"),
        }
      );
      assert.equal(chunk.status, 200);

      const finalized = await fetch(
        `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
        {
          method: "POST",
          headers: { ...capabilityHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            durationMs: 5_000,
            tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
          }),
        }
      );
      assert.equal(finalized.status, 200);
    },
    {
      nowMs: () => nowMs,
      recorderMaxAgeMs: 1_000,
      sessionCapabilityMaxAgeMs: 60_000,
    }
  );
});

test("recorder session capability cookie 寫入失敗時會回滾已建立的 session", async () => {
  await withTestServer(
    async (baseUrl, root) => {
      const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ title: "錄音庫來源", sourceIds: ["room-mic"] }),
      });
      const ownerPayload = (await ownerCreate.json()) as {
        meta: { library: { libraryId: string }; libraryCode: string };
      };
      const authorize = await fetch(
        `${baseUrl}/api/meetings/recordings/library-access`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
          body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
        }
      );
      const recorderCookie = namedCookie(authorize, "meeting_library_recorder_v1");

      const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
        method: "POST",
        headers: ownerHeaders(recorderCookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          title: "不可留下的孤兒 session",
          sourceIds: ["room-mic"],
          libraryId: ownerPayload.meta.library.libraryId,
        }),
      });

      assert.equal(create.status, 500);
      await assert.rejects(access(path.join(root, SESSION_IDS[1])));
    },
    { failSessionCapabilityCookie: true }
  );
});

test("owner 重設 Library Code 後會撤銷舊 recorder session capability", async () => {
  await withTestServer(async (baseUrl) => {
    const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "原始錄音", sourceIds: ["room-mic"] }),
    });
    assert.equal(ownerCreate.status, 201);
    const ownerCookieValue = ownerCookie(ownerCreate);
    const ownerPayload = (await ownerCreate.json()) as {
      meta: { library: { libraryId: string }; libraryCode: string };
    };

    const authorize = await fetch(
      `${baseUrl}/api/meetings/recordings/library-access`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
      }
    );
    assert.equal(authorize.status, 200);
    const recorderCookie = namedCookie(authorize, "meeting_library_recorder_v1");

    const recorderCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(recorderCookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: "待撤銷 session",
        sourceIds: ["room-mic"],
        libraryId: ownerPayload.meta.library.libraryId,
      }),
    });
    assert.equal(recorderCreate.status, 201);
    const recorderPayload = (await recorderCreate.json()) as {
      data: { sessionId: string };
      meta: { sessionCapability: string };
    };

    const rotate = await fetch(
      `${baseUrl}/api/meetings/recordings/library/rotate-code`,
      { method: "POST", headers: ownerHeaders(ownerCookieValue) }
    );
    assert.equal(rotate.status, 200);

    const chunk = await fetch(
      `${baseUrl}/api/meetings/recordings/${recorderPayload.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: {
          ...ownerHeaders(recorderCookie),
          "Content-Type": "audio/webm",
          "X-Meeting-Session-Capability": recorderPayload.meta.sessionCapability,
        },
        body: Buffer.from("revoked-audio"),
      }
    );
    assert.equal(chunk.status, 401);
    assert.equal(
      ((await chunk.json()) as { error: { code: string } }).error.code,
      "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED"
    );
  });
});

test("owner session 不會被另一分頁 recorder 中斷，失效 recorder 會回復 owner Library", async () => {
  await withTestServer(async (baseUrl) => {
    const firstOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "原 owner session", sourceIds: ["room-mic"] }),
    });
    assert.equal(firstOwner.status, 201);
    const firstOwnerCookie = ownerCookie(firstOwner);
    const firstPayload = (await firstOwner.json()) as {
      data: { sessionId: string };
    };

    const secondOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "另一錄音庫", sourceIds: ["room-mic"] }),
    });
    assert.equal(secondOwner.status, 201);
    const secondOwnerCookie = ownerCookie(secondOwner);
    const secondPayload = (await secondOwner.json()) as {
      meta: { libraryCode: string };
    };

    const selectSecond = await fetch(
      `${baseUrl}/api/meetings/recordings/library-access`,
      {
        method: "POST",
        headers: {
          Cookie: firstOwnerCookie,
          "Content-Type": "application/json",
          "X-Meeting-Request": "1",
        },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[1] }),
      }
    );
    assert.equal(selectSecond.status, 200);
    const selectedPayload = (await selectSecond.json()) as {
      data: {
        library: { libraryId: string };
        ownedLibrary: { libraryId: string };
        accessMode: string;
      };
    };
    assert.equal(selectedPayload.data.library.libraryId, OWNER_IDS[1]);
    assert.equal(selectedPayload.data.ownedLibrary.libraryId, OWNER_IDS[0]);
    assert.equal(selectedPayload.data.accessMode, "recorder");
    const combinedCookies = `${firstOwnerCookie}; ${namedCookie(
      selectSecond,
      "meeting_library_recorder_v1"
    )}`;

    const currentLibrary = await fetch(
      `${baseUrl}/api/meetings/recordings/library`,
      { headers: { Cookie: combinedCookies } }
    );
    assert.equal(currentLibrary.status, 200);
    const currentPayload = (await currentLibrary.json()) as {
      data: {
        library: { libraryId: string };
        ownedLibrary: { libraryId: string };
        accessMode: string;
      };
    };
    assert.equal(currentPayload.data.library.libraryId, OWNER_IDS[1]);
    assert.equal(currentPayload.data.ownedLibrary.libraryId, OWNER_IDS[0]);
    assert.equal(currentPayload.data.accessMode, "recorder");

    const chunk = await fetch(
      `${baseUrl}/api/meetings/recordings/${firstPayload.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: ownerHeaders(combinedCookies, { "Content-Type": "audio/webm" }),
        body: Buffer.from("owner-audio"),
      }
    );
    assert.equal(chunk.status, 200);

    const finalize = await fetch(
      `${baseUrl}/api/meetings/recordings/${firstPayload.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: ownerHeaders(combinedCookies, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    assert.equal(finalize.status, 200);

    const rotateSecond = await fetch(
      `${baseUrl}/api/meetings/recordings/library/rotate-code`,
      { method: "POST", headers: ownerHeaders(secondOwnerCookie) }
    );
    assert.equal(rotateSecond.status, 200);

    const recoveredLibrary = await fetch(
      `${baseUrl}/api/meetings/recordings/library`,
      { headers: { Cookie: combinedCookies } }
    );
    assert.equal(recoveredLibrary.status, 200);
    const recoveredPayload = (await recoveredLibrary.json()) as {
      data: {
        library: { libraryId: string };
        ownedLibrary: { libraryId: string };
        accessMode: string;
      };
    };
    assert.equal(recoveredPayload.data.library.libraryId, OWNER_IDS[0]);
    assert.equal(recoveredPayload.data.ownedLibrary.libraryId, OWNER_IDS[0]);
    assert.equal(recoveredPayload.data.accessMode, "owner");
    assert.match(
      recoveredLibrary.headers.get("set-cookie") ?? "",
      /meeting_library_recorder_v1=;[^,]*Max-Age=0/i
    );
  });
});

test("recorder create 會拒絕已被另一分頁切換的預期 libraryId", async () => {
  await withTestServer(async (baseUrl) => {
    const firstOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "第一庫", sourceIds: ["room-mic"] }),
    });
    const firstPayload = (await firstOwner.json()) as {
      meta: { library: { libraryId: string }; libraryCode: string };
    };
    const secondOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "第二庫", sourceIds: ["room-mic"] }),
    });
    const secondPayload = (await secondOwner.json()) as {
      meta: { libraryCode: string };
    };
    const selectSecond = await fetch(
      `${baseUrl}/api/meetings/recordings/library-access`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
        body: JSON.stringify({ code: OWNER_LIBRARY_CODES[1] }),
      }
    );
    const response = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(
        namedCookie(selectSecond, "meeting_library_recorder_v1"),
        { "Content-Type": "application/json" }
      ),
      body: JSON.stringify({
        title: "不可寫錯庫",
        sourceIds: ["room-mic"],
        libraryId: firstPayload.meta.library.libraryId,
      }),
    });
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "MEETING_RECORDING_LIBRARY_SELECTION_CHANGED"
    );
  });
});

test("離開錄音庫會同時清除 viewer 與 recorder cookie", async () => {
  await withTestServer(async (baseUrl) => {
    const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    await ownerCreate.json();
    const code = OWNER_LIBRARY_CODES[0];
    const select = await fetch(`${baseUrl}/api/meetings/recordings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code }),
    });
    const cookie = [
      namedCookie(select, "meeting_library_viewer_v1"),
      namedCookie(select, "meeting_library_recorder_v1"),
    ].join("; ");
    const logout = await fetch(`${baseUrl}/api/meetings/library/logout`, {
      method: "POST",
      headers: ownerHeaders(cookie),
    });
    assert.equal(logout.status, 204);
    const setCookie = logout.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /meeting_library_viewer_v1=;[^,]*Max-Age=0/i);
    assert.match(setCookie, /meeting_library_recorder_v1=;[^,]*Max-Age=0/i);
  });
});

test("viewer detail 不會洩漏 processing provider 的原始錯誤訊息", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const recording = await createFinalizedRecordingWithLibrary(baseUrl, "錯誤遮罩測試");
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/process`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    assert.equal(accepted.status, 202);
    const claimed = await context.processingRepository.claimNext({
      workerId: "viewer-failed-processing-worker",
      now: "2026-07-16T08:00:00.000Z",
      leaseExpiresAt: "2026-07-16T08:10:00.000Z",
    });
    assert.ok(claimed);
    await context.processingRepository.markFailed({
      jobId: claimed.jobId,
      workerId: "viewer-failed-processing-worker",
      errorCode: "PROVIDER_INTERNAL_ERROR",
      errorMessage: "D:/ragic-meeting/provider-secret-path/credential.json",
      now: "2026-07-16T08:01:00.000Z",
    });

    const authorize = await fetch(`${baseUrl}/api/meetings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: recording.libraryCode }),
    });
    const viewerCookie = ownerCookie(authorize);
    const detail = await fetch(
      `${baseUrl}/api/meetings/library/recordings/${recording.sessionId}`,
      { headers: { Cookie: viewerCookie } }
    );
    assert.equal(detail.status, 200);
    const text = await detail.text();
    assert.doesNotMatch(text, /provider-secret-path|credential\.json/);
    const payload = JSON.parse(text) as {
      data: { processingJob: { errorCode: string | null; errorMessage: string | null } };
    };
    assert.equal(payload.data.processingJob.errorCode, "PROVIDER_INTERNAL_ERROR");
    assert.equal(payload.data.processingJob.errorMessage, null);
  });
});

test("recorder capability 查詢 generic job 仍使用安全 DTO，不回傳 provider 原始錯誤", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const ownerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "來源庫", sourceIds: ["room-mic"] }),
    });
    const ownerPayload = (await ownerCreate.json()) as {
      meta: { library: { libraryId: string }; libraryCode: string };
    };
    const select = await fetch(`${baseUrl}/api/meetings/recordings/library-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ code: OWNER_LIBRARY_CODES[0] }),
    });
    const recorderCookie = namedCookie(select, "meeting_library_recorder_v1");
    const create = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: ownerHeaders(recorderCookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: "安全錯誤 DTO",
        sourceIds: ["room-mic"],
        libraryId: ownerPayload.meta.library.libraryId,
      }),
    });
    const created = (await create.json()) as {
      data: { sessionId: string };
      meta: { sessionCapability: string };
    };
    const headers = ownerHeaders(recorderCookie, {
      "X-Meeting-Session-Capability": created.meta.sessionCapability,
    });
    await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "audio/webm" },
        body: Buffer.from("safe-dto-audio"),
      }
    );
    await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          durationMs: 5_000,
          tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
        }),
      }
    );
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/process`,
      { method: "POST", headers }
    );
    assert.equal(accepted.status, 202);
    const jobId = ((await accepted.json()) as { data: { jobId: string } }).data.jobId;
    const claimed = await context.processingRepository.claimNext({
      workerId: "recorder-safe-dto-worker",
      now: "2026-07-16T08:00:00.000Z",
      leaseExpiresAt: "2026-07-16T08:10:00.000Z",
    });
    assert.ok(claimed);
    await context.processingRepository.markFailed({
      jobId,
      workerId: "recorder-safe-dto-worker",
      errorCode: "PROVIDER_INTERNAL_ERROR",
      errorMessage: "D:/meeting/private/provider-key.json",
      now: "2026-07-16T08:01:00.000Z",
    });

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/processing-jobs/${jobId}`,
      { headers: { "X-Meeting-Session-Capability": created.meta.sessionCapability } }
    );
    assert.equal(status.status, 200);
    const text = await status.text();
    assert.doesNotMatch(text, /provider-key|private/);
    assert.equal(
      (JSON.parse(text) as { data: { errorMessage: string | null } }).data.errorMessage,
      null
    );
  });
});

test("Meeting admin 經 Bearer auth 跨庫查詢、開啟與重設 Code 並留下 audit", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const first = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "Quality Weekly", sourceIds: ["room-mic"] }),
    });
    const firstPayload = (await first.json()) as {
      data: { sessionId: string };
      meta: { library: { libraryId: string }; libraryCode: string };
    };
    const firstOwnerCookie = ownerCookie(first);
    const second = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "Production Daily", sourceIds: ["room-mic"] }),
    });
    assert.equal(second.status, 201);

    const unauthorized = await fetch(`${baseUrl}/api/meetings/admin/libraries`);
    assert.equal(unauthorized.status, 401);

    const list = await fetch(
      `${baseUrl}/api/meetings/admin/libraries?query=quality&limit=20`,
      { headers: { Authorization: "Bearer meeting-admin-token" } }
    );
    assert.equal(list.status, 200);
    const listText = await list.text();
    assert.doesNotMatch(listText, /codeDigest|libraryCode|"code"/);
    const listPayload = JSON.parse(listText) as {
      data: Array<{
        libraryId: string;
        recordingCount: number;
        latestRecording: { title: string };
      }>;
    };
    assert.equal(listPayload.data.length, 1);
    assert.equal(listPayload.data[0]?.libraryId, firstPayload.meta.library.libraryId);
    assert.equal(listPayload.data[0]?.recordingCount, 1);
    assert.equal(listPayload.data[0]?.latestRecording.title, "Quality Weekly");

    const open = await fetch(
      `${baseUrl}/api/meetings/admin/libraries/${firstPayload.meta.library.libraryId}/open`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer meeting-admin-token",
          "X-Meeting-Request": "1",
        },
      }
    );
    assert.equal(open.status, 200);
    const viewerCookie = ownerCookie(open);
    const openedLibrary = await fetch(`${baseUrl}/api/meetings/library/recordings`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(openedLibrary.status, 200);

    const rotate = await fetch(
      `${baseUrl}/api/meetings/admin/libraries/${firstPayload.meta.library.libraryId}/rotate-code`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer meeting-admin-token",
          "X-Meeting-Request": "1",
        },
      }
    );
    assert.equal(rotate.status, 200);
    const rotateText = await rotate.text();
    assert.match(rotateText, /"code":"[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}"/);
    assert.doesNotMatch(rotateText, new RegExp(OWNER_LIBRARY_CODES[0]));

    const oldViewer = await fetch(`${baseUrl}/api/meetings/library/recordings`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(oldViewer.status, 401);

    const ownerStillWorks = await fetch(
      `${baseUrl}/api/meetings/recordings/${firstPayload.data.sessionId}`,
      { headers: { Cookie: firstOwnerCookie } }
    );
    assert.equal(ownerStillWorks.status, 200);

    const audits = await context.libraryRepository.listAdminAudits();
    assert.deepEqual(
      audits.map((audit) => audit.action),
      ["rotate-code", "open-library", "list-libraries"]
    );
    assert.ok(audits.every((audit) => audit.adminUsername === "meeting-admin"));
  });
});

test("Meeting admin 清單以穩定游標完整取回同時間戳的 101 個錄音庫", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const createdAt = "2026-07-16T08:00:00.000Z";
    for (let index = 1; index <= 101; index += 1) {
      const prefix = index.toString(16).padStart(8, "0");
      const created = await context.libraryRepository.createLibrary({
        libraryId: `${prefix}-0000-4000-8000-000000000000`,
        codeDigest: `digest-${index}`,
        displayName: `錄音庫 ${index}`,
        codeHint: "A**-**4",
        now: createdAt,
      });
      assert.ok(created);
    }

    const first = await fetch(
      `${baseUrl}/api/meetings/admin/libraries?limit=100`,
      { headers: { Authorization: "Bearer meeting-admin-token" } }
    );
    assert.equal(first.status, 200);
    const firstPayload = (await first.json()) as {
      data: Array<{ libraryId: string }>;
      meta: {
        nextCursor: string | null;
        hasMore: boolean;
        totalCount: number;
        totalRecordingCount: number;
      };
    };
    assert.equal(firstPayload.data.length, 100);
    assert.equal(firstPayload.meta.hasMore, true);
    assert.equal(firstPayload.meta.totalCount, 101);
    assert.equal(firstPayload.meta.totalRecordingCount, 0);
    assert.ok(firstPayload.meta.nextCursor);

    const second = await fetch(
      `${baseUrl}/api/meetings/admin/libraries?limit=100&cursor=${encodeURIComponent(firstPayload.meta.nextCursor!)}`,
      { headers: { Authorization: "Bearer meeting-admin-token" } }
    );
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as typeof firstPayload;
    assert.equal(secondPayload.data.length, 1);
    assert.equal(secondPayload.meta.hasMore, false);
    assert.equal(secondPayload.meta.nextCursor, null);
    assert.equal(
      new Set([...firstPayload.data, ...secondPayload.data].map((library) => library.libraryId)).size,
      101
    );
  }, { precreateLibraries: false });
});

test("Meeting admin 開啟錄音庫會在 audit 後重讀 accessVersion 再簽 viewer cookie", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const created = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ title: "競態測試", sourceIds: ["room-mic"] }),
    });
    const createdPayload = (await created.json()) as {
      meta: { library: { libraryId: string } };
    };
    const libraryId = createdPayload.meta.library.libraryId;

    const originalRecordAudit = context.libraryService.recordAdminAudit.bind(
      context.libraryService
    );
    let markAuditEntered!: () => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<void>((resolve) => {
      markAuditEntered = resolve;
    });
    const auditRelease = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    context.libraryService.recordAdminAudit = async (input) => {
      await originalRecordAudit(input);
      markAuditEntered();
      await auditRelease;
    };

    const openPromise = fetch(
      `${baseUrl}/api/meetings/admin/libraries/${libraryId}/open`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer meeting-admin-token",
          "X-Meeting-Request": "1",
        },
      }
    );
    await auditEntered;
    await context.libraryService.rotateCode(libraryId);
    releaseAudit();

    const opened = await openPromise;
    assert.equal(opened.status, 200);
    const openedPayload = (await opened.json()) as { data: { accessVersion: number } };
    assert.equal(openedPayload.data.accessVersion, 2);
    const viewerCookie = ownerCookie(opened);
    const viewerList = await fetch(`${baseUrl}/api/meetings/library/recordings`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerList.status, 200);
  });
});

async function createFinalizedRecording(baseUrl: string): Promise<{
  cookie: string;
  sessionId: string;
}> {
  const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
    body: JSON.stringify({ sourceIds: ["room-mic"] }),
  });
  const cookie = ownerCookie(createResponse);
  const created = (await createResponse.json()) as { data: { sessionId: string } };
  await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
    {
      method: "PUT",
      headers: ownerHeaders(cookie, { "Content-Type": "audio/webm" }),
      body: Buffer.from("audio-body"),
    }
  );
  const finalized = await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
    {
      method: "POST",
      headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        durationMs: 5_000,
        tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
      }),
    }
  );
  assert.equal(finalized.status, 200);
  return { cookie, sessionId: created.data.sessionId };
}

async function createFinalizedRecordingWithLibrary(
  baseUrl: string,
  title: string
): Promise<{
  cookie: string;
  sessionId: string;
  libraryCode: string;
}> {
  const createResponse = await fetch(`${baseUrl}/api/meetings/recordings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
    body: JSON.stringify({ title, sourceIds: ["room-mic"] }),
  });
  assert.equal(createResponse.status, 201);
  const cookie = ownerCookie(createResponse);
  const created = (await createResponse.json()) as {
    data: { sessionId: string };
    meta: { libraryCode: string | null };
  };
  assert.equal(created.meta.libraryCode, null);
  const chunk = await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/tracks/room-mic/chunks/0`,
    {
      method: "PUT",
      headers: ownerHeaders(cookie, { "Content-Type": "audio/webm" }),
      body: Buffer.from("audio-body"),
    }
  );
  assert.equal(chunk.status, 200);
  const finalized = await fetch(
    `${baseUrl}/api/meetings/recordings/${created.data.sessionId}/finalize`,
    {
      method: "POST",
      headers: ownerHeaders(cookie, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        durationMs: 5_000,
        tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
      }),
    }
  );
  assert.equal(finalized.status, 200);
  return {
    cookie,
    sessionId: created.data.sessionId,
    libraryCode: OWNER_LIBRARY_CODES[0],
  };
}

async function createReadyProcessingJob(
  baseUrl: string,
  root: string,
  context: {
    processingRepository: MeetingProcessingJobRepository;
  },
  input: { cookie: string; sessionId: string }
): Promise<string> {
  const accepted = await fetch(
    `${baseUrl}/api/meetings/recordings/${input.sessionId}/process`,
    { method: "POST", headers: ownerHeaders(input.cookie) }
  );
  assert.equal(accepted.status, 202);
  const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
  const claimed = await context.processingRepository.claimNext({
    workerId: "processing-worker",
    now: "2026-07-16T08:00:00.000Z",
    leaseExpiresAt: "2026-07-16T08:10:00.000Z",
  });
  assert.ok(claimed);
  const relativePath = `${input.sessionId}/room-mic.wav`;
  const filePath = path.join(root, "processing", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "canonical-audio");
  await context.processingRepository.markReady({
    jobId: claimed.jobId,
    workerId: "processing-worker",
    now: "2026-07-16T08:01:00.000Z",
    artifacts: [
      {
        artifactId: "canonical-room-mic",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "canonical-room-mic",
        mimeType: "audio/wav",
        relativePath,
        sizeBytes: 15,
        sha256: "canonical-sha",
        createdAt: "2026-07-16T08:01:00.000Z",
      },
    ],
  });
  return acceptedPayload.data.jobId;
}

async function createReadyTranscriptionJob(
  baseUrl: string,
  root: string,
  context: {
    transcriptionRepository: MeetingTranscriptionJobRepository;
  },
  input: { cookie: string; sessionId: string }
): Promise<string> {
  const accepted = await fetch(
    `${baseUrl}/api/meetings/recordings/${input.sessionId}/transcriptions`,
    { method: "POST", headers: ownerHeaders(input.cookie) }
  );
  assert.equal(accepted.status, 202);
  const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
  const claimed = await context.transcriptionRepository.claimNext({
    workerId: "transcription-worker",
    now: "2026-07-16T08:02:00.000Z",
    leaseExpiresAt: "2026-07-16T08:12:00.000Z",
  });
  assert.ok(claimed);
  const transcriptDir = path.join(root, "processing", input.sessionId, "transcript");
  await mkdir(transcriptDir, { recursive: true });
  const mergedPath = path.join(transcriptDir, "merged.json");
  const textPath = path.join(transcriptDir, "transcript.txt");
  const merged = JSON.stringify({
    version: 1,
    sessionId: input.sessionId,
    language: "zh-TW",
    provider: "fake",
    model: "fake-model",
    generatedAt: "2026-07-16T08:03:00.000Z",
    segments: [],
  });
  const transcriptText = "[00:00:00] 測試逐字稿\n";
  await Promise.all([
    writeFile(mergedPath, merged),
    writeFile(textPath, transcriptText),
  ]);
  await context.transcriptionRepository.markReady({
    jobId: claimed.jobId,
    workerId: "transcription-worker",
    now: "2026-07-16T08:03:00.000Z",
    artifacts: [
      {
        artifactId: "transcript-merged",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "transcript-merged-json",
        mimeType: "application/json; charset=utf-8",
        relativePath: path.relative(path.join(root, "processing"), mergedPath),
        sizeBytes: Buffer.byteLength(merged),
        sha256: "merged-sha",
        createdAt: "2026-07-16T08:03:00.000Z",
      },
      {
        artifactId: "transcript-text",
        jobId: claimed.jobId,
        sessionId: input.sessionId,
        type: "transcript-text",
        mimeType: "text/plain; charset=utf-8",
        relativePath: path.relative(path.join(root, "processing"), textPath),
        sizeBytes: Buffer.byteLength(transcriptText),
        sha256: "text-sha",
        createdAt: "2026-07-16T08:03:00.000Z",
      },
    ],
  });
  return acceptedPayload.data.jobId;
}

test("processing API 只 accepted durable job，重複 enqueue 回同一筆", async () => {
  await withTestServer(async (baseUrl) => {
    const { cookie, sessionId } = await createFinalizedRecording(baseUrl);
    const first = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/process`, {
      method: "POST",
      headers: ownerHeaders(cookie),
    });
    assert.equal(first.status, 202);
    const firstPayload = (await first.json()) as {
      data: { jobId: string; status: string; phase: string };
      meta: { accepted: boolean; reused: boolean };
    };
    assert.equal(firstPayload.data.status, "pending");
    assert.equal(firstPayload.data.phase, "queued");
    assert.deepEqual(firstPayload.meta, { accepted: true, reused: false });

    const second = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/process`, {
      method: "POST",
      headers: ownerHeaders(cookie),
    });
    const secondPayload = (await second.json()) as typeof firstPayload;
    assert.equal(second.status, 202);
    assert.equal(secondPayload.data.jobId, firstPayload.data.jobId);
    assert.equal(secondPayload.meta.reused, true);

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${sessionId}/processing-jobs/${firstPayload.data.jobId}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(status.status, 200);
  });
});

test("processing job 查詢與 retry 受 owner/session 隔離且要求 mutation intent", async () => {
  await withTestServer(async (baseUrl, _root, context) => {
    const first = await createFinalizedRecording(baseUrl);
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${first.sessionId}/process`,
      { method: "POST", headers: ownerHeaders(first.cookie) }
    );
    const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
    const claimed = await context.processingRepository.claimNext({
      workerId: "test-worker",
      now: "2026-07-15T08:00:00.000Z",
      leaseExpiresAt: "2026-07-15T08:10:00.000Z",
    });
    assert.ok(claimed);
    await context.processingRepository.markFailed({
      jobId: claimed.jobId,
      workerId: "test-worker",
      errorCode: "TEST_FAILURE",
      errorMessage: "retry me",
      now: "2026-07-15T08:01:00.000Z",
    });

    const missingIntent = await fetch(
      `${baseUrl}/api/meetings/recordings/${first.sessionId}/processing-jobs/${acceptedPayload.data.jobId}/retry`,
      { method: "POST", headers: { Cookie: first.cookie } }
    );
    assert.equal(missingIntent.status, 403);

    const secondOwnerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    const secondCookie = ownerCookie(secondOwnerCreate);
    const crossOwner = await fetch(
      `${baseUrl}/api/meetings/recordings/${first.sessionId}/processing-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: secondCookie } }
    );
    assert.equal(crossOwner.status, 404);

    const retry = await fetch(
      `${baseUrl}/api/meetings/recordings/${first.sessionId}/processing-jobs/${acceptedPayload.data.jobId}/retry`,
      { method: "POST", headers: ownerHeaders(first.cookie) }
    );
    assert.equal(retry.status, 202);
    const retryPayload = (await retry.json()) as { data: { status: string; jobId: string } };
    assert.equal(retryPayload.data.status, "pending");
    assert.equal(retryPayload.data.jobId, acceptedPayload.data.jobId);
  });
});

test("ready artifact 只透過 owner-scoped URL 下載，不洩漏 server relative path", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const { cookie, sessionId } = await createFinalizedRecording(baseUrl);
    const accepted = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/process`, {
      method: "POST",
      headers: ownerHeaders(cookie),
    });
    const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
    const claimed = await context.processingRepository.claimNext({
      workerId: "test-worker",
      now: "2026-07-15T08:00:00.000Z",
      leaseExpiresAt: "2026-07-15T08:10:00.000Z",
    });
    assert.ok(claimed);
    const relativePath = `${sessionId}/playback.m4a`;
    const filePath = path.join(root, "processing", relativePath);
    await writeFile(filePath, "playback", { flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "playback");
    });
    await context.processingRepository.markReady({
      jobId: claimed.jobId,
      workerId: "test-worker",
      now: "2026-07-15T08:01:00.000Z",
      artifacts: [
        {
          artifactId: "artifact-playback",
          jobId: claimed.jobId,
          sessionId,
          type: "playback",
          mimeType: "audio/mp4",
          relativePath,
          sizeBytes: 8,
          sha256: "hash",
          createdAt: "2026-07-15T08:01:00.000Z",
        },
      ],
    });

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${sessionId}/processing-jobs/${claimed.jobId}`,
      { headers: { Cookie: cookie } }
    );
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /relativePath/);
    const statusPayload = JSON.parse(statusText) as {
      data: { artifacts: Array<{ downloadUrl: string }> };
    };
    const artifact = await fetch(`${baseUrl}${statusPayload.data.artifacts[0]!.downloadUrl}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), "playback");
    const rangeArtifact = await fetch(
      `${baseUrl}${statusPayload.data.artifacts[0]!.downloadUrl}`,
      {
        headers: { Cookie: cookie, Range: "bytes=0-3" },
      }
    );
    assert.equal(rangeArtifact.status, 206);
    assert.equal(rangeArtifact.headers.get("content-range"), "bytes 0-3/8");
    assert.equal(await rangeArtifact.text(), "play");
  });
});

test("transcription API 僅在 audio ready 後 accepted，重複 enqueue 回同一筆", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    await createReadyProcessingJob(baseUrl, root, context, recording);

    const first = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcriptions`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    assert.equal(first.status, 202);
    const firstText = await first.text();
    assert.doesNotMatch(firstText, /ownerId|relativePath/);
    const firstPayload = JSON.parse(firstText) as {
      data: { jobId: string; status: string; phase: string };
      meta: { accepted: boolean; reused: boolean };
    };
    assert.equal(firstPayload.data.status, "pending");
    assert.equal(firstPayload.data.phase, "queued");
    assert.deepEqual(firstPayload.meta, { accepted: true, reused: false });

    const second = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcriptions`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    const secondPayload = (await second.json()) as typeof firstPayload;
    assert.equal(second.status, 202);
    assert.equal(secondPayload.data.jobId, firstPayload.data.jobId);
    assert.equal(secondPayload.meta.reused, true);

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcription-jobs/${firstPayload.data.jobId}`,
      { headers: { Cookie: recording.cookie } }
    );
    assert.equal(status.status, 200);
  });
});

test("transcription job 查詢與 retry 受 owner/session 隔離且要求 mutation intent", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    await createReadyProcessingJob(baseUrl, root, context, recording);
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcriptions`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
    const claimed = await context.transcriptionRepository.claimNext({
      workerId: "transcription-worker",
      now: "2026-07-16T08:02:00.000Z",
      leaseExpiresAt: "2026-07-16T08:12:00.000Z",
    });
    assert.ok(claimed);
    await context.transcriptionRepository.markFailed({
      jobId: claimed.jobId,
      workerId: "transcription-worker",
      errorCode: "TEST_TRANSCRIPTION_FAILURE",
      errorMessage: "retry transcript",
      now: "2026-07-16T08:03:00.000Z",
    });

    const missingIntent = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcription-jobs/${acceptedPayload.data.jobId}/retry`,
      { method: "POST", headers: { Cookie: recording.cookie } }
    );
    assert.equal(missingIntent.status, 403);

    const secondOwnerCreate = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    const secondCookie = ownerCookie(secondOwnerCreate);
    const crossOwner = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcription-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: secondCookie } }
    );
    assert.equal(crossOwner.status, 404);

    const retry = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcription-jobs/${acceptedPayload.data.jobId}/retry`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    assert.equal(retry.status, 202);
    const retryPayload = (await retry.json()) as { data: { jobId: string; status: string } };
    assert.equal(retryPayload.data.jobId, acceptedPayload.data.jobId);
    assert.equal(retryPayload.data.status, "pending");
  });
});

test("transcript artifact 只透過 owner-scoped URL 下載且不洩漏 server path", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    await createReadyProcessingJob(baseUrl, root, context, recording);
    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcriptions`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    const acceptedPayload = (await accepted.json()) as { data: { jobId: string } };
    const claimed = await context.transcriptionRepository.claimNext({
      workerId: "transcription-worker",
      now: "2026-07-16T08:02:00.000Z",
      leaseExpiresAt: "2026-07-16T08:12:00.000Z",
    });
    assert.ok(claimed);
    const relativePath = `${recording.sessionId}/transcript/merged.json`;
    const filePath = path.join(root, "processing", relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"segments":[]}');
    await context.transcriptionRepository.markReady({
      jobId: claimed.jobId,
      workerId: "transcription-worker",
      now: "2026-07-16T08:04:00.000Z",
      artifacts: [
        {
          artifactId: "transcript-merged",
          jobId: claimed.jobId,
          sessionId: recording.sessionId,
          type: "transcript-merged-json",
          mimeType: "application/json; charset=utf-8",
          relativePath,
          sizeBytes: 15,
          sha256: "transcript-sha",
          createdAt: "2026-07-16T08:04:00.000Z",
        },
      ],
    });

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcription-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: recording.cookie } }
    );
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /ownerId|relativePath/);
    const statusPayload = JSON.parse(statusText) as {
      data: { artifacts: Array<{ downloadUrl: string }> };
    };
    const artifact = await fetch(`${baseUrl}${statusPayload.data.artifacts[0]!.downloadUrl}`, {
      headers: { Cookie: recording.cookie },
    });
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), '{"segments":[]}');
  });
});

test("transcription provider disabled 回 typed 503，audio ready 與 playback API 不受影響", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    const processingJobId = await createReadyProcessingJob(
      baseUrl,
      root,
      context,
      recording
    );
    const response = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/transcriptions`,
      { method: "POST", headers: ownerHeaders(recording.cookie) }
    );
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "MEETING_TRANSCRIPTION_PROVIDER_DISABLED");
    const processing = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/processing-jobs/${processingJobId}`,
      { headers: { Cookie: recording.cookie } }
    );
    assert.equal(processing.status, 200);
    const processingPayload = (await processing.json()) as { data: { status: string } };
    assert.equal(processingPayload.data.status, "ready");
  }, { transcriptionProviderEnabled: false });
});

test("minutes API owner-scoped 產生版本、預覽 artifact 與串流 ZIP，且不洩漏 server path", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    await createReadyProcessingJob(baseUrl, root, context, recording);
    await createReadyTranscriptionJob(baseUrl, root, context, recording);
    const payload = {
      clientRequestKey: "minutes-request-1",
      title: "人工品管會議",
      date: "2026-07-16",
      attendees: "品管：王小明",
      confirmedFacts: "不良率 3%",
      confirmedDecisions: "下週開始抽驗",
      termCorrections: "",
      otherNotes: "",
    };
    const missingIntent = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes`,
      {
        method: "POST",
        headers: { Cookie: recording.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    assert.equal(missingIntent.status, 403);

    const accepted = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes`,
      {
        method: "POST",
        headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      }
    );
    assert.equal(accepted.status, 202);
    const acceptedText = await accepted.text();
    assert.doesNotMatch(
      acceptedText,
      /ownerId|relativePath|packageRelativePath|inputSha256|transcriptionJobId/
    );
    const acceptedPayload = JSON.parse(acceptedText) as {
      data: { jobId: string; status: string };
      meta: { reused: boolean };
    };
    assert.equal(acceptedPayload.data.status, "pending");
    assert.equal(acceptedPayload.meta.reused, false);

    const duplicate = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes`,
      {
        method: "POST",
        headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      }
    );
    const duplicatePayload = (await duplicate.json()) as {
      data: { jobId: string };
      meta: { reused: boolean };
    };
    assert.equal(duplicatePayload.data.jobId, acceptedPayload.data.jobId);
    assert.equal(duplicatePayload.meta.reused, true);

    const claimed = await context.minutesRepository.claimNext({
      workerId: "minutes-worker",
      now: "2026-07-16T08:04:00.000Z",
      leaseExpiresAt: "2026-07-16T08:14:00.000Z",
    });
    assert.ok(claimed);
    const ready = await context.minutesService.processClaimedJob(
      claimed,
      "minutes-worker"
    );
    assert.equal(ready.status, "ready");
    assert.ok(ready.version);

    const status = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: recording.cookie } }
    );
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /relativePath|packageRelativePath|ownerId/);
    const statusPayload = JSON.parse(statusText) as {
      data: {
        version: {
          versionId: string;
          artifacts: Array<{ type: string; downloadUrl: string }>;
          packageUrl: string;
        };
      };
    };
    const htmlArtifact = statusPayload.data.version.artifacts.find(
      (artifact) => artifact.type === "minutes-html"
    );
    assert.ok(htmlArtifact);
    const html = await fetch(`${baseUrl}${htmlArtifact.downloadUrl}`, {
      headers: { Cookie: recording.cookie },
    });
    assert.equal(html.status, 200);
    assert.match(await html.text(), /人工品管會議/);

    const zip = await fetch(`${baseUrl}${statusPayload.data.version.packageUrl}`, {
      headers: { Cookie: recording.cookie },
    });
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), "PK");

    const versions = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes/versions`,
      { headers: { Cookie: recording.cookie } }
    );
    const versionsPayload = (await versions.json()) as { data: Array<{ versionNumber: number }> };
    assert.deepEqual(versionsPayload.data.map((version) => version.versionNumber), [1]);

    const secondOwner = await fetch(`${baseUrl}/api/meetings/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Meeting-Request": "1" },
      body: JSON.stringify({ sourceIds: ["room-mic"] }),
    });
    const crossOwner = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes-jobs/${acceptedPayload.data.jobId}`,
      { headers: { Cookie: ownerCookie(secondOwner) } }
    );
    assert.equal(crossOwner.status, 404);
  });
});

test("minutes provider disabled 回 typed 503，transcription ready 不受影響", async () => {
  await withTestServer(async (baseUrl, root, context) => {
    const recording = await createFinalizedRecording(baseUrl);
    await createReadyProcessingJob(baseUrl, root, context, recording);
    const transcriptionJobId = await createReadyTranscriptionJob(
      baseUrl,
      root,
      context,
      recording
    );
    const response = await fetch(
      `${baseUrl}/api/meetings/recordings/${recording.sessionId}/minutes`,
      {
        method: "POST",
        headers: ownerHeaders(recording.cookie, { "Content-Type": "application/json" }),
        body: JSON.stringify({ clientRequestKey: "request-1", title: "品管會議" }),
      }
    );
    assert.equal(response.status, 503);
    const result = (await response.json()) as { error: { code: string } };
    assert.equal(result.error.code, "MEETING_MINUTES_PROVIDER_DISABLED");
    assert.equal((await context.transcriptionRepository.getJob(transcriptionJobId))?.status, "ready");
  }, { minutesProviderEnabled: false });
});

test("worker disabled 時 process endpoint 回 typed 503，既有錄音 API 不受影響", async () => {
  await withTestServer(async (baseUrl) => {
    const { cookie, sessionId } = await createFinalizedRecording(baseUrl);
    const response = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}/process`, {
      method: "POST",
      headers: ownerHeaders(cookie),
    });
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "MEETING_PROCESSING_WORKER_DISABLED");
    const recording = await fetch(`${baseUrl}/api/meetings/recordings/${sessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(recording.status, 200);
  }, { workerEnabled: false });
});
