interface AcquireSlotOptions {
  onWaiting?: () => void;
}

export interface WorkReportMutationSyncCoordinator {
  acquireMutationSlot(options?: AcquireSlotOptions): Promise<() => void>;
  acquireSyncSlot(options?: AcquireSlotOptions): Promise<() => void>;
  shouldDeferAutoSyncForMutation(): boolean;
}

export class WorkReportAutoSyncYieldRequestedError extends Error {
  constructor() {
    super("auto sync yielded to a waiting work-report mutation");
    this.name = "WorkReportAutoSyncYieldRequestedError";
  }
}

export function createWorkReportMutationSyncCoordinator(): WorkReportMutationSyncCoordinator {
  const syncIdleWaiters = new Set<() => void>();
  const mutationIdleWaiters = new Set<() => void>();
  let activeSyncCount = 0;
  let waitingMutationCount = 0;
  let activeMutationCount = 0;

  const waitForSyncIdle = (): Promise<void> => {
    if (activeSyncCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      syncIdleWaiters.add(resolve);
    });
  };

  const waitForMutationIdle = (): Promise<void> => {
    if (waitingMutationCount === 0 && activeMutationCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      mutationIdleWaiters.add(resolve);
    });
  };

  const notifySyncIdle = (): void => {
    if (activeSyncCount > 0) {
      return;
    }
    for (const resolve of syncIdleWaiters) {
      resolve();
    }
    syncIdleWaiters.clear();
  };

  const notifyMutationIdle = (): void => {
    if (waitingMutationCount > 0 || activeMutationCount > 0) {
      return;
    }
    for (const resolve of mutationIdleWaiters) {
      resolve();
    }
    mutationIdleWaiters.clear();
  };

  return {
    async acquireMutationSlot(options: AcquireSlotOptions = {}): Promise<() => void> {
      waitingMutationCount += 1;
      let waitingCounted = true;

      try {
        if (activeSyncCount > 0) {
          options.onWaiting?.();
          await waitForSyncIdle();
        }

        waitingMutationCount -= 1;
        waitingCounted = false;
        activeMutationCount += 1;
        let released = false;

        return () => {
          if (released) {
            return;
          }
          released = true;
          activeMutationCount -= 1;
          notifyMutationIdle();
        };
      } catch (error) {
        if (waitingCounted) {
          waitingMutationCount -= 1;
          notifyMutationIdle();
        }
        throw error;
      }
    },

    async acquireSyncSlot(options: AcquireSlotOptions = {}): Promise<() => void> {
      let mutationWaitingNotified = false;
      while (true) {
        if (waitingMutationCount > 0 || activeMutationCount > 0) {
          if (!mutationWaitingNotified) {
            mutationWaitingNotified = true;
            options.onWaiting?.();
          }
          await waitForMutationIdle();
          continue;
        }

        if (activeSyncCount > 0) {
          await waitForSyncIdle();
          continue;
        }

        break;
      }

      activeSyncCount += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeSyncCount -= 1;
        notifySyncIdle();
      };
    },

    shouldDeferAutoSyncForMutation(): boolean {
      return waitingMutationCount > 0 || activeMutationCount > 0;
    },
  };
}

export const workReportMutationSyncCoordinator =
  createWorkReportMutationSyncCoordinator();
