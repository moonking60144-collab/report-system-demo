import type { Database } from "sqlite";

export interface MeetingJobQueueHealthStats {
  pending: number;
  running: number;
  ready: number;
  failed: number;
  total: number;
  oldestPendingAgeMs: number;
}

type MeetingJobTable =
  | "meeting_processing_jobs"
  | "meeting_transcription_jobs"
  | "meeting_minutes_jobs";

interface MeetingJobQueueHealthRow {
  pending: number | null;
  running: number | null;
  ready: number | null;
  failed: number | null;
  total: number;
  oldest_pending_at: string | null;
}

export async function readMeetingJobQueueHealthStats(
  db: Database,
  table: MeetingJobTable,
  now = Date.now()
): Promise<MeetingJobQueueHealthStats> {
  const row = await db.get<MeetingJobQueueHealthRow>(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       COUNT(*) AS total,
       MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at
     FROM ${table}`
  );
  const oldestPendingAt = row?.oldest_pending_at
    ? Date.parse(row.oldest_pending_at)
    : Number.NaN;
  return {
    pending: row?.pending ?? 0,
    running: row?.running ?? 0,
    ready: row?.ready ?? 0,
    failed: row?.failed ?? 0,
    total: row?.total ?? 0,
    oldestPendingAgeMs: Number.isFinite(oldestPendingAt)
      ? Math.max(0, now - oldestPendingAt)
      : 0,
  };
}
