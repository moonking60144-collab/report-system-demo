export interface MeetingJobStorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

interface MeetingJobCursor {
  sessionId: string;
}

interface MeetingJobCursorStoreOptions<TCursor extends MeetingJobCursor> {
  cursorPrefix: string;
  selectedSessionKey: string;
  parse: (raw: string | null) => TCursor | null;
}

export function getMeetingBrowserStorage(
  kind: "localStorage" | "sessionStorage"
): MeetingJobStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function createMeetingJobCursorStore<TCursor extends MeetingJobCursor>(
  options: MeetingJobCursorStoreOptions<TCursor>
) {
  const storageKey = (sessionId: string) => `${options.cursorPrefix}${sessionId}`;

  return {
    read(
      localStorage: MeetingJobStorageLike | null,
      sessionStorage: MeetingJobStorageLike | null
    ): TCursor | null {
      if (!localStorage || !sessionStorage) return null;
      try {
        const selectedSessionId = sessionStorage.getItem(options.selectedSessionKey);
        if (selectedSessionId) {
          const selected = options.parse(localStorage.getItem(storageKey(selectedSessionId)));
          if (selected) return selected;
          localStorage.removeItem(storageKey(selectedSessionId));
          sessionStorage.removeItem(options.selectedSessionKey);
        }

        const keys: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith(options.cursorPrefix)) keys.push(key);
        }
        keys.sort();
        for (const key of keys) {
          const cursor = options.parse(localStorage.getItem(key));
          if (!cursor) {
            localStorage.removeItem(key);
            continue;
          }
          sessionStorage.setItem(options.selectedSessionKey, cursor.sessionId);
          return cursor;
        }
      } catch {
        return null;
      }
      return null;
    },

    persist(
      cursor: TCursor,
      localStorage: MeetingJobStorageLike | null,
      sessionStorage: MeetingJobStorageLike | null
    ): void {
      if (!localStorage || !sessionStorage) return;
      try {
        localStorage.setItem(storageKey(cursor.sessionId), JSON.stringify(cursor));
        sessionStorage.setItem(options.selectedSessionKey, cursor.sessionId);
      } catch {
        // Storage 不可用時，當前頁面仍可持續追蹤 backend 任務。
      }
    },

    clear(
      cursor: Pick<TCursor, "sessionId">,
      localStorage: MeetingJobStorageLike | null,
      sessionStorage: MeetingJobStorageLike | null
    ): void {
      if (!localStorage || !sessionStorage) return;
      try {
        localStorage.removeItem(storageKey(cursor.sessionId));
        if (sessionStorage.getItem(options.selectedSessionKey) === cursor.sessionId) {
          sessionStorage.removeItem(options.selectedSessionKey);
        }
      } catch {
        // Storage 清理失敗不會改變 backend 任務狀態。
      }
    },
  };
}

interface TrackableMeetingJob {
  status: "pending" | "running" | "ready" | "failed";
  attemptCount: number;
  maxAttempts: number;
}

interface RetryableMeetingAiJob extends TrackableMeetingJob {
  errorCode: string | null;
}

const MEETING_AI_PROVIDER_CHANGED_ERROR_CODES = new Set([
  "MEETING_TRANSCRIPTION_PROVIDER_CHANGED",
  "MEETING_MINUTES_PROVIDER_CHANGED",
]);

export function isMeetingAiProviderChangedFailure(
  job: RetryableMeetingAiJob
): boolean {
  return (
    job.status === "failed" &&
    job.errorCode !== null &&
    MEETING_AI_PROVIDER_CHANGED_ERROR_CODES.has(job.errorCode)
  );
}

export function canRetryMeetingAiJob<TJob extends RetryableMeetingAiJob>(
  job: TJob | null
): job is TJob {
  return Boolean(
    job?.status === "failed" &&
      (job.attemptCount < job.maxAttempts || isMeetingAiProviderChangedFailure(job))
  );
}

export type MeetingJobPollResult<TJob extends TrackableMeetingJob> =
  | { kind: "ready"; job: TJob }
  | { kind: "failed"; job: TJob }
  | { kind: "unknown"; errorCode: string }
  | { kind: "cancelled" };

interface MeetingJobPollOptions<TJob extends TrackableMeetingJob> {
  cursor: { sessionId: string; jobId: string };
  fetchJob: (sessionId: string, jobId: string) => Promise<TJob>;
  resolveErrorCode: (error: unknown) => string | null;
  terminalLookupErrorCodes: ReadonlySet<string>;
  isSessionAccessTerminalErrorCode: (errorCode: string) => boolean;
  isTerminalFailure?: (job: TJob) => boolean;
  wait?: (delayMs: number) => Promise<void>;
  isCancelled?: () => boolean;
  isPaused?: () => boolean;
  onJob?: (job: TJob) => void;
  onTransientError?: (error: unknown | null) => void;
  pollIntervalMs?: number;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function pollMeetingJob<TJob extends TrackableMeetingJob>(
  options: MeetingJobPollOptions<TJob>
): Promise<MeetingJobPollResult<TJob>> {
  const sleep = options.wait ?? wait;
  const isCancelled = options.isCancelled ?? (() => false);
  const isPaused = options.isPaused ?? (() => false);
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;

  while (!isCancelled()) {
    if (isPaused()) {
      await sleep(pollIntervalMs);
      continue;
    }
    try {
      const job = await options.fetchJob(options.cursor.sessionId, options.cursor.jobId);
      if (isCancelled()) return { kind: "cancelled" };
      options.onTransientError?.(null);
      options.onJob?.(job);
      if (job.status === "ready") return { kind: "ready", job };
      if (
        job.status === "failed" &&
        (job.attemptCount >= job.maxAttempts || options.isTerminalFailure?.(job))
      ) {
        return { kind: "failed", job };
      }
    } catch (error) {
      if (isCancelled()) return { kind: "cancelled" };
      const code = options.resolveErrorCode(error);
      if (
        code &&
        (options.terminalLookupErrorCodes.has(code) ||
          options.isSessionAccessTerminalErrorCode(code))
      ) {
        return { kind: "unknown", errorCode: code };
      }
      options.onTransientError?.(error);
    }
    await sleep(pollIntervalMs);
  }
  return { kind: "cancelled" };
}
