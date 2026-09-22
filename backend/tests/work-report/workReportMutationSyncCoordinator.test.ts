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

test("auto-sync wave 可等待 mutation pressure 清空後再繼續", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const releaseMutation = await coordinator.acquireMutationSlot();
  let resumed = false;
  const waiting = coordinator.waitForMutationIdle?.().then(() => {
    resumed = true;
  });

  await nextTurn();
  assert.equal(resumed, false);
  releaseMutation();
  await waiting;
  assert.equal(resumed, true);
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

test("auto-sync scan lease 允許使用者 mutation，但仍阻擋其他 bulk sync", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const scanLease = await coordinator.acquireAutoSyncScanSlot?.();
  assert.ok(scanLease);

  let mutationAcquired = false;
  const mutationSlotPromise = coordinator.acquireMutationSlot().then((release) => {
    mutationAcquired = true;
    return release;
  });
  await nextTurn();
  assert.equal(mutationAcquired, true);

  let bulkSyncAcquired = false;
  const bulkSyncPromise = coordinator.acquireSyncSlot().then((release) => {
    bulkSyncAcquired = true;
    return release;
  });
  await nextTurn();
  assert.equal(bulkSyncAcquired, false);

  const releaseMutation = await mutationSlotPromise;
  releaseMutation();
  const releasePromotion = await scanLease.promote();
  await nextTurn();
  assert.equal(bulkSyncAcquired, false);

  releasePromotion();
  const releaseBulkSync = await bulkSyncPromise;
  assert.equal(bulkSyncAcquired, true);
  releaseBulkSync();
});

test("auto-sync promotion 等待既有 mutation 時，新的 mutation 不能插入短鎖", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const scanLease = await coordinator.acquireAutoSyncScanSlot?.();
  assert.ok(scanLease);

  const releaseFirstMutation = await coordinator.acquireMutationSlot();
  const promotionPromise = scanLease.promote();
  await nextTurn();

  let secondMutationAcquired = false;
  const secondMutationPromise = coordinator.acquireMutationSlot().then((release) => {
    secondMutationAcquired = true;
    return release;
  });
  await nextTurn();
  assert.equal(secondMutationAcquired, false);

  releaseFirstMutation();
  const releasePromotion = await promotionPromise;
  assert.equal(secondMutationAcquired, false);

  releasePromotion();
  const releaseSecondMutation = await secondMutationPromise;
  assert.equal(secondMutationAcquired, true);
  releaseSecondMutation();
});

test("auto-sync scan lease promotion 期間重複 release 不會破壞 slot 狀態", async () => {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const scanLease = await coordinator.acquireAutoSyncScanSlot?.();
  assert.ok(scanLease);
  const releaseMutation = await coordinator.acquireMutationSlot();
  const promotionPromise = scanLease.promote();

  scanLease.release();
  await assert.rejects(
    scanLease.promote(),
    (error: unknown) =>
      error instanceof Error && error.message === "auto sync scan lease promotion already in progress"
  );

  releaseMutation();
  const releasePromotion = await promotionPromise;
  releasePromotion();

  const nextScanLease = await coordinator.acquireAutoSyncScanSlot?.();
  assert.ok(nextScanLease);
  nextScanLease.release();
});

test("request 在等待同步期間中斷時不會在同步結束後補做寫入", async () => {
  const releaseSync = await workReportMutationSyncCoordinator.acquireSyncSlot();
  const controller = new AbortController();
  let workerCalls = 0;
  const mutationPromise = runWorkReportEntryMutationExclusive(
    "901",
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
