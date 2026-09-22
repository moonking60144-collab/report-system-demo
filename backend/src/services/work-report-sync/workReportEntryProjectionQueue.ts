import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";
import { workReportMutationSyncCoordinator } from "./workReportMutationSyncCoordinator";

const queue = createKeyedSerialQueue();

export async function drainWorkReportEntryProjections(): Promise<void> {
  await queue.drain();
}

export async function runWorkReportEntryProjection<T>(
  formId: string,
  entryId: string,
  project: (waitedForSync: boolean) => Promise<T>
): Promise<T> {
  let result!: T;
  await queue.enqueue(`${formId}:${entryId}`, async () => {
    let waitedForSync = false;
    const release = await workReportMutationSyncCoordinator.acquireMutationSlot({
      onWaiting: () => { waitedForSync = true; },
    });
    try {
      result = await project(waitedForSync);
    } finally {
      release();
    }
  });
  return result;
}
