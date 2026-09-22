import { expect, test } from "@playwright/test";

async function installMockMeetingAudioSources(
  page: import("@playwright/test").Page,
  options: { remotePermissionDenied?: boolean } = {}
) {
  await page.addInitScript(({ remotePermissionDenied }) => {
    const contexts: AudioContext[] = [];
    const captureState = window as typeof window & {
      __meetingCaptureCalls?: Array<"room-mic" | "remote-tab">;
    };
    captureState.__meetingCaptureCalls = [];
    const createAudioStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      oscillator.connect(destination);
      oscillator.start();
      contexts.push(context);
      return destination.stream;
    };

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        captureState.__meetingCaptureCalls?.push("room-mic");
        return createAudioStream();
      },
    });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        captureState.__meetingCaptureCalls?.push("remote-tab");
        if (remotePermissionDenied) {
          throw new DOMException("remote capture denied", "NotAllowedError");
        }
        return createAudioStream();
      },
    });

    window.addEventListener("pagehide", () => {
      contexts.forEach((context) => void context.close());
    });
  }, options);
}

async function installFailingMediaRecorder(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    class FailingMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      mimeType = "audio/webm";

      start() {
        this.state = "recording";
        window.setTimeout(() => {
          this.state = "inactive";
          this.dispatchEvent(new ErrorEvent("error", { message: "simulated encoder failure" }));
          this.dispatchEvent(
            new BlobEvent("dataavailable", {
              data: new Blob([], { type: this.mimeType }),
            })
          );
          this.dispatchEvent(new Event("stop"));
        }, 20);
      }

      stop() {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: FailingMediaRecorder,
    });
  });
}

async function installSlowMediaRecorder(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const recorderState = window as typeof window & {
      __meetingTestRecorders?: Array<{ state: RecordingState }>;
    };
    recorderState.__meetingTestRecorders = [];

    class SlowMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      mimeType = "audio/webm";

      constructor() {
        super();
        recorderState.__meetingTestRecorders?.push(this);
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        window.setTimeout(() => {
          this.dispatchEvent(
            new BlobEvent("dataavailable", {
              data: new Blob(["audio"], { type: this.mimeType }),
            })
          );
          this.dispatchEvent(new Event("stop"));
        }, 250);
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: SlowMediaRecorder,
    });
  });
}

async function installChunkedMediaRecorder(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    class ChunkedMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }

      state: RecordingState = "inactive";
      mimeType = "audio/webm";

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.dispatchEvent(
          new BlobEvent("dataavailable", {
            data: new Blob(["persistent-audio"], { type: this.mimeType }),
          })
        );
        this.dispatchEvent(new Event("stop"));
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: ChunkedMediaRecorder,
    });
  });
}

const PENDING_FINALIZE_STORAGE_PREFIX = "meeting-minutes:pending-finalize:v2:";
const SELECTED_PENDING_FINALIZE_SESSION_KEY =
  "meeting-minutes:pending-finalize-session:v1";
const PROCESS_API_PATTERN = "**/api/meetings/recordings/*/process";
const TRANSCRIPTION_API_PATTERN =
  "**/api/meetings/recordings/*/transcriptions";
const MINUTES_API_PATTERN = "**/api/meetings/recordings/*/minutes";
const MINUTES_VERSIONS_API_PATTERN =
  "**/api/meetings/recordings/*/minutes/versions";
const DEFAULT_LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEFAULT_LIBRARY_CREATED_AT = "2026-07-16T01:00:00.000Z";
const DEFAULT_LIBRARY_NAME = "本機品管錄音庫";
const DEFAULT_LIBRARY_CODE_HINT = "A**-**4";

async function fulfillMeetingAccessError(
  route: import("@playwright/test").Route,
  code: string
) {
  await route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message: "meeting access expired" } }),
  });
}

async function installLibraryReselectionApi(
  page: import("@playwright/test").Page
) {
  await page.route("**/api/meetings/recordings/library-access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          enabled: true,
          accessMode: "recorder",
          code: null,
          library: {
            ...DEFAULT_LIBRARY_SETUP,
            libraryId: DEFAULT_LIBRARY_ID,
            accessVersion: 2,
            createdAt: DEFAULT_LIBRARY_CREATED_AT,
            codeRotatedAt: "2026-07-17T02:00:00.000Z",
          },
        },
      }),
    });
  });
}

async function expectAccessRecoveryAllowsNewRecording(
  page: import("@playwright/test").Page,
  sessionId: string,
  capability: string
) {
  const codeInput = page.getByLabel(
    /既有錄音庫存取碼|Existing library access code/
  );
  await expect(codeInput).toBeVisible();
  await expect(page.getByText(/錄音已完整儲存|Recording saved completely/)).toHaveCount(0);
  const persistedState = await page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
  }));
  const serializedState = JSON.stringify(persistedState);
  expect(serializedState).not.toContain(sessionId);
  expect(serializedState).not.toContain(capability);

  await codeInput.fill("NEW-456");
  await page
    .getByRole("button", { name: /使用既有錄音庫|Use existing library/ })
    .click();
  await expect(
    page.getByRole("button", { name: /開始錄音|Start recording/ })
  ).toBeEnabled();
}

async function installAccessRecoveryRecording(
  page: import("@playwright/test").Page,
  sessionId: string
) {
  const capability = `${sessionId.replaceAll("-", "").slice(0, 32)}abcdefghijk`;
  await installMockMeetingAudioSources(page);
  await installChunkedMediaRecorder(page);
  await installSingleTrackRecordingApi(page, {
    sessionId,
    sessionCapability: capability,
    libraryAccess: {
      libraryId: DEFAULT_LIBRARY_ID,
      accessVersion: 1,
      createdAt: DEFAULT_LIBRARY_CREATED_AT,
      codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
      code: null,
    },
  });
  await installLibraryReselectionApi(page);
  return capability;
}
const DEFAULT_LIBRARY_SETUP = {
  displayName: DEFAULT_LIBRARY_NAME,
  codeHint: DEFAULT_LIBRARY_CODE_HINT,
  setupState: "ready",
  missingFields: [],
} as const;

async function rapidlyDoubleClickMeetingStart(
  page: import("@playwright/test").Page
): Promise<void> {
  const button = page.locator(".meeting-recording-primary:not(.is-stop)");
  await expect(button).toBeEnabled();
  await button.dblclick();
}

async function installSingleTrackRecordingApi(
  page: import("@playwright/test").Page,
  options: {
    sessionId: string;
    finalizeStatus?: 200 | 401 | 503;
    finalizeErrorCode?: string;
    sessionCapability?: string;
    libraryAccess?: {
      libraryId: string;
      accessVersion: number;
      createdAt: string;
      codeRotatedAt: string;
      code: string | null;
    };
  }
) {
  const calls = {
    createBodies: [] as Array<{
      title?: unknown;
      sourceIds?: unknown;
      libraryId?: unknown;
    }>,
    finalizeSessionIds: [] as string[],
    chunkCapabilities: [] as Array<string | undefined>,
    finalizeCapabilities: [] as Array<string | undefined>,
    abortCount: 0,
    finalizeStatus: options.finalizeStatus ?? 200,
  };
  await page.route("**/api/meetings/recordings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    calls.createBodies.push(
      route.request().postDataJSON() as {
        title?: unknown;
        sourceIds?: unknown;
        libraryId?: unknown;
      }
    );
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          sessionId: options.sessionId,
          title: "錄音生命週期測試",
          status: "recording",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          finalizedAt: null,
          durationMs: null,
          totalSizeBytes: 0,
          tracks: [],
        },
        ...(options.libraryAccess
          ? {
              meta: {
                libraryAccessEnabled: true,
                library: {
                  ...DEFAULT_LIBRARY_SETUP,
                  libraryId: options.libraryAccess.libraryId,
                  accessVersion: options.libraryAccess.accessVersion,
                  createdAt: options.libraryAccess.createdAt,
                  codeRotatedAt: options.libraryAccess.codeRotatedAt,
                },
                libraryCode: options.libraryAccess.code,
                sessionCapability: options.sessionCapability ?? null,
                accessMode: options.sessionCapability ? "recorder" : "owner",
              },
            }
          : {}),
      }),
    });
  });
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/,
    async (route) => {
      calls.chunkCapabilities.push(
        route.request().headers()["x-meeting-session-capability"]
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { sequence: 0, sizeBytes: 16, duplicate: false } }),
      });
    }
  );
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/finalize$/, async (route) => {
    const sessionId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    calls.finalizeSessionIds.push(sessionId);
    calls.finalizeCapabilities.push(
      route.request().headers()["x-meeting-session-capability"]
    );
    if (calls.finalizeStatus !== 200) {
      await route.fulfill({
        status: calls.finalizeStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: options.finalizeErrorCode,
            message:
              calls.finalizeStatus === 401
                ? "錄音 session 權限已失效。"
                : "暫時無法合併音軌",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          sessionId,
          title: "錄音生命週期測試",
          status: "finalized",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:01:00.000Z",
          finalizedAt: "2026-07-15T00:01:00.000Z",
          durationMs: 5_000,
          totalSizeBytes: 16,
          tracks: [
            {
              sourceId: "room-mic",
              mimeType: "audio/webm",
              chunkCount: 1,
              sizeBytes: 16,
              available: true,
            },
          ],
        },
      }),
    });
  });
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/abort$/, async (route) => {
    calls.abortCount += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route(PROCESS_API_PATTERN, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "MEETING_PROCESSING_WORKER_DISABLED",
          message: "錄音後處理 worker 尚未啟用。",
        },
      }),
    });
  });
  return calls;
}

type ProcessingStatus = "pending" | "running" | "ready" | "failed";
type ProcessingPhase =
  | "queued"
  | "validating-audio"
  | "normalizing-room-mic"
  | "normalizing-remote-tab"
  | "generating-playback"
  | "ready";

async function installProcessingApi(
  page: import("@playwright/test").Page,
  options: {
    sessionId: string;
    initialStatus?: ProcessingStatus;
    initialPhase?: ProcessingPhase;
    statusSequence?: Array<{ status: ProcessingStatus; phase: ProcessingPhase }>;
    retryStatusSequence?: Array<{ status: ProcessingStatus; phase: ProcessingPhase }>;
    retryTransportFailsAfterAccept?: boolean;
    enqueueErrorCode?: string;
    retryErrorCode?: string;
    statusErrorCode?: string;
  }
) {
  const jobId = "99999999-9999-4999-8999-999999999999";
  const playbackArtifactId = "88888888-8888-4888-8888-888888888888";
  const calls = {
    processCount: 0,
    statusCount: 0,
    retryCount: 0,
    retryJobIds: [] as string[],
    mutationHeaders: [] as Array<string | undefined>,
  };
  let retried = false;
  let statusIndex = 0;
  let retryStatusIndex = 0;
  const makeJob = (status: ProcessingStatus, phase: ProcessingPhase) => ({
    jobId,
    sessionId: options.sessionId,
    status,
    phase,
    attemptCount: retried ? 2 : 1,
    maxAttempts: 3,
    errorCode: status === "failed" ? "FFMPEG_FAILED" : null,
    errorMessage: status === "failed" ? "simulated ffmpeg failure" : null,
    createdAt: "2026-07-15T00:01:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-15T00:01:01.000Z",
    updatedAt: "2026-07-15T00:01:02.000Z",
    completedAt: status === "ready" || status === "failed" ? "2026-07-15T00:01:03.000Z" : null,
    artifacts:
      status === "ready"
        ? [
            {
              artifactId: "77777777-0000-4000-8000-000000000001",
              jobId,
              sessionId: options.sessionId,
              type: "canonical-room-mic",
              mimeType: "audio/wav",
              sizeBytes: 2_048,
              sha256: "b".repeat(64),
              createdAt: "2026-07-15T00:01:03.000Z",
              downloadUrl: `/api/meetings/recordings/${options.sessionId}/artifacts/canonical-room-mic`,
            },
            {
              artifactId: playbackArtifactId,
              jobId,
              sessionId: options.sessionId,
              type: "playback",
              mimeType: "audio/mp4",
              sizeBytes: 1_024,
              sha256: "a".repeat(64),
              createdAt: "2026-07-15T00:01:03.000Z",
              downloadUrl: `/api/meetings/recordings/${options.sessionId}/artifacts/${playbackArtifactId}`,
            },
          ]
        : [],
  });

  await page.unroute(PROCESS_API_PATTERN);
  await page.route(PROCESS_API_PATTERN, async (route) => {
    calls.processCount += 1;
    calls.mutationHeaders.push(route.request().headers()["x-meeting-request"]);
    if (options.enqueueErrorCode) {
      await fulfillMeetingAccessError(route, options.enqueueErrorCode);
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: makeJob(options.initialStatus ?? "pending", options.initialPhase ?? "queued"),
        meta: { accepted: true, reused: false },
      }),
    });
  });
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/processing-jobs\/[^/]+\/retry$/,
    async (route) => {
      retried = true;
      calls.retryCount += 1;
      calls.retryJobIds.push(new URL(route.request().url()).pathname.split("/").at(-2)!);
      calls.mutationHeaders.push(route.request().headers()["x-meeting-request"]);
      if (options.retryErrorCode) {
        await fulfillMeetingAccessError(route, options.retryErrorCode);
        return;
      }
      if (options.retryTransportFailsAfterAccept) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ data: makeJob("pending", "queued"), meta: { accepted: true } }),
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/processing-jobs\/[^/]+$/,
    async (route) => {
      calls.statusCount += 1;
      if (options.statusErrorCode) {
        await fulfillMeetingAccessError(route, options.statusErrorCode);
        return;
      }
      const sequence = retried
        ? options.retryStatusSequence ?? [{ status: "ready" as const, phase: "ready" as const }]
        : options.statusSequence ?? [{ status: "ready" as const, phase: "ready" as const }];
      const index = retried ? retryStatusIndex++ : statusIndex++;
      const state = sequence[Math.min(index, sequence.length - 1)];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: makeJob(state.status, state.phase) }),
      });
    }
  );
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/artifacts\/[^/]+(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mp4", body: "processed-audio" });
  });

  return { calls, jobId };
}

type TranscriptionStatus = "pending" | "running" | "ready" | "failed";
type TranscriptionPhase =
  | "queued"
  | "preparing"
  | "transcribing-room-mic"
  | "transcribing-remote-tab"
  | "merging-transcript"
  | "ready";

async function installTranscriptionApi(
  page: import("@playwright/test").Page,
  options: {
    sessionId: string;
    initialStatus?: TranscriptionStatus;
    initialPhase?: TranscriptionPhase;
    statusSequence?: Array<{
      status: TranscriptionStatus;
      phase: TranscriptionPhase;
    }>;
    retryStatusSequence?: Array<{
      status: TranscriptionStatus;
      phase: TranscriptionPhase;
    }>;
    enqueueErrorCode?: string;
    retryErrorCode?: string;
    statusErrorCode?: string;
    artifactErrorCode?: string;
  }
) {
  const jobId = "66666666-6666-4666-8666-666666666666";
  const mergedArtifactId = "55555555-5555-4555-8555-555555555555";
  const textArtifactId = "44444444-4444-4444-8444-444444444444";
  const calls = {
    enqueueCount: 0,
    statusCount: 0,
    retryCount: 0,
    mutationHeaders: [] as Array<string | undefined>,
    artifactCapabilities: [] as Array<string | undefined>,
  };
  let retried = false;
  let statusIndex = 0;
  let retryStatusIndex = 0;
  const makeJob = (status: TranscriptionStatus, phase: TranscriptionPhase) => ({
    jobId,
    processingJobId: "99999999-9999-4999-8999-999999999999",
    sessionId: options.sessionId,
    provider: "fake-provider",
    model: "fake-transcript-model",
    status,
    phase,
    attemptCount: retried ? 2 : 1,
    maxAttempts: 3,
    errorCode: status === "failed" ? "TRANSCRIPTION_FAILED" : null,
    errorMessage: status === "failed" ? "simulated transcript failure" : null,
    createdAt: "2026-07-16T00:02:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-16T00:02:01.000Z",
    updatedAt: "2026-07-16T00:02:02.000Z",
    completedAt:
      status === "ready" || status === "failed"
        ? "2026-07-16T00:02:03.000Z"
        : null,
    artifacts:
      status === "ready"
        ? [
            {
              artifactId: mergedArtifactId,
              jobId,
              sessionId: options.sessionId,
              type: "transcript-merged-json",
              mimeType: "application/json; charset=utf-8",
              sizeBytes: 640,
              sha256: "c".repeat(64),
              createdAt: "2026-07-16T00:02:03.000Z",
              downloadUrl: `/api/meetings/recordings/${options.sessionId}/transcription-artifacts/${mergedArtifactId}`,
            },
            {
              artifactId: textArtifactId,
              jobId,
              sessionId: options.sessionId,
              type: "transcript-text",
              mimeType: "text/plain; charset=utf-8",
              sizeBytes: 320,
              sha256: "d".repeat(64),
              createdAt: "2026-07-16T00:02:03.000Z",
              downloadUrl: `/api/meetings/recordings/${options.sessionId}/transcription-artifacts/${textArtifactId}`,
            },
          ]
        : [],
  });

  await page.unroute(TRANSCRIPTION_API_PATTERN);
  await page.route(TRANSCRIPTION_API_PATTERN, async (route) => {
    calls.enqueueCount += 1;
    calls.mutationHeaders.push(route.request().headers()["x-meeting-request"]);
    if (options.enqueueErrorCode) {
      await fulfillMeetingAccessError(route, options.enqueueErrorCode);
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: makeJob(options.initialStatus ?? "pending", options.initialPhase ?? "queued"),
        meta: { accepted: true, reused: false },
      }),
    });
  });
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/transcription-jobs\/[^/]+\/retry$/,
    async (route) => {
      retried = true;
      calls.retryCount += 1;
      calls.mutationHeaders.push(route.request().headers()["x-meeting-request"]);
      if (options.retryErrorCode) {
        await fulfillMeetingAccessError(route, options.retryErrorCode);
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: makeJob("pending", "queued"),
          meta: { accepted: true },
        }),
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/transcription-jobs\/[^/]+$/,
    async (route) => {
      calls.statusCount += 1;
      if (options.statusErrorCode) {
        await fulfillMeetingAccessError(route, options.statusErrorCode);
        return;
      }
      const sequence = retried
        ? options.retryStatusSequence ?? [
            { status: "ready" as const, phase: "ready" as const },
          ]
        : options.statusSequence ?? [
            { status: "ready" as const, phase: "ready" as const },
          ];
      const index = retried ? retryStatusIndex++ : statusIndex++;
      const state = sequence[Math.min(index, sequence.length - 1)];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: makeJob(state.status, state.phase) }),
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/transcription-artifacts\/[^/]+(?:\?.*)?$/,
    async (route) => {
      calls.artifactCapabilities.push(
        route.request().headers()["x-meeting-session-capability"]
      );
      if (options.artifactErrorCode) {
        await fulfillMeetingAccessError(route, options.artifactErrorCode);
        return;
      }
      if (new URL(route.request().url()).pathname.endsWith(mergedArtifactId)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            version: 1,
            sessionId: options.sessionId,
            language: "zh-TW",
            provider: "fake-provider",
            model: "fake-transcript-model",
            generatedAt: "2026-07-16T00:02:03.000Z",
            segments: [
              {
                segmentId: "merged:0",
                startMs: 3_000,
                endMs: 7_000,
                text: "現場確認本月品質數據",
                primarySourceId: "room-mic",
                sourceSegmentIds: ["room:0"],
                speakerLabel: "品管主管",
              },
              {
                segmentId: "merged:1",
                startMs: 12_000,
                endMs: 16_000,
                text: "遠端補充改善排程",
                primarySourceId: "remote-tab",
                sourceSegmentIds: ["remote:0"],
                speakerLabel: null,
              },
            ],
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "[00:03] 現場確認本月品質數據",
      });
    }
  );

  return { calls, jobId };
}

type MinutesStatus = "pending" | "running" | "ready" | "failed";
type MinutesPhase = "queued" | "generating" | "packaging" | "ready";

async function installMinutesApi(
  page: import("@playwright/test").Page,
  options: {
    sessionId: string;
    statusSequence?: Array<{ status: MinutesStatus; phase: MinutesPhase }>;
    enqueueFailures?: number;
    failVersionsWhenReady?: boolean;
    enqueueErrorCode?: string;
    statusErrorCode?: string;
    versionsErrorCode?: string;
  }
) {
  const jobId = "33333333-3333-4333-8333-333333333333";
  const versionOneId = "22222222-2222-4222-8222-222222222221";
  const versionTwoId = "22222222-2222-4222-8222-222222222222";
  const calls = {
    enqueueBodies: [] as Array<Record<string, unknown>>,
    mutationHeaders: [] as Array<string | undefined>,
    statusCount: 0,
    versionsCount: 0,
  };
  let statusIndex = 0;
  let ready = false;

  const makeVersion = (versionNumber: 1 | 2) => {
    const versionId = versionNumber === 1 ? versionOneId : versionTwoId;
    const htmlArtifactId = `11111111-1111-4111-8111-11111111111${versionNumber}`;
    const jsonArtifactId = `11111111-1111-4111-8111-11111111112${versionNumber}`;
    return {
      versionId,
      jobId,
      sessionId: options.sessionId,
      versionNumber,
      record: {
        version: 1,
        title: versionNumber === 2 ? "2026 年 7 月品管會議" : "2026 年 6 月品管會議",
        date: "2026-07-16",
        subtitle: "會議紀錄",
        attendees: ["王小明", "陳小華"],
        executiveSummary: ["確認本月品質數據。"],
        discussionTopics: [
          {
            title: "品質數據",
            summary: "討論目前品質數據。",
            facts: ["不良率為 3%。"],
            decisions: ["下週完成改善排程。"],
          },
        ],
        decisions: ["下週完成改善排程。"],
        followUpActions: [{ content: "整理改善排程", owner: null, dueDate: null }],
        uncertainTerms: [],
      },
      generatedAt: `2026-07-16T00:0${versionNumber}:00.000Z`,
      artifacts: [
        {
          artifactId: htmlArtifactId,
          versionId,
          jobId,
          sessionId: options.sessionId,
          type: "minutes-html",
          filename: "index.html",
          mimeType: "text/html; charset=utf-8",
          sizeBytes: 2_048,
          sha256: "e".repeat(64),
          createdAt: `2026-07-16T00:0${versionNumber}:00.000Z`,
          downloadUrl: `/api/meetings/recordings/${options.sessionId}/minutes/versions/${versionId}/artifacts/${htmlArtifactId}`,
        },
        {
          artifactId: jsonArtifactId,
          versionId,
          jobId,
          sessionId: options.sessionId,
          type: "minutes-record-json",
          filename: "meeting-record.json",
          mimeType: "application/json; charset=utf-8",
          sizeBytes: 1_024,
          sha256: "f".repeat(64),
          createdAt: `2026-07-16T00:0${versionNumber}:00.000Z`,
          downloadUrl: `/api/meetings/recordings/${options.sessionId}/minutes/versions/${versionId}/artifacts/${jsonArtifactId}`,
        },
      ],
      packageUrl: `/api/meetings/recordings/${options.sessionId}/minutes/versions/${versionId}/package.zip`,
    };
  };

  const makeJob = (status: MinutesStatus, phase: MinutesPhase) => ({
    jobId,
    sessionId: options.sessionId,
    clientRequestKey:
      String(calls.enqueueBodies[0]?.clientRequestKey ?? "test-client-request-key"),
    input: {
      title: "2026 年 7 月品管會議",
      date: "2026-07-16",
      attendees: "王小明\n陳小華",
      confirmedFacts: "不良率為 3%。\n<script>window.__meetingXss = true</script>",
      confirmedDecisions: "下週完成改善排程。",
      termCorrections: "品檢 -> 品質檢驗",
      otherNotes: "僅保留人工確認內容。",
    },
    provider: "fake-provider",
    model: "fake-minutes-model",
    status,
    phase,
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-07-16T00:03:00.000Z",
    startedAt: status === "pending" ? null : "2026-07-16T00:03:01.000Z",
    updatedAt: "2026-07-16T00:03:02.000Z",
    completedAt: status === "ready" ? "2026-07-16T00:03:03.000Z" : null,
    version: status === "ready" ? makeVersion(2) : null,
  });

  await page.unroute(MINUTES_API_PATTERN);
  await page.unroute(MINUTES_VERSIONS_API_PATTERN);
  await page.route(/\/api\/meetings\/recordings\/[^/]+\/minutes$/, async (route) => {
    calls.enqueueBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    calls.mutationHeaders.push(route.request().headers()["x-meeting-request"]);
    if (options.enqueueErrorCode) {
      await fulfillMeetingAccessError(route, options.enqueueErrorCode);
      return;
    }
    if (calls.enqueueBodies.length <= (options.enqueueFailures ?? 0)) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "TEMPORARY_NETWORK_ERROR", message: "temporary network error" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ data: makeJob("pending", "queued"), meta: { accepted: true, reused: false } }),
    });
  });
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/minutes-jobs\/[^/]+$/,
    async (route) => {
      calls.statusCount += 1;
      if (options.statusErrorCode) {
        await fulfillMeetingAccessError(route, options.statusErrorCode);
        return;
      }
      const sequence = options.statusSequence ?? [
        { status: "running" as const, phase: "generating" as const },
        { status: "ready" as const, phase: "ready" as const },
      ];
      const state = sequence[Math.min(statusIndex++, sequence.length - 1)];
      ready ||= state.status === "ready";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: makeJob(state.status, state.phase) }),
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/minutes\/versions$/,
    async (route) => {
      calls.versionsCount += 1;
      if (options.versionsErrorCode) {
        await fulfillMeetingAccessError(route, options.versionsErrorCode);
        return;
      }
      if (ready && options.failVersionsWhenReady) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "TEMPORARY_NETWORK_ERROR", message: "temporary network error" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: ready ? [makeVersion(2), makeVersion(1)] : [] }),
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/minutes\/versions\/[^/]+\/artifacts\/[^/]+(?:\?.*)?$/,
    async (route) => {
      const isVersionOne = new URL(route.request().url()).pathname.includes(versionOneId);
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body><h1>${
          isVersionOne ? "2026 年 6 月品管會議" : "2026 年 7 月品管會議"
        }</h1><p>不良率為 3%。</p><p>&lt;script&gt;window.__meetingXss = true&lt;/script&gt;</p></body></html>`,
      });
    }
  );
  await page.route(
    /\/api\/meetings\/recordings\/[^/]+\/minutes\/versions\/[^/]+\/package\.zip$/,
    async (route) => {
      await route.fulfill({ status: 200, contentType: "application/zip", body: "zip" });
    }
  );

  return { calls, jobId, versionOneId, versionTwoId };
}

test.describe("meeting audio capability check", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "owner",
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
          },
        }),
      });
    });
    await page.route(PROCESS_API_PATTERN, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_PROCESSING_WORKER_DISABLED",
            message: "錄音後處理 worker 尚未啟用。",
          },
        }),
      });
    });
    await page.route(TRANSCRIPTION_API_PATTERN, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_TRANSCRIPTION_PROVIDER_DISABLED",
            message: "Meeting 逐字稿 provider 尚未設定。",
          },
        }),
      });
    });
    await page.route(MINUTES_API_PATTERN, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_MINUTES_PROVIDER_DISABLED",
            message: "Meeting 會議紀錄 provider 尚未設定。",
          },
        }),
      });
    });
    await page.route(MINUTES_VERSIONS_API_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      });
    });
  });

  test("報工頁的子系統選單可進入獨立 Meeting route", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator('[role="tablist"] .subsystem-menu-trigger')).toHaveCount(0);

    await page.getByRole("button", { name: /開啟子系統選單|Open subsystem menu/ }).click();
    await page.getByText(/開會紀錄錄音系統|Meeting Recording System/, { exact: true }).click();

    await expect(page).toHaveURL(/\/meetings\/audio-check$/);
    await expect(
      page.getByRole("heading", {
        name: /按一下，開始記錄會議|One click to record the meeting/,
      })
    ).toBeVisible();
  });

  test("開始錄音前必須先輸入或建立錄音庫，既有 Code 以 password 送出且快速連點只驗證一次", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    await installSingleTrackRecordingApi(page, {
      sessionId: "20202020-2020-4020-8020-202020202020",
    });
    let accessCount = 0;
    let accessBody: { code?: unknown } | null = null;
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_RECORDING_OWNER_REQUIRED",
            message: "缺少有效的會議錄音裝置憑證。",
          },
        }),
      });
    });
    await page.route("**/api/meetings/recordings/library-access", async (route) => {
      accessCount += 1;
      accessBody = route.request().postDataJSON() as { code?: unknown };
      expect(route.request().headers()["x-meeting-request"]).toBe("1");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            code: null,
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              displayName: "跨裝置品管錄音庫",
              codeHint: "A**-**4",
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    const startButton = page.getByRole("button", { name: /開始錄音|Start recording/ });
    await expect(startButton).toBeDisabled();
    await expect(page.locator(".meeting-persistent-state")).toContainText(
      /待選錄音庫|Choose library/
    );

    const codeInput = page.getByLabel(
      /既有錄音庫存取碼|Existing library access code/
    );
    await expect(codeInput).toHaveAttribute("type", "password");
    await codeInput.fill("ABC-234");
    await page
      .getByRole("button", { name: /使用既有錄音庫|Use existing library/ })
      .evaluate((button) => {
        button.click();
        button.click();
      });

    await expect(page.getByText(/既有錄音庫|Existing library/, { exact: true })).toBeVisible();
    await expect(page.getByText("跨裝置品管錄音庫", { exact: true })).toHaveCount(2);
    await expect(page.getByText("A**-**4", { exact: true })).toHaveCount(2);
    await expect(startButton).toBeEnabled();
    await expect(page.locator(".meeting-persistent-state")).toContainText(/可以開始|Ready/);
    expect(accessCount).toBe(1);
    expect(accessBody).toEqual({ code: "ABC-234" });
    expect(
      await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)
    ).not.toContain("ABC-234");

    await startButton.click();
    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("沒有既有 Code 時可在開始錄音區建立新錄音庫，快速連點只建立一次", async ({ page }) => {
    let createLibraryCount = 0;
    let createLibraryBody: { displayName?: unknown } | null = null;
    let renameLibraryBody: { displayName?: unknown } | null = null;
    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() === "POST") {
        createLibraryCount += 1;
        createLibraryBody = route.request().postDataJSON() as {
          displayName?: unknown;
        };
        expect(route.request().headers()["x-meeting-request"]).toBe("1");
        await new Promise((resolve) => setTimeout(resolve, 80));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              accessMode: "owner",
              code: "NEW-456",
              library: {
                ...DEFAULT_LIBRARY_SETUP,
                libraryId: DEFAULT_LIBRARY_ID,
                displayName: "七月品質週會",
                codeHint: "N**-**6",
                accessVersion: 1,
                createdAt: DEFAULT_LIBRARY_CREATED_AT,
                codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
              },
            },
          }),
        });
        return;
      }
      if (route.request().method() === "PATCH") {
        renameLibraryBody = route.request().postDataJSON() as {
          displayName?: unknown;
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              accessMode: "owner",
              code: null,
              library: {
                ...DEFAULT_LIBRARY_SETUP,
                libraryId: DEFAULT_LIBRARY_ID,
                displayName: "七月跨部門品質週會",
                codeHint: "N**-**6",
                accessVersion: 1,
                createdAt: DEFAULT_LIBRARY_CREATED_AT,
                codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
              },
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_RECORDING_OWNER_REQUIRED",
            message: "缺少有效的會議錄音裝置憑證。",
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    await page
      .getByLabel(/錄音庫名稱|Library name/)
      .fill("七月品質週會");
    await page
      .getByRole("button", { name: /建立錄音庫|Create library/ })
      .evaluate((button) => {
        button.click();
        button.click();
      });

    await expect(page.getByText("NEW-456", { exact: true })).toBeVisible();
    await expect(page.getByText("七月品質週會", { exact: true })).toHaveCount(2);
    await expect(page.getByText("N**-**6", { exact: true })).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: /開始錄音|Start recording/ })
    ).toBeEnabled();
    expect(createLibraryCount).toBe(1);
    expect(createLibraryBody).toEqual({ displayName: "七月品質週會" });

    await page.getByRole("button", { name: /重新命名|Rename/ }).click();
    await page
      .getByLabel(/新的錄音庫名稱|New recording library name/)
      .fill("七月跨部門品質週會");
    await page.getByRole("button", { name: /儲存名稱|Save name/ }).click();
    await expect(page.getByText("七月跨部門品質週會", { exact: true })).toHaveCount(2);
    await expect(page.getByText("NEW-456", { exact: true })).toBeVisible();
    expect(renameLibraryBody).toEqual({ displayName: "七月跨部門品質週會" });
  });

  test("legacy 錄音庫完成名稱與既有 Code 確認前不可開始錄音", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const incompleteLibrary = {
      libraryId: DEFAULT_LIBRARY_ID,
      displayName: "未命名錄音庫",
      codeHint: null,
      setupState: "incomplete" as const,
      missingFields: ["displayName", "codeHint"] as const,
      accessVersion: 1,
      createdAt: DEFAULT_LIBRARY_CREATED_AT,
      codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
    };
    const renamedLibrary = {
      ...incompleteLibrary,
      displayName: "七月品管會議",
      missingFields: ["codeHint"] as const,
    };
    const readyLibrary = {
      ...renamedLibrary,
      codeHint: "A**-**4",
      setupState: "ready" as const,
      missingFields: [],
    };
    let confirmCodeBody: { code?: unknown } | null = null;

    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              library: renamedLibrary,
              ownedLibrary: renamedLibrary,
              code: null,
              accessMode: "owner",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            library: incompleteLibrary,
            ownedLibrary: incompleteLibrary,
            accessMode: "owner",
          },
        }),
      });
    });
    await page.route(
      "**/api/meetings/recordings/library/confirm-code",
      async (route) => {
        confirmCodeBody = route.request().postDataJSON() as { code?: unknown };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              library: readyLibrary,
              ownedLibrary: readyLibrary,
              code: null,
              accessMode: "owner",
            },
          }),
        });
      }
    );

    await page.goto("/meetings/audio-check");
    const startButton = page.getByRole("button", { name: /開始錄音|Start recording/ });
    await expect(
      page.getByRole("heading", { name: /錄音庫設定尚未完成|Recording library setup is incomplete/ })
    ).toBeVisible();
    await expect(startButton).toBeDisabled();

    await page.getByRole("button", { name: /重新命名|Rename/ }).click();
    await page
      .getByLabel(/新的錄音庫名稱|New recording library name/)
      .fill("七月品管會議");
    await page.getByRole("button", { name: /儲存名稱|Save name/ }).click();
    await expect(startButton).toBeDisabled();

    await page
      .getByLabel(/目前錄音庫存取碼|Current recording library code/)
      .fill("ABC-234");
    await page.getByRole("button", { name: /確認現有存取碼|Confirm existing code/ }).click();
    await expect(page.getByText("A**-**4", { exact: true })).toHaveCount(2);
    await expect(startButton).toBeEnabled();
    expect(confirmCodeBody).toEqual({ code: "ABC-234" });
  });

  test("Library sharing disabled 時仍可用 owner fallback 開始錄音", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    await installSingleTrackRecordingApi(page, {
      sessionId: "21212121-2121-4121-8121-212121212121",
    });
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { enabled: false, library: null, accessMode: "owner" },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    await expect(
      page.getByText(/私人錄音模式|Private recording mode/, { exact: true })
    ).toBeVisible();
    const start = page.getByRole("button", { name: /開始錄音|Start recording/ });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("fresh browser 建立錄音庫時若分享未啟用，會立即切換私人錄音模式", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    await installSingleTrackRecordingApi(page, {
      sessionId: "23232323-2323-4232-8232-232323232323",
    });
    let createLibraryCount = 0;
    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() === "POST") {
        createLibraryCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: false,
              library: null,
              code: null,
              accessMode: "owner",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_RECORDING_OWNER_REQUIRED",
            message: "缺少有效的會議錄音裝置憑證。",
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    const start = page.getByRole("button", { name: /開始錄音|Start recording/ });
    await expect(start).toBeDisabled();
    await page.getByLabel(/錄音庫名稱|Library name/).fill("私人會議");
    await page.getByRole("button", { name: /建立錄音庫|Create library/ }).click();

    await expect(
      page.getByText(/私人錄音模式|Private recording mode/, { exact: true })
    ).toBeVisible();
    await expect(start).toBeEnabled();
    expect(createLibraryCount).toBe(1);

    await start.click();
    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("新 Library Code 在第一次 create 回 null 時仍保留到使用者確認", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const library = {
      ...DEFAULT_LIBRARY_SETUP,
      libraryId: DEFAULT_LIBRARY_ID,
      displayName: "新建錄音庫",
      codeHint: "N**-**6",
      accessVersion: 1,
      createdAt: DEFAULT_LIBRARY_CREATED_AT,
      codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
    };
    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              enabled: true,
              library,
              code: "NEW-456",
              accessMode: "owner",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "MEETING_RECORDING_OWNER_REQUIRED", message: "owner required" },
        }),
      });
    });
    await installSingleTrackRecordingApi(page, {
      sessionId: "22222222-2121-4121-8121-212121212121",
      libraryAccess: { ...library, code: null },
    });

    await page.goto("/meetings/audio-check");
    await page.getByLabel(/錄音庫名稱|Library name/).fill("新建錄音庫");
    await page.getByRole("button", { name: /建立錄音庫|Create library/ }).click();
    await expect(page.getByText("NEW-456", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await expect(page.getByText("NEW-456", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("recorder 權限失效或 library 切換時回到 Code 選擇器並聚焦，不需重新整理", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
          },
        }),
      });
    });
    let createBody: { libraryId?: unknown } | null = null;
    await page.route("**/api/meetings/recordings", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createBody = route.request().postDataJSON() as { libraryId?: unknown };
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_LIBRARY_RECORDER_EXPIRED",
            message: "recorder expired",
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    const codeInput = page.getByLabel(
      /既有錄音庫存取碼|Existing library access code/
    );
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toBeFocused();
    await expect(
      page.getByRole("button", { name: /開始錄音|Start recording/ })
    ).toBeDisabled();
    expect(createBody?.libraryId).toBe(DEFAULT_LIBRARY_ID);
  });

  test("切換錄音庫期間立即禁用開始，且本機已有錄音庫時不建立第二個", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const ownedLibrary = {
      ...DEFAULT_LIBRARY_SETUP,
      libraryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      displayName: "本機品管錄音庫",
      codeHint: "B**-**8",
      accessVersion: 1,
      createdAt: DEFAULT_LIBRARY_CREATED_AT,
      codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
    };
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
            ownedLibrary,
          },
        }),
      });
    });
    let logoutCount = 0;
    let releaseLogout: (() => void) | null = null;
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    await page.route("**/api/meetings/library/logout", async (route) => {
      logoutCount += 1;
      await logoutGate;
      await route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/meetings/audio-check");
    const startButton = page.getByRole("button", { name: /開始錄音|Start recording/ });
    await expect(startButton).toBeEnabled();
    await page.getByRole("button", { name: /切換錄音庫|Switch library/ }).click();
    await expect(
      page.getByRole("heading", { name: /正在切換錄音庫|Switching recording library/ })
    ).toBeVisible();
    await expect(startButton).toBeDisabled();
    releaseLogout?.();

    const codeInput = page.getByLabel(
      /既有錄音庫存取碼|Existing library access code/
    );
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toBeFocused();
    await expect(
      page.getByRole("button", { name: /建立錄音庫|Create library/ })
    ).toHaveCount(0);
    await page.getByRole("button", { name: /使用本機錄音庫|Use this browser's library/ }).click();
    await expect(page.getByText("本機品管錄音庫", { exact: true })).toHaveCount(2);
    await expect(startButton).toBeEnabled();
    expect(logoutCount).toBe(1);
  });

  test("recorder session capability 以 tab storage 傳給 chunk 與 finalize", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const capability = "c".repeat(43);
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
          },
        }),
      });
    });
    const calls = await installSingleTrackRecordingApi(page, {
      sessionId: "23232323-2323-4323-8323-232323232323",
      sessionCapability: capability,
      libraryAccess: {
        libraryId: DEFAULT_LIBRARY_ID,
        accessVersion: 1,
        createdAt: DEFAULT_LIBRARY_CREATED_AT,
        codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
        code: null,
      },
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await expect.poll(() => calls.finalizeCapabilities).toEqual([capability]);
    expect(calls.chunkCapabilities).toEqual([capability]);
    expect(
      await page.evaluate(
        (sessionId) =>
          sessionStorage.getItem(
            `meeting-minutes:session-capability:v1:${sessionId}`
          ),
        "23232323-2323-4323-8323-232323232323"
      )
    ).toBe(capability);
  });

  test("錄音庫選擇區在 393px 寬度可完整操作且不產生水平溢出", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.route("**/api/meetings/recordings/library", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_RECORDING_OWNER_REQUIRED",
            message: "缺少有效的會議錄音裝置憑證。",
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");

    await expect(
      page.getByLabel(/既有錄音庫存取碼|Existing library access code/)
    ).toHaveAttribute("type", "password");
    await expect(
      page.getByRole("button", { name: /建立錄音庫|Create library/ })
    ).toBeVisible();
    await page.getByLabel(/錄音庫名稱|Library name/).fill("手機錄音庫");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  });

  test("快速連點開始只要求一次麥克風權限並建立一個 session", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "10101010-1010-4010-8010-101010101010";
    const calls = await installSingleTrackRecordingApi(page, { sessionId });
    await page.goto("/meetings/audio-check");

    await rapidlyDoubleClickMeetingStart(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window as typeof window & { __meetingCaptureCalls?: string[] };
          return state.__meetingCaptureCalls;
        })
      )
      .toEqual(["room-mic"]);
    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    expect(calls.createBodies).toHaveLength(1);
    expect(String(calls.createBodies[0]?.title)).toMatch(/會議錄音|Meeting recording/);
    expect(calls.createBodies[0]?.sourceIds).toEqual(["room-mic"]);
    await expect(page.locator(".meeting-source-row")).toHaveCount(0);
    await expect(page.locator(".meeting-recording-test")).toHaveCount(0);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("首次錄音只顯示一次 Library Code，重設不會把 Code 寫入 Web Storage", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const libraryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const createdAt = "2026-07-16T01:00:00.000Z";
    const calls = { rotate: 0 };
    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId,
              accessVersion: 1,
              createdAt,
              codeRotatedAt: createdAt,
            },
          },
        }),
      });
    });
    await page.route("**/api/meetings/recordings/library/rotate-code", async (route) => {
      calls.rotate += 1;
      expect(route.request().headers()["x-meeting-request"]).toBe("1");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId,
              accessVersion: 2,
              createdAt,
              codeRotatedAt: "2026-07-16T02:00:00.000Z",
            },
            code: "XYZ-789",
          },
        }),
      });
    });
    await installSingleTrackRecordingApi(page, {
      sessionId: "19191919-1919-4919-8919-191919191919",
      libraryAccess: {
        libraryId,
        accessVersion: 1,
        createdAt,
        codeRotatedAt: createdAt,
        code: "ABC-234",
      },
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await expect(page.getByText("ABC-234", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)
    ).not.toContain("ABC-234");

    await page.getByRole("button", { name: /我已保存|I saved it/ }).click();
    await expect(page.getByText("ABC-234", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await page.getByRole("button", { name: /重設.*Code|Reset access code/ }).click();
    await page.getByRole("button", { name: /確認重設|Confirm reset/ }).evaluate((button) => {
      button.click();
      button.click();
    });
    await expect(page.getByText("XYZ-789", { exact: true })).toBeVisible();
    expect(calls.rotate).toBe(1);
    expect(
      await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`)
    ).not.toContain("XYZ-789");
  });

  test("遠端音訊未授權時會明確降級成麥克風錄音", async ({ page }) => {
    await installMockMeetingAudioSources(page, { remotePermissionDenied: true });
    await installChunkedMediaRecorder(page);
    await installSingleTrackRecordingApi(page, {
      sessionId: "14141414-1414-4414-8414-141414141414",
    });
    await page.goto("/meetings/audio-check");

    await page
      .getByRole("checkbox", { name: /同時擷取線上會議音訊|Also capture online meeting audio/ })
      .check();
    await rapidlyDoubleClickMeetingStart(page);

    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await expect(
      page.getByText(/本次改用麥克風錄音|Recording with the microphone only/)
    ).toBeVisible();
    expect(
      await page.evaluate(() => {
        const state = window as typeof window & { __meetingCaptureCalls?: string[] };
        return state.__meetingCaptureCalls;
      })
    ).toEqual(["remote-tab", "room-mic"]);
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
  });

  test("正式錄音會分路上傳，等待 finalize 後才顯示已儲存", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const chunkRequests: Array<{ path: string; body: string | null }> = [];
    const mutationRequestHeaders: Array<string | undefined> = [];
    let finalizedBody: Record<string, unknown> | null = null;

    await page.route("**/api/meetings/recordings", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      mutationRequestHeaders.push(route.request().headers()["x-meeting-request"]);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            sessionId,
            title: "測試正式會議",
            status: "recording",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:00.000Z",
            finalizedAt: null,
            durationMs: null,
            totalSizeBytes: 0,
            tracks: [],
          },
        }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/, async (route) => {
      mutationRequestHeaders.push(route.request().headers()["x-meeting-request"]);
      chunkRequests.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postData(),
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { sequence: 0, sizeBytes: 16, duplicate: false } }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/finalize$/, async (route) => {
      mutationRequestHeaders.push(route.request().headers()["x-meeting-request"]);
      finalizedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            sessionId,
            title: "測試正式會議",
            status: "finalized",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:01:00.000Z",
            finalizedAt: "2026-07-15T00:01:00.000Z",
            durationMs: 5_000,
            totalSizeBytes: 32,
            tracks: [
              {
                sourceId: "room-mic",
                mimeType: "audio/webm",
                chunkCount: 1,
                sizeBytes: 16,
                available: true,
              },
              {
                sourceId: "remote-tab",
                mimeType: "audio/webm",
                chunkCount: 1,
                sizeBytes: 16,
                available: true,
              },
            ],
          },
        }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/tracks\/(room-mic|remote-tab)$/, async (route) => {
      await route.fulfill({ status: 200, contentType: "audio/webm", body: "persistent-audio" });
    });

    await page.goto("/meetings/audio-check");
    await page
      .getByRole("checkbox", { name: /同時擷取線上會議音訊|Also capture online meeting audio/ })
      .check();
    await rapidlyDoubleClickMeetingStart(page);
    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await page
      .getByRole("button", { name: /停止錄音|Stop recording/ })
      .click();

    await expect(page.getByText(/錄音已完整儲存|Recording saved completely/)).toBeVisible();
    expect(chunkRequests).toHaveLength(2);
    expect(chunkRequests.map((request) => request.path).sort()).toEqual([
      `/api/meetings/recordings/${sessionId}/tracks/remote-tab/chunks/0`,
      `/api/meetings/recordings/${sessionId}/tracks/room-mic/chunks/0`,
    ]);
    expect(finalizedBody).toMatchObject({
      tracks: [
        { sourceId: "remote-tab", chunkCount: 1 },
        { sourceId: "room-mic", chunkCount: 1 },
      ],
    });
    expect(
      await page.evaluate(() => {
        const state = window as typeof window & { __meetingCaptureCalls?: string[] };
        return state.__meetingCaptureCalls;
      })
    ).toEqual(["remote-tab", "room-mic"]);
    expect(mutationRequestHeaders).toEqual(["1", "1", "1", "1"]);
  });

  test("錄音儲存後會排入後處理，從 running 追蹤到 ready 並提供回放", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "77777777-7777-4777-8777-777777777777";
    await installSingleTrackRecordingApi(page, { sessionId });
    const processing = await installProcessingApi(page, {
      sessionId,
      statusSequence: [
        { status: "running", phase: "validating-audio" },
        { status: "ready", phase: "ready" },
      ],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(page.getByText(/錄音已完整儲存|Recording saved completely/)).toBeVisible();
    const processingState = page.locator(
      ".meeting-processing-panel:not(.meeting-transcript-panel) .meeting-processing-state"
    );
    await expect(processingState).toContainText(/處理中|Processing/);
    await expect(processingState).toContainText(/已完成|Complete/, {
      timeout: 10_000,
    });
    await expect(page.locator(".meeting-processing-playback audio")).toHaveCount(1);
    await expect(page.locator(".meeting-audio-page audio")).toHaveCount(1);
    await expect(page.locator(".meeting-processing-artifacts")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /下載回放檔|Download playback/ })
    ).toBeVisible();
    expect(processing.calls.processCount).toBe(1);
    expect(processing.calls.statusCount).toBe(2);
    expect(processing.calls.mutationHeaders).toEqual(["1"]);
  });

  test("audio ready 後產生可搜尋逐字稿，時間按鈕可跳到同一份會議回放", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, "play", {
        configurable: true,
        value: async () => undefined,
      });
    });
    const sessionId = "61616161-6161-4161-8161-616161616161";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const transcription = await installTranscriptionApi(page, {
      sessionId,
      statusSequence: [
        { status: "running", phase: "transcribing-room-mic" },
        { status: "ready", phase: "ready" },
      ],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(page.locator(".meeting-transcript-panel .meeting-processing-state"))
      .toContainText(/已完成|Complete/, { timeout: 10_000 });
    const transcriptToggle = page.locator(".meeting-transcript-toggle");
    await expect(
      page.getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
    ).toBeVisible();
    await expect(page.getByText("現場確認本月品質數據")).toHaveCount(0);
    await transcriptToggle.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("現場確認本月品質數據")).toBeVisible();
    await expect(page.getByText("遠端補充改善排程")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /下載文字檔|Download text/ })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /下載 JSON|Download JSON/ })
    ).toBeVisible();

    const search = page.getByRole("searchbox", {
      name: /搜尋逐字稿|Search transcript/,
    });
    await search.fill("改善");
    await expect(page.getByText("遠端補充改善排程")).toBeVisible();
    await expect(page.getByText("現場確認本月品質數據")).toHaveCount(0);
    await search.fill("");

    await page
      .getByRole("button", { name: /從 00:00:03 開始播放|Play the recording from 00:00:03/ })
      .click();
    await expect
      .poll(() =>
        page.locator(".meeting-processing-playback audio").evaluate(
          (element) => (element as HTMLAudioElement).currentTime
        )
      )
      .toBe(3);
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(search).toBeVisible();
    await expect(
      page.getByRole("button", { name: /下載文字檔|Download text/ })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(search).toHaveCount(0);
    await expect(page.getByText("遠端補充改善排程")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1
      )
    ).toBe(true);
    expect(transcription.calls.enqueueCount).toBe(1);
    expect(transcription.calls.statusCount).toBe(2);
    expect(transcription.calls.mutationHeaders).toEqual(["1"]);
  });

  test("逐字稿 Blob 下載會帶 recorder capability，完成後釋放 object URL", async ({ page }) => {
    await page.addInitScript(() => {
      const target = window as unknown as { __meetingRevokedBlobUrls: string[] };
      target.__meetingRevokedBlobUrls = [];
      const original = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        target.__meetingRevokedBlobUrls.push(url);
        original(url);
      };
    });
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "67676767-6767-4767-8767-676767676767";
    const capability = "e".repeat(43);
    await installSingleTrackRecordingApi(page, {
      sessionId,
      sessionCapability: capability,
      libraryAccess: {
        libraryId: DEFAULT_LIBRARY_ID,
        accessVersion: 1,
        createdAt: DEFAULT_LIBRARY_CREATED_AT,
        codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
        code: null,
      },
    });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const transcription = await installTranscriptionApi(page, {
      sessionId,
      statusSequence: [{ status: "ready", phase: "ready" }],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await expect(page.locator(".meeting-transcript-panel .meeting-processing-state"))
      .toContainText(/已完成|Complete/, { timeout: 10_000 });
    await page
      .getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
      .click();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /下載 JSON|Download JSON/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("meeting-transcript.json");
    await expect
      .poll(() => transcription.calls.artifactCapabilities.length)
      .toBeGreaterThanOrEqual(2);
    expect(
      transcription.calls.artifactCapabilities.every((value) => value === capability)
    ).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __meetingRevokedBlobUrls: string[] })
              .__meetingRevokedBlobUrls.length
        )
      )
      .toBe(1);
  });

  test("人工補充只送出一次，完成後可預覽、下載並切換會議紀錄版本", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "64646464-6464-4464-8464-646464646464";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    await installTranscriptionApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const minutes = await installMinutesApi(page, { sessionId });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    const panel = page.locator(".meeting-minutes-panel");
    await expect(panel.getByRole("heading", { name: /AI 會議紀錄|AI meeting minutes/ }))
      .toBeVisible({ timeout: 10_000 });
    await panel.getByLabel(/會議名稱|Meeting title/).fill("2026 年 7 月品管會議");
    await panel.getByLabel(/會議日期|Meeting date/).fill("2026-07-16");
    await panel.getByLabel(/出席者|Attendees/).fill("王小明\n陳小華");
    await panel
      .getByLabel(/已確認事實|Confirmed facts/)
      .fill("不良率為 3%。\n<script>window.__meetingXss = true</script>");
    await panel
      .getByLabel(/已確認決議|Confirmed decisions/)
      .fill("下週完成改善排程。");
    await panel
      .getByLabel(/名詞修正|Terminology corrections/)
      .fill("品檢 -> 品質檢驗");
    await panel
      .getByLabel(/其他補充|Other notes/)
      .fill("僅保留人工確認內容。");

    const generate = panel.getByRole("button", {
      name: /產生會議紀錄|Generate meeting minutes/,
    });
    await generate.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });

    await expect(panel.locator(".meeting-processing-state"))
      .toContainText(/已完成|Complete/, { timeout: 12_000 });
    await expect(panel.getByRole("link", { name: /下載 HTML|Download HTML/ })).toBeVisible();
    await expect(panel.getByRole("link", { name: /下載 JSON|Download JSON/ })).toBeVisible();
    await expect(panel.getByRole("link", { name: /下載完整 ZIP|Download complete ZIP/ })).toBeVisible();

    expect(minutes.calls.enqueueBodies).toHaveLength(1);
    expect(minutes.calls.mutationHeaders).toEqual(["1"]);
    expect(minutes.calls.statusCount).toBe(2);
    expect(minutes.calls.enqueueBodies[0]).toMatchObject({
      title: "2026 年 7 月品管會議",
      date: "2026-07-16",
      attendees: "王小明\n陳小華",
      confirmedFacts: "不良率為 3%。\n<script>window.__meetingXss = true</script>",
      confirmedDecisions: "下週完成改善排程。",
      termCorrections: "品檢 -> 品質檢驗",
      otherNotes: "僅保留人工確認內容。",
    });
    expect(minutes.calls.enqueueBodies[0]?.clientRequestKey).toEqual(expect.any(String));

    const preview = panel.frameLocator(".meeting-minutes-preview");
    await expect(preview.getByRole("heading", { name: "2026 年 7 月品管會議" })).toBeVisible();
    await expect(preview.locator("script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { __meetingXss?: boolean }).__meetingXss))
      .toBeUndefined();

    await panel.getByLabel(/歷史版本|Version history/).selectOption(minutes.versionOneId);
    await expect(preview.getByRole("heading", { name: "2026 年 6 月品管會議" })).toBeVisible();

    await page.setViewportSize({ width: 393, height: 852 });
    await expect(panel.getByRole("link", { name: /下載完整 ZIP|Download complete ZIP/ })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    ).toBe(true);
  });

  test("minutes accepted 回應不明時只允許用同一 request key 重送", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "65656565-6565-4565-8565-656565656565";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    await installTranscriptionApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const minutes = await installMinutesApi(page, { sessionId, enqueueFailures: 1 });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    const panel = page.locator(".meeting-minutes-panel");
    await panel.getByLabel(/會議名稱|Meeting title/).fill("網路不明測試會議");
    const generate = panel.getByRole("button", {
      name: /產生會議紀錄|Generate meeting minutes/,
    });
    await generate.click();
    const submitButton = panel.locator('.meeting-minutes-form button[type="submit"]');
    const retry = panel.getByRole("button", {
      name: /再次送出任務|Submit task again/,
    });
    await expect(retry).toBeVisible();
    await expect(submitButton).toBeDisabled();

    await retry.click();
    await expect(panel.locator(".meeting-processing-state"))
      .toContainText(/已完成|Complete/, { timeout: 12_000 });
    expect(minutes.calls.enqueueBodies).toHaveLength(2);
    expect(minutes.calls.enqueueBodies[1]?.clientRequestKey)
      .toBe(minutes.calls.enqueueBodies[0]?.clientRequestKey);
  });

  test("歷史版本 API 瞬斷時仍以 ready job 立即顯示本次會議紀錄", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "66666666-6666-4666-8666-666666666666";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    await installTranscriptionApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    await installMinutesApi(page, {
      sessionId,
      statusSequence: [{ status: "ready", phase: "ready" }],
      failVersionsWhenReady: true,
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    const panel = page.locator(".meeting-minutes-panel");
    await panel.getByLabel(/會議名稱|Meeting title/).fill("2026 年 7 月品管會議");
    await panel.getByRole("button", {
      name: /產生會議紀錄|Generate meeting minutes/,
    }).click();

    const preview = panel.frameLocator(".meeting-minutes-preview");
    await expect(preview.getByRole("heading", { name: "2026 年 7 月品管會議" }))
      .toBeVisible({ timeout: 12_000 });
    await expect(panel.getByText(/無法重新載入會議紀錄版本|versions could not be reloaded/))
      .toBeVisible();
  });

  test("逐字稿 running 時 reload 會用持久化 job cursor 恢復，不重複 enqueue", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "62626262-6262-4262-8262-626262626262";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const transcription = await installTranscriptionApi(page, {
      sessionId,
      statusSequence: [
        { status: "running", phase: "transcribing-room-mic" },
        { status: "ready", phase: "ready" },
      ],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await expect(page.locator(".meeting-transcript-panel .meeting-processing-state"))
      .toContainText(/辨識中|Transcribing/);
    await expect(page.locator(".meeting-transcript-panel .meeting-transcription-spinner"))
      .toBeVisible();

    await page.reload();

    await expect(page.locator(".meeting-transcript-panel .meeting-processing-state"))
      .toContainText(/已完成|Complete/, { timeout: 10_000 });
    const transcriptToggle = page.locator(
      ".meeting-transcript-panel .meeting-transcript-toggle"
    );
    await expect(transcriptToggle).toHaveAccessibleName(
      /開啟逐字稿閱讀器|Open transcript reader/
    );
    await transcriptToggle.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("現場確認本月品質數據")).toBeVisible();
    expect(transcription.calls.enqueueCount).toBe(1);
    expect(transcription.calls.statusCount).toBeGreaterThanOrEqual(2);
  });

  test("backend 確認逐字稿失敗後可沿用同一 job 重試，回放保持可用", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "63636363-6363-4363-8363-636363636363";
    await installSingleTrackRecordingApi(page, { sessionId });
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "ready",
      initialPhase: "ready",
      statusSequence: [{ status: "ready", phase: "ready" }],
    });
    const transcription = await installTranscriptionApi(page, {
      sessionId,
      initialStatus: "failed",
      initialPhase: "transcribing-room-mic",
      statusSequence: [
        { status: "failed", phase: "transcribing-room-mic" },
      ],
      retryStatusSequence: [{ status: "ready", phase: "ready" }],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(page.getByText("simulated transcript failure")).toBeVisible();
    await expect(page.locator(".meeting-processing-playback audio")).toHaveCount(1);
    await page
      .getByRole("button", { name: /重新產生逐字稿|Generate transcript again/ })
      .click();

    await expect(page.locator(".meeting-transcript-panel .meeting-processing-state"))
      .toContainText(/已完成|Complete/);
    expect(transcription.calls.retryCount).toBe(1);
    expect(transcription.calls.mutationHeaders).toEqual(["1", "1"]);
  });

  test("finalize 後 enqueue 網路失敗，reload 仍會用同一 session 重新排入處理", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "70707070-7070-4070-8070-707070707070";
    const jobId = "90909090-9090-4090-8090-909090909090";
    await installSingleTrackRecordingApi(page, { sessionId });
    let processCount = 0;
    await page.unroute(PROCESS_API_PATTERN);
    await page.route(PROCESS_API_PATTERN, async (route) => {
      processCount += 1;
      if (processCount <= 2) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            jobId,
            sessionId,
            status: "pending",
            phase: "queued",
            attemptCount: 0,
            maxAttempts: 3,
            errorCode: null,
            errorMessage: null,
            createdAt: "2026-07-15T00:01:00.000Z",
            startedAt: null,
            updatedAt: "2026-07-15T00:01:00.000Z",
            completedAt: null,
            artifacts: [],
          },
          meta: { accepted: true, reused: false },
        }),
      });
    });
    await page.route(
      /\/api\/meetings\/recordings\/[^/]+\/processing-jobs\/[^/]+$/,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              jobId,
              sessionId,
              status: "ready",
              phase: "ready",
              attemptCount: 1,
              maxAttempts: 3,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-07-15T00:01:00.000Z",
              startedAt: "2026-07-15T00:01:01.000Z",
              updatedAt: "2026-07-15T00:01:02.000Z",
              completedAt: "2026-07-15T00:01:02.000Z",
              artifacts: [],
            },
          }),
        });
      }
    );

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await expect.poll(() => processCount).toBe(1);
    await expect(
      page.getByRole("button", { name: /再次送出後處理|Submit processing again/ })
    ).toBeVisible();

    await page.reload();

    await expect.poll(() => processCount).toBe(2);
    await page
      .getByRole("button", { name: /再次送出後處理|Submit processing again/ })
      .click();
    await expect.poll(() => processCount).toBe(3);
    await expect(
      page.locator(
        ".meeting-processing-panel:not(.meeting-transcript-panel) .meeting-processing-state"
      )
    ).toContainText(/已完成|Complete/);
  });

  test("後端確認後處理失敗時可沿用同一 jobId 重試並恢復追蹤", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await installSingleTrackRecordingApi(page, { sessionId });
    const processing = await installProcessingApi(page, {
      sessionId,
      initialStatus: "failed",
      initialPhase: "generating-playback",
      statusSequence: [{ status: "failed", phase: "generating-playback" }],
      retryStatusSequence: [{ status: "ready", phase: "ready" }],
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(page.getByText("simulated ffmpeg failure")).toBeVisible();
    await page.getByRole("button", { name: /重新處理|Process again/ }).click();
    await expect(
      page.locator(
        ".meeting-processing-panel:not(.meeting-transcript-panel) .meeting-processing-state"
      )
    ).toContainText(/已完成|Complete/);
    expect(processing.calls.retryCount).toBe(1);
    expect(processing.calls.retryJobIds).toEqual([processing.jobId]);
    expect(processing.calls.mutationHeaders).toEqual(["1", "1"]);
  });

  test("建立後處理任務遇到無 typed payload 的網路錯誤仍顯示重試入口", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await installSingleTrackRecordingApi(page, { sessionId });
    await page.unroute(PROCESS_API_PATTERN);
    await page.route(PROCESS_API_PATTERN, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(
      page.getByText(/目前無法建立後處理任務|processing task could not be created/)
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /重新送出處理|Submit processing again/ })
    ).toBeVisible();
  });

  test("重送已被後端受理但 response 中斷時會恢復 polling，不會停在假 failed", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await installSingleTrackRecordingApi(page, { sessionId });
    const processing = await installProcessingApi(page, {
      sessionId,
      initialStatus: "failed",
      initialPhase: "generating-playback",
      statusSequence: [{ status: "failed", phase: "generating-playback" }],
      retryStatusSequence: [{ status: "ready", phase: "ready" }],
      retryTransportFailsAfterAccept: true,
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await page.getByRole("button", { name: /重新處理|Process again/ }).click();
    await expect(
      page.locator(
        ".meeting-processing-panel:not(.meeting-transcript-panel) .meeting-processing-state"
      )
    ).toContainText(/已完成|Complete/);
    expect(processing.calls.retryCount).toBe(1);
    expect(processing.calls.statusCount).toBeGreaterThanOrEqual(1);
  });

  test("錄音中封鎖頁內導覽，瀏覽器返回仍會 finalize 而不 abort", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const calls = await installSingleTrackRecordingApi(page, { sessionId });

    await page.goto("/meetings/audio-check");
    await page.evaluate(() => {
      window.history.pushState(window.history.state, "", "/dev");
      window.history.pushState(window.history.state, "", "/meetings/audio-check");
    });
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();

    await expect(page.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/);
    await expect(
      page.getByRole("button", { name: /返回報工系統|Back to reporting/ })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /開啟子系統選單|Open subsystem menu/ })
    ).toBeDisabled();

    await page.goBack();
    await expect(page).toHaveURL(/\/dev$/);
    await expect.poll(() => calls.finalizeSessionIds).toEqual([sessionId]);
    expect(calls.abortCount).toBe(0);
  });

  test("finalize 暫時失敗會保留錄音，重試後完成且不呼叫 abort", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    let finalizeCount = 0;
    let abortCount = 0;

    await page.route("**/api/meetings/recordings", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            sessionId,
            title: "收尾重試測試",
            status: "recording",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:00.000Z",
            finalizedAt: null,
            durationMs: null,
            totalSizeBytes: 0,
            tracks: [],
          },
        }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { sequence: 0, sizeBytes: 16, duplicate: false } }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/finalize$/, async (route) => {
      finalizeCount += 1;
      if (finalizeCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "暫時無法合併音軌" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            sessionId,
            title: "收尾重試測試",
            status: "finalized",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:01:00.000Z",
            finalizedAt: "2026-07-15T00:01:00.000Z",
            durationMs: 5_000,
            totalSizeBytes: 16,
            tracks: [
              {
                sourceId: "room-mic",
                mimeType: "audio/webm",
                chunkCount: 1,
                sizeBytes: 16,
                available: true,
              },
            ],
          },
        }),
      });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/abort$/, async (route) => {
      abortCount += 1;
      await route.fulfill({ status: 204 });
    });
    await page.route(/\/api\/meetings\/recordings\/[^/]+\/tracks\/room-mic$/, async (route) => {
      await route.fulfill({ status: 200, contentType: "audio/webm", body: "persistent-audio" });
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page
      .getByRole("button", { name: /停止錄音|Stop recording/ })
      .click();

    await expect(
      page.getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
    ).toBeVisible();
    await expect(page.getByText(/暫時無法合併音軌/)).toBeVisible();
    expect(abortCount).toBe(0);
    expect(
      await page.evaluate(
        (key) => window.localStorage.getItem(key),
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionId}`
      )
    ).not.toBeNull();

    await page.getByRole("button", { name: /返回報工系統|Back to reporting/ }).click();
    await page.getByRole("button", { name: /開啟子系統選單|Open subsystem menu/ }).click();
    await page.getByText(/開會紀錄錄音系統|Meeting Recording System/, { exact: true }).click();
    await expect(
      page.getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
    ).toBeVisible();

    await page
      .getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
      .click();
    await expect(page.getByText(/錄音已完整儲存|Recording saved completely/)).toBeVisible();
    expect(finalizeCount).toBe(2);
    expect(abortCount).toBe(0);
    expect(
      await page.evaluate(
        (key) => window.localStorage.getItem(key),
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionId}`
      )
    ).toBeNull();
  });

  test("session capability 被撤銷後會清除不可重試收尾並允許重新選庫", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installChunkedMediaRecorder(page);
    const sessionId = "24242424-2424-4242-8242-242424242424";
    const capability = "c".repeat(43);
    const calls = await installSingleTrackRecordingApi(page, {
      sessionId,
      sessionCapability: capability,
      finalizeStatus: 401,
      finalizeErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
      libraryAccess: {
        libraryId: DEFAULT_LIBRARY_ID,
        accessVersion: 1,
        createdAt: DEFAULT_LIBRARY_CREATED_AT,
        codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
        code: null,
      },
    });
    await page.route("**/api/meetings/recordings/library", async (route) => {
      if (calls.finalizeSessionIds.length > 0) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "MEETING_RECORDING_OWNER_REQUIRED",
              message: "owner required",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 1,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: DEFAULT_LIBRARY_CREATED_AT,
            },
          },
        }),
      });
    });
    await page.route("**/api/meetings/recordings/library-access", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            enabled: true,
            accessMode: "recorder",
            code: null,
            library: {
              ...DEFAULT_LIBRARY_SETUP,
              libraryId: DEFAULT_LIBRARY_ID,
              accessVersion: 2,
              createdAt: DEFAULT_LIBRARY_CREATED_AT,
              codeRotatedAt: "2026-07-17T02:00:00.000Z",
            },
          },
        }),
      });
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expect(
      page.getByRole("button", { name: /重新送出錄音|Retry recording upload/ })
    ).toHaveCount(0);
    await expect(
      page.getByLabel(/既有錄音庫存取碼|Existing library access code/)
    ).toBeVisible();
    expect(
      await page.evaluate(
        ({ sessionId, capability }) => ({
          pending: localStorage.getItem(
            `meeting-minutes:pending-finalize:v2:${sessionId}`
          ),
          hasCapability: JSON.stringify(sessionStorage).includes(capability),
        }),
        { sessionId, capability }
      )
    ).toEqual({ pending: null, hasCapability: false });

    await page
      .getByLabel(/既有錄音庫存取碼|Existing library access code/)
      .fill("NEW-456");
    await page
      .getByRole("button", { name: /使用既有錄音庫|Use existing library/ })
      .click();
    await expect(
      page.getByRole("button", { name: /開始錄音|Start recording/ })
    ).toBeEnabled();
  });

  test("processing enqueue 的 capability 終態錯誤會清除舊流程並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "25252525-2525-4252-8252-252525252525";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, {
      sessionId,
      enqueueErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("processing polling 回 owner required 會停止舊流程並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "26262626-2626-4262-8262-262626262626";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, {
      sessionId,
      statusErrorCode: "MEETING_RECORDING_OWNER_REQUIRED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("processing retry 的 capability 終態錯誤會清除舊流程並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "29292929-2929-4292-8292-292929292929";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, {
      sessionId,
      initialStatus: "failed",
      initialPhase: "generating-playback",
      statusSequence: [{ status: "failed", phase: "generating-playback" }],
      retryErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await page.getByRole("button", { name: /重新處理|Process again/ }).click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("逐字稿 artifact 的 capability 終態錯誤會清除舊流程並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "27272727-2727-4272-8272-272727272727";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, { sessionId });
    await installTranscriptionApi(page, {
      sessionId,
      artifactErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("逐字稿 retry 的 capability 終態錯誤不會重啟舊 polling，並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "30303030-3030-4303-8303-303030303030";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, { sessionId });
    await installTranscriptionApi(page, {
      sessionId,
      initialStatus: "failed",
      initialPhase: "transcribing-room-mic",
      statusSequence: [{ status: "failed", phase: "transcribing-room-mic" }],
      retryErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();
    await page
      .getByRole("button", { name: /重新產生逐字稿|Generate transcript again/ })
      .click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("會議紀錄版本讀取的 capability 終態錯誤會清除舊流程並允許重新選庫錄音", async ({
    page,
  }) => {
    const sessionId = "28282828-2828-4282-8282-282828282828";
    const capability = await installAccessRecoveryRecording(page, sessionId);
    await installProcessingApi(page, { sessionId });
    await installTranscriptionApi(page, { sessionId });
    await installMinutesApi(page, {
      sessionId,
      versionsErrorCode: "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED",
    });

    await page.goto("/meetings/audio-check");
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /停止錄音|Stop recording/ }).click();

    await expectAccessRecoveryAllowsNewRecording(page, sessionId, capability);
  });

  test("多分頁 finalize 失敗會各自保留並重試自己的 session", async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const sessionA = "55555555-5555-4555-8555-555555555555";
    const sessionB = "66666666-6666-4666-8666-666666666666";
    await Promise.all([
      installMockMeetingAudioSources(pageA),
      installMockMeetingAudioSources(pageB),
      installChunkedMediaRecorder(pageA),
      installChunkedMediaRecorder(pageB),
    ]);
    const [callsA, callsB] = await Promise.all([
      installSingleTrackRecordingApi(pageA, { sessionId: sessionA, finalizeStatus: 503 }),
      installSingleTrackRecordingApi(pageB, { sessionId: sessionB, finalizeStatus: 503 }),
    ]);

    await Promise.all([
      pageA.goto("/meetings/audio-check"),
      pageB.goto("/meetings/audio-check"),
    ]);
    await Promise.all([
      pageA
        .getByRole("button", { name: /開始錄音|Start recording/ })
        .click(),
      pageB
        .getByRole("button", { name: /開始錄音|Start recording/ })
        .click(),
    ]);
    await Promise.all([
      expect(pageA.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/),
      expect(pageB.locator(".meeting-persistent-state")).toContainText(/錄音中|Recording/),
    ]);
    await Promise.all([
      pageA
        .getByRole("button", { name: /停止錄音|Stop recording/ })
        .click(),
      pageB
        .getByRole("button", { name: /停止錄音|Stop recording/ })
        .click(),
    ]);
    await Promise.all([
      expect(
        pageA.getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
      ).toBeVisible(),
      expect(
        pageB.getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
      ).toBeVisible(),
    ]);

    const pendingKeys = await pageA.evaluate((prefix) => {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      return keys.sort();
    }, PENDING_FINALIZE_STORAGE_PREFIX);
    expect(pendingKeys).toEqual(
      [
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionA}`,
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionB}`,
      ].sort()
    );
    expect(
      await pageA.evaluate((key) => window.sessionStorage.getItem(key), SELECTED_PENDING_FINALIZE_SESSION_KEY)
    ).toBe(sessionA);
    expect(
      await pageB.evaluate((key) => window.sessionStorage.getItem(key), SELECTED_PENDING_FINALIZE_SESSION_KEY)
    ).toBe(sessionB);

    callsA.finalizeStatus = 200;
    await pageA.reload();
    await pageA
      .getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
      .click();
    await expect.poll(() => callsA.finalizeSessionIds).toEqual([sessionA, sessionA]);
    await expect(pageA.getByText(/錄音已完整儲存|Recording saved completely/)).toBeVisible();
    expect(callsB.finalizeSessionIds).toEqual([sessionB]);
    expect(
      await pageA.evaluate(
        (key) => window.localStorage.getItem(key),
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionA}`
      )
    ).toBeNull();
    expect(
      await pageA.evaluate(
        (key) => window.localStorage.getItem(key),
        `${PENDING_FINALIZE_STORAGE_PREFIX}${sessionB}`
      )
    ).not.toBeNull();
    await pageA.reload();
    await expect(
      pageA.getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
    ).toHaveCount(0);

    await pageB.reload();
    await pageB
      .getByRole("button", { name: /重試錄音收尾|Retry finalization/ })
      .click();
    await expect.poll(() => callsB.finalizeSessionIds).toEqual([sessionB, sessionB]);
    expect(callsA.abortCount).toBe(0);
    expect(callsB.abortCount).toBe(0);
  });

  test("音源請求在離開 route 後才完成時會立即停止晚到的 track", async ({ page }) => {
    await page.addInitScript(() => {
      const deferredState = window as typeof window & {
        __resolveMeetingMic?: () => void;
        __meetingMicTrack?: MediaStreamTrack;
        __meetingMicContext?: AudioContext;
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: () =>
          new Promise<MediaStream>((resolve) => {
            deferredState.__resolveMeetingMic = () => {
              const context = new AudioContext();
              const destination = context.createMediaStreamDestination();
              const oscillator = context.createOscillator();
              oscillator.connect(destination);
              oscillator.start();
              deferredState.__meetingMicContext = context;
              deferredState.__meetingMicTrack = destination.stream.getAudioTracks()[0];
              resolve(destination.stream);
            };
          }),
      });
    });
    await page.goto("/meetings/audio-check");

    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.getByRole("button", { name: /開啟子系統選單|Open subsystem menu/ }).click();
    await page.getByText(/開發者模式|Developer Mode/, { exact: true }).click();
    await expect(page).toHaveURL(/\/dev$/);

    await page.evaluate(() => {
      const deferredState = window as typeof window & { __resolveMeetingMic?: () => void };
      deferredState.__resolveMeetingMic?.();
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const deferredState = window as typeof window & {
            __meetingMicTrack?: MediaStreamTrack;
          };
          return deferredState.__meetingMicTrack?.readyState;
        })
      )
      .toBe("ended");
    await page.evaluate(() => {
      const deferredState = window as typeof window & { __meetingMicContext?: AudioContext };
      void deferredState.__meetingMicContext?.close();
    });
  });

  test("遠端音訊請求晚到且已離頁時不會再要求麥克風權限", async ({ page }) => {
    await page.addInitScript(() => {
      const captureState = window as typeof window & {
        __resolveMeetingRemote?: () => void;
        __meetingMicCallCount?: number;
      };
      captureState.__meetingMicCallCount = 0;
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: () =>
          new Promise<MediaStream>((resolve) => {
            captureState.__resolveMeetingRemote = () => resolve(new MediaStream());
          }),
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          captureState.__meetingMicCallCount =
            (captureState.__meetingMicCallCount ?? 0) + 1;
          throw new DOMException("test denied", "NotAllowedError");
        },
      });
    });
    await page.goto("/meetings/audio-check");
    await page
      .getByRole("checkbox", { name: /同時擷取線上會議音訊|Also capture online meeting audio/ })
      .check();
    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();

    await page.evaluate(() => {
      window.history.pushState({}, "", "/dev");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page).toHaveURL(/\/dev$/);
    await page.evaluate(() => {
      const captureState = window as typeof window & { __resolveMeetingRemote?: () => void };
      captureState.__resolveMeetingRemote?.();
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const captureState = window as typeof window & { __meetingMicCallCount?: number };
          return captureState.__meetingMicCallCount ?? 0;
        })
      )
      .toBe(0);
  });

  test("音量 monitor 初始化失敗時會 rollback 已取得的麥克風", async ({ page }) => {
    await page.addInitScript(() => {
      const NativeAudioContext = window.AudioContext;
      const monitorState = window as typeof window & {
        __meetingMonitorTrack?: MediaStreamTrack;
        __meetingMonitorContext?: AudioContext;
      };
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const context = new NativeAudioContext();
          const destination = context.createMediaStreamDestination();
          const oscillator = context.createOscillator();
          oscillator.connect(destination);
          oscillator.start();
          monitorState.__meetingMonitorContext = context;
          monitorState.__meetingMonitorTrack = destination.stream.getAudioTracks()[0];
          return destination.stream;
        },
      });
      class FailingAudioContext {
        constructor() {
          throw new DOMException("simulated context limit", "NotSupportedError");
        }
      }
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: FailingAudioContext,
      });
    });
    await page.goto("/meetings/audio-check");

    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await expect(page.getByText(/無法啟用音訊來源|audio source could not start/)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const monitorState = window as typeof window & {
            __meetingMonitorTrack?: MediaStreamTrack;
          };
          return monitorState.__meetingMonitorTrack?.readyState;
        })
      )
      .toBe("ended");
    await expect(page.getByRole("button", { name: /停止來源|Stop source/ })).toHaveCount(0);
    await page.evaluate(() => {
      const monitorState = window as typeof window & { __meetingMonitorContext?: AudioContext };
      void monitorState.__meetingMonitorContext?.close();
    });
  });

  test("正式錄音的 MediaRecorder 非同步失敗會中止 session 且不顯示完成", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installFailingMediaRecorder(page);
    const calls = await installSingleTrackRecordingApi(page, {
      sessionId: "12121212-1212-4212-8212-121212121212",
    });
    await page.goto("/meetings/audio-check");

    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();

    await expect(
      page.getByText(/瀏覽器錄音中斷|Browser recording stopped unexpectedly/)
    ).toBeVisible();
    await expect(page.locator(".meeting-processing-playback audio")).toHaveCount(0);
    await expect.poll(() => calls.abortCount).toBe(1);
  });

  test("重複停止正式錄音只會 finalize 同一個 session 一次", async ({ page }) => {
    await installMockMeetingAudioSources(page);
    await installSlowMediaRecorder(page);
    const sessionId = "13131313-1313-4313-8313-131313131313";
    const calls = await installSingleTrackRecordingApi(page, { sessionId });
    await page.goto("/meetings/audio-check");

    await page.getByRole("button", { name: /開始錄音|Start recording/ }).click();
    await page.evaluate(() => {
      const stopButton = document.querySelector<HTMLButtonElement>(
        ".meeting-recording-primary.is-stop"
      );
      stopButton?.click();
      stopButton?.click();
    });

    await expect.poll(() => calls.finalizeSessionIds).toEqual([sessionId]);
    expect(calls.abortCount).toBe(0);
  });
});
