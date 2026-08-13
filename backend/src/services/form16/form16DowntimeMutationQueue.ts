import { workReportEntryMutationQueue } from "../work-report/workReportEntryMutationQueue";

export const FORM16_DOWNTIME_MUTATION_QUEUE_KEY = "16:downtime:mutation";

export async function runForm16DowntimeMutationExclusive<T>(
  worker: () => Promise<T>
): Promise<T> {
  let result!: T;
  await workReportEntryMutationQueue.enqueue(
    FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
    async () => {
      result = await worker();
    }
  );
  return result;
}
