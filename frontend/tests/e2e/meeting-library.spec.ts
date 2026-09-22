import { expect, test } from "@playwright/test";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIBRARY_NAME = "品管會議錄音庫";
const LIBRARY_CODE_HINT = "A**-**4";

function session() {
  return {
    sessionId: SESSION_ID,
    title: "2026 年 7 月品管會議",
    status: "finalized",
    createdAt: "2026-07-16T02:00:00.000Z",
    updatedAt: "2026-07-16T02:45:00.000Z",
    finalizedAt: "2026-07-16T02:45:00.000Z",
    durationMs: 2_700_000,
    totalSizeBytes: 2048,
    tracks: [
      {
        sourceId: "room-mic",
        mimeType: "audio/webm",
        chunkCount: 8,
        sizeBytes: 2048,
        available: true,
      },
    ],
  };
}

async function installMeetingLibraryRoutes(page: import("@playwright/test").Page) {
  let authorized = false;
  const accessBodies: unknown[] = [];
  const transcriptRequests: Array<{ download: boolean; cookie: string | undefined }> = [];

  await page.route("**/api/meetings/library", async (route) => {
    if (!authorized) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_LIBRARY_VIEWER_REQUIRED",
            message: "請先輸入有效的錄音庫存取碼。",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "set-cookie":
          "meeting_library_viewer_v1=test-viewer-cookie; Path=/api/meetings; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        data: {
          libraryId: LIBRARY_ID,
          displayName: LIBRARY_NAME,
          codeHint: LIBRARY_CODE_HINT,
          accessVersion: 1,
          createdAt: "2026-07-16T01:00:00.000Z",
          codeRotatedAt: "2026-07-16T01:00:00.000Z",
        },
      }),
    });
  });

  await page.route("**/api/meetings/library-access", async (route) => {
    accessBodies.push(route.request().postDataJSON());
    expect(route.request().headers()["x-meeting-request"]).toBe("1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    authorized = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "set-cookie":
          "meeting_library_viewer_v1=test-viewer-cookie; Path=/api/meetings; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        data: {
          libraryId: LIBRARY_ID,
          displayName: LIBRARY_NAME,
          codeHint: LIBRARY_CODE_HINT,
          accessVersion: 1,
          createdAt: "2026-07-16T01:00:00.000Z",
          codeRotatedAt: "2026-07-16T01:00:00.000Z",
        },
      }),
    });
  });

  await page.route("**/api/meetings/library/recordings?limit=50", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [session()],
        meta: { nextCursor: null, hasMore: false },
      }),
    });
  });

  await page.route(
    new RegExp(`/api/meetings/library/recordings/${SESSION_ID}$`),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            session: session(),
            processingJob: {
              jobId: "processing-1",
              sessionId: SESSION_ID,
              status: "ready",
              phase: "ready",
              attemptCount: 1,
              maxAttempts: 3,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-07-16T02:45:00.000Z",
              startedAt: "2026-07-16T02:45:01.000Z",
              updatedAt: "2026-07-16T02:46:00.000Z",
              completedAt: "2026-07-16T02:46:00.000Z",
              artifacts: [
                {
                  artifactId: "playback-1",
                  jobId: "processing-1",
                  sessionId: SESSION_ID,
                  type: "playback",
                  mimeType: "audio/mp4",
                  sizeBytes: 1024,
                  sha256: "audio-sha",
                  createdAt: "2026-07-16T02:46:00.000Z",
                  downloadUrl: `/api/meetings/library/recordings/${SESSION_ID}/artifacts/playback-1`,
                },
              ],
            },
            transcriptionJob: {
              jobId: "transcription-1",
              processingJobId: "processing-1",
              sessionId: SESSION_ID,
              provider: "fake",
              model: "fake-model",
              status: "ready",
              phase: "ready",
              attemptCount: 1,
              maxAttempts: 3,
              errorCode: null,
              errorMessage: null,
              createdAt: "2026-07-16T02:46:00.000Z",
              startedAt: "2026-07-16T02:46:01.000Z",
              updatedAt: "2026-07-16T02:47:00.000Z",
              completedAt: "2026-07-16T02:47:00.000Z",
              artifacts: [
                {
                  artifactId: "transcript-json",
                  jobId: "transcription-1",
                  sessionId: SESSION_ID,
                  type: "transcript-merged-json",
                  mimeType: "application/json",
                  sizeBytes: 512,
                  sha256: "json-sha",
                  createdAt: "2026-07-16T02:47:00.000Z",
                  downloadUrl: `/api/meetings/library/recordings/${SESSION_ID}/transcription-artifacts/transcript-json`,
                },
                {
                  artifactId: "transcript-text",
                  jobId: "transcription-1",
                  sessionId: SESSION_ID,
                  type: "transcript-text",
                  mimeType: "text/plain",
                  sizeBytes: 128,
                  sha256: "text-sha",
                  createdAt: "2026-07-16T02:47:00.000Z",
                  downloadUrl: `/api/meetings/library/recordings/${SESSION_ID}/transcription-artifacts/transcript-text`,
                },
              ],
            },
            minutesVersions: [
              {
                versionId: "minutes-v1",
                jobId: "minutes-job-1",
                sessionId: SESSION_ID,
                versionNumber: 1,
                record: {},
                generatedAt: "2026-07-16T02:48:00.000Z",
                artifacts: [
                  {
                    artifactId: "minutes-html",
                    versionId: "minutes-v1",
                    jobId: "minutes-job-1",
                    sessionId: SESSION_ID,
                    type: "minutes-html",
                    filename: "meeting-minutes.html",
                    mimeType: "text/html",
                    sizeBytes: 256,
                    sha256: "html-sha",
                    createdAt: "2026-07-16T02:48:00.000Z",
                    downloadUrl: `/api/meetings/library/recordings/${SESSION_ID}/minutes/versions/minutes-v1/artifacts/minutes-html`,
                  },
                ],
                packageUrl: `/api/meetings/library/recordings/${SESSION_ID}/minutes/versions/minutes-v1/package.zip`,
              },
            ],
          },
        }),
      });
    }
  );

  await page.route("**/api/meetings/library/recordings/*/artifacts/playback-1*", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mp4", body: "audio" });
  });
  await page.route("**/api/meetings/library/recordings/*/transcription-artifacts/transcript-json*", async (route) => {
    const requestUrl = new URL(route.request().url());
    transcriptRequests.push({
      download: requestUrl.searchParams.get("download") === "1",
      cookie: route.request().headers().cookie,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        sessionId: SESSION_ID,
        language: "zh-TW",
        provider: "fake",
        model: "fake-model",
        generatedAt: "2026-07-16T02:47:00.000Z",
        segments: [
          {
            segmentId: "segment-1",
            startMs: 0,
            endMs: 5_000,
            text: "確認本月品質改善項目。",
            primarySourceId: "room-mic",
            sourceSegmentIds: ["source-1"],
            speakerLabel: "品保主管",
          },
        ],
      }),
    });
  });
  await page.route("**/api/meetings/library/recordings/*/minutes/versions/*/artifacts/minutes-html*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><h1>品管會議紀錄</h1></body></html>",
    });
  });

  return { accessBodies, transcriptRequests };
}

test("輸入 Code 後可唯讀查看完整錄音庫，且 Code 不進 URL 或 Web Storage", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as unknown as { __meetingRevokedBlobUrls: string[] };
    target.__meetingRevokedBlobUrls = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      target.__meetingRevokedBlobUrls.push(url);
      original(url);
    };
  });
  const { accessBodies, transcriptRequests } = await installMeetingLibraryRoutes(page);
  await page.goto("/meetings/library");
  await expect(
    page.getByRole("button", {
      name: /^(?:返回會議錄音|Back to recorder)$/,
    })
  ).toBeVisible();

  const codeInput = page.getByLabel(/六位存取碼|Six-character access code/);
  await expect(codeInput).toBeFocused();
  await expect(codeInput).toHaveAttribute("type", "password");
  await codeInput.fill("abc234");
  await expect(codeInput).toHaveValue("ABC-234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).evaluate((button) => {
    button.click();
    button.click();
  });

  await expect(page.getByRole("heading", { name: "2026 年 7 月品管會議" })).toBeVisible();
  await expect(page.getByText(LIBRARY_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText(LIBRARY_CODE_HINT, { exact: true })).toBeVisible();
  expect(transcriptRequests).toHaveLength(0);
  await expect(page.getByText("確認本月品質改善項目。")).toHaveCount(0);
  await page
    .getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByLabel(/搜尋逐字稿|Search transcript/)
  ).toBeFocused();
  await expect(page.getByText("確認本月品質改善項目。")).toBeVisible();
  expect(transcriptRequests).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: /下載文字檔|Download text/ })
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /下載 JSON|Download JSON/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("meeting-transcript.json");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __meetingRevokedBlobUrls: string[] })
            .__meetingRevokedBlobUrls.length
      )
    )
    .toBe(1);
  expect(
    transcriptRequests.some(
      (request) =>
        request.download && request.cookie?.includes("meeting_library_viewer_v1=")
    )
  ).toBe(true);
  await expect(page.locator(".meeting-library-minutes-preview")).toBeVisible();
  expect(accessBodies).toEqual([{ code: "ABC-234" }]);
  expect(page.url()).not.toContain("ABC-234");
  expect(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
        value.includes("ABC-234")
      )
    )
  ).toBe(false);
});

test("長逐字稿分批呈現且畫面最多保留 1,000 段", async ({ page }) => {
  await installMeetingLibraryRoutes(page);
  await page.route(
    "**/api/meetings/library/recordings/*/transcription-artifacts/transcript-json*",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          sessionId: SESSION_ID,
          language: "zh-TW",
          provider: "fake",
          model: "fake-model",
          generatedAt: "2026-07-16T02:47:00.000Z",
          segments: Array.from({ length: 1_200 }, (_, index) => ({
            segmentId: `segment-${index}`,
            startMs: index * 1_000,
            endMs: index * 1_000 + 900,
            text: `逐字稿內容 ${index}`,
            primarySourceId: "room-mic",
            sourceSegmentIds: [`source-${index}`],
            speakerLabel: null,
          })),
        }),
      });
    }
  );
  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await page
    .getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
    .click();

  const segments = page.locator("[data-testid='transcript-segment']");
  await expect(segments).toHaveCount(200);
  const loadMore = page.getByRole("button", { name: /再顯示 200 段|Show 200 more/ });
  for (const expectedCount of [400, 600, 800, 1_000]) {
    await loadMore.click();
    await expect(segments).toHaveCount(expectedCount);
  }
  await expect(loadMore).toHaveCount(0);
  await expect(page.getByText(/已達 1,000 段畫面上限|1,000-segment display limit/))
    .toBeVisible();
});

test("逐字稿尚在下載時關閉閱讀器，晚到內容不會重新打開或寫回畫面", async ({ page }) => {
  await installMeetingLibraryRoutes(page);
  await page.route(
    "**/api/meetings/library/recordings/*/transcription-artifacts/transcript-json*",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          sessionId: SESSION_ID,
          language: "zh-TW",
          provider: "fake",
          model: "fake-model",
          generatedAt: "2026-07-16T02:47:00.000Z",
          segments: [{
            segmentId: "late-segment",
            startMs: 0,
            endMs: 1_000,
            text: "晚到逐字稿不得寫回",
            primarySourceId: "room-mic",
            sourceSegmentIds: ["late-source"],
            speakerLabel: null,
          }],
        }),
      });
    }
  );
  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  const openTranscriptReader = page.getByRole("button", {
    name: /開啟逐字稿閱讀器|Open transcript reader/,
  });
  await openTranscriptReader.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(openTranscriptReader).toBeFocused();
  await page.waitForTimeout(400);
  await expect(page.getByText("晚到逐字稿不得寫回")).toHaveCount(0);
});

test("lazy transcript fetch 的 viewer 權限終態錯誤會關閉閱讀器並回到 Code 入口", async ({ page }) => {
  await installMeetingLibraryRoutes(page);
  await page.route(
    "**/api/meetings/library/recordings/*/transcription-artifacts/transcript-json*",
    (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "MEETING_LIBRARY_VIEWER_EXPIRED",
            message: "viewer expired",
          },
        }),
      })
  );
  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await page
    .getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
    .click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel(/六位存取碼|Six-character access code/)).toBeVisible();
  await expect(
    page.getByRole("alert").filter({
      hasText: /權限已失效|library session has expired/,
    })
  ).toBeVisible();
});

test("錄音庫在 393px 寬度不產生水平溢出", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await installMeetingLibraryRoutes(page);
  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await expect(page.getByRole("heading", { name: "2026 年 7 月品管會議" })).toBeVisible();
  await page
    .getByRole("button", { name: /開啟逐字稿閱讀器|Open transcript reader/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(async () => (await page.getByRole("dialog").boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(850);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
});

test("錄音庫可用游標載入下一頁且不覆蓋已顯示錄音", async ({ page }) => {
  await installMeetingLibraryRoutes(page);
  const secondSession = {
    ...session(),
    sessionId: "22222222-2222-4222-8222-222222222222",
    title: "2026 年 7 月生產會議",
    createdAt: "2026-07-15T02:00:00.000Z",
  };
  let listCalls = 0;
  await page.route("**/api/meetings/library/recordings?*", async (route) => {
    listCalls += 1;
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        cursor
          ? { data: [secondSession], meta: { nextCursor: null, hasMore: false } }
          : { data: [session()], meta: { nextCursor: "page-2", hasMore: true } }
      ),
    });
  });

  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await expect(
    page.locator(".meeting-library-recording-list strong", {
      hasText: "2026 年 7 月品管會議",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: /載入更多錄音|Load more recordings/ }).click();

  await expect(
    page.locator(".meeting-library-recording-list strong", {
      hasText: "2026 年 7 月品管會議",
    })
  ).toBeVisible();
  await expect(
    page.locator(".meeting-library-recording-list strong", {
      hasText: "2026 年 7 月生產會議",
    })
  ).toBeVisible();
  expect(listCalls).toBe(2);
});

test("切換錄音庫後，前一個錄音庫的慢速清單不會覆蓋目前內容", async ({ page }) => {
  const libraryB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let authorizeCount = 0;
  let listCount = 0;
  let releaseFirstList!: () => void;
  const firstListRelease = new Promise<void>((resolve) => {
    releaseFirstList = resolve;
  });

  await page.route("**/api/meetings/library", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "MEETING_LIBRARY_VIEWER_REQUIRED", message: "需要存取碼" },
      }),
    })
  );
  await page.route("**/api/meetings/library-access", async (route) => {
    authorizeCount += 1;
    const libraryId = authorizeCount === 1 ? LIBRARY_ID : libraryB;
    const displayName = authorizeCount === 1 ? "第一錄音庫" : "第二錄音庫";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          libraryId,
          displayName,
          codeHint: authorizeCount === 1 ? "A**-**4" : "D**-**7",
          accessVersion: 1,
          createdAt: "2026-07-16T01:00:00.000Z",
          codeRotatedAt: "2026-07-16T01:00:00.000Z",
        },
      }),
    });
  });
  await page.route("**/api/meetings/library/logout", (route) =>
    route.fulfill({ status: 204 })
  );
  await page.route("**/api/meetings/library/recordings?*", async (route) => {
    listCount += 1;
    if (listCount === 1) {
      await firstListRelease;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [session()],
          meta: { nextCursor: null, hasMore: false },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        meta: { nextCursor: null, hasMore: false },
      }),
    });
  });

  await page.goto("/meetings/library");
  const codeInput = page.getByLabel(/六位存取碼|Six-character access code/);
  await codeInput.fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await expect(page.getByText("第一錄音庫", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /離開錄音庫|Leave library/ }).click();

  await codeInput.fill("DEF567");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await expect(page.getByText("第二錄音庫", { exact: true })).toBeVisible();
  await expect(page.getByText(/目前還沒有會議錄音|does not contain any meeting recordings/)).toBeVisible();

  releaseFirstList();
  await page.waitForTimeout(100);
  await expect(page.getByText("2026 年 7 月品管會議")).toHaveCount(0);
  await expect(page.getByText("第二錄音庫", { exact: true })).toBeVisible();
});

test("登出 API 失敗時保留目前錄音庫，不假裝已清除 HttpOnly 權限", async ({ page }) => {
  await installMeetingLibraryRoutes(page);
  await page.route("**/api/meetings/library/logout", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "logout failed" } }),
    })
  );
  await page.goto("/meetings/library");
  await page.getByLabel(/六位存取碼|Six-character access code/).fill("ABC234");
  await page.getByRole("button", { name: /進入錄音庫|Open library/ }).click();
  await expect(page.getByRole("heading", { name: "2026 年 7 月品管會議" })).toBeVisible();

  await page.getByRole("button", { name: /離開錄音庫|Leave library/ }).click();

  await expect(page.getByRole("heading", { name: "2026 年 7 月品管會議" })).toBeVisible();
  await expect(page.getByText("logout failed")).toBeVisible();
});
