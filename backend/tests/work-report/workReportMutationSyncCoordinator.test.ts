import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkReportMutationSyncCoordinator,
  workReportMutationSyncCoordinator,
} from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import { runWorkReportEntryMutationExclusive } from "../../src/services/work-report/workReportEntryMutationQueue";
import { KeyedSerialQueueAbortedError } from "../../src/utils/keyedSerialQueue";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("全量同步進行中時寫入會等待，且 auto-sync 會避讓等待中的寫入", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const releaseSync = await coordinator.acquireSyncSlot();
  let waitingNotified = 0;
  let mutationAcquired = false;

  const mutationSlotPromise = coordinator
    .acquireMutationSlot({
      onWaiting: () => {
        waitingNotified += 1;
      },
    })
    .then((release) => {
      mutationAcquired = true;
      return release;
    });

  await nextTurn();
  assert.equal(mutationAcquired, false);
  assert.equal(waitingNotified, 1);
  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), true);

  releaseSync();
  const releaseMutation = await mutationSlotPromise;
  assert.equal(mutationAcquired, true);
  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), true);

  releaseMutation();
  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), false);
});

test("寫入進行中時全量同步會等待，並重新檢查同步前插入的寫入", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const releaseMutation = await coordinator.acquireMutationSlot();
  let waitingNotified = 0;
  let syncAcquired = false;

  const syncSlotPromise = coordinator
    .acquireSyncSlot({
      onWaiting: () => {
        waitingNotified += 1;
      },
    })
    .then((release) => {
      syncAcquired = true;
      return release;
    });

  await nextTurn();
  assert.equal(syncAcquired, false);
  assert.equal(waitingNotified, 1);

  releaseMutation();
  const releaseSecondMutation = await coordinator.acquireMutationSlot();
  await nextTurn();
  assert.equal(syncAcquired, false);

  releaseSecondMutation();
  const releaseSync = await syncSlotPromise;
  assert.equal(syncAcquired, true);
  releaseSync();
});

test("沒有同步衝突時不同工令的寫入可同時取得 slot", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const [releaseFirst, releaseSecond] = await Promise.all([
    coordinator.acquireMutationSlot(),
    coordinator.acquireMutationSlot(),
  ]);

  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), true);
  releaseFirst();
  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), true);
  releaseSecond();
  assert.equal(coordinator.shouldDeferAutoSyncForMutation(), false);
});

test("全量同步會全域依序執行，避免多個 form 同時壓 Ragic", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const releaseFirstSync = await coordinator.acquireSyncSlot();
  let secondSyncAcquired = false;
  const secondSyncPromise = coordinator.acquireSyncSlot().then((release) => {
    secondSyncAcquired = true;
    return release;
  });

  await nextTurn();
  try {
    assert.equal(secondSyncAcquired, false);
  } finally {
    releaseFirstSync();
    const releaseSecondSync = await secondSyncPromise;
    releaseSecondSync();
  }
});

test("request 在等待同步期間中斷時不會在同步結束後補做寫入", async () => {
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  const controller = new AbortController();
  let workerCalls = 0;
  const mutationPromise = runWorkReportEntryMutationExclusive(
    "104",
    `aborted-waiting-sync-${Date.now()}`,
    async () => {
      workerCalls += 1;
    },
    { signal: controller.signal }
  );

  await nextTurn();
  controller.abort();
  releaseSync();

  await assert.rejects(
    mutationPromise,
    (error: unknown) => error instanceof KeyedSerialQueueAbortedError
  );
  assert.equal(workerCalls, 0);
});
