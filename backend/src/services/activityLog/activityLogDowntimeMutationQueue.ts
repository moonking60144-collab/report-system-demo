import { workReportEntryMutationQueue } from "../work-report/workReportEntryMutationQueue";

export const ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY = "903:downtime:mutation";

export async function runActivityLogDowntimeMutationExclusive<T>(
  worker: () => Promise<T>
): Promise<T> {
  let result!: T;
  await workReportEntryMutationQueue.enqueue(
    ACTIVITY_LOG_DOWNTIME_MUTATION_QUEUE_KEY,
    async () => {
      result = await worker();
    }
  );
  return result;
}
