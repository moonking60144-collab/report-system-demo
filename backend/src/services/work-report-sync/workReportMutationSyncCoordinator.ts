interface AcquireSlotOptions {
  onWaiting?: () => void;
}

export interface WorkReportAutoSyncScanLease {
  promote(): Promise<() => void>;
  release(): void;
}

export interface WorkReportMutationSyncCoordinator {
  acquireMutationSlot(options?: AcquireSlotOptions): Promise<() => void>;
  acquireSyncSlot(options?: AcquireSlotOptions): Promise<() => void>;
  acquireAutoSyncScanSlot?(options?: AcquireSlotOptions): Promise<WorkReportAutoSyncScanLease>;
  waitForMutationIdle?(): Promise<void>;
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
  const autoScanIdleWaiters = new Set<() => void>();
  const promotionIdleWaiters = new Set<() => void>();
  const activeMutationIdleWaiters = new Set<() => void>();
  const mutationIdleWaiters = new Set<() => void>();
  let activeSyncCount = 0;
  let activeAutoScanCount = 0;
  let activePromotionCount = 0;
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

  const waitForAutoScanIdle = (): Promise<void> => {
    if (activeAutoScanCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      autoScanIdleWaiters.add(resolve);
    });
  };

  const notifyAutoScanIdle = (): void => {
    if (activeAutoScanCount > 0) {
      return;
    }
    for (const resolve of autoScanIdleWaiters) {
      resolve();
    }
    autoScanIdleWaiters.clear();
  };

  const waitForPromotionIdle = (): Promise<void> => {
    if (activePromotionCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      promotionIdleWaiters.add(resolve);
    });
  };

  const notifyPromotionIdle = (): void => {
    if (activePromotionCount > 0) {
      return;
    }
    for (const resolve of promotionIdleWaiters) {
      resolve();
    }
    promotionIdleWaiters.clear();
  };

  const waitForActiveMutationIdle = (): Promise<void> => {
    if (activeMutationCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      activeMutationIdleWaiters.add(resolve);
    });
  };

  const notifyActiveMutationIdle = (): void => {
    if (activeMutationCount > 0) {
      return;
    }
    for (const resolve of activeMutationIdleWaiters) {
      resolve();
    }
    activeMutationIdleWaiters.clear();
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
      let waitingNotified = false;

      try {
        while (activeSyncCount > 0 || activePromotionCount > 0) {
          if (!waitingNotified) {
            waitingNotified = true;
            options.onWaiting?.();
          }
          if (activeSyncCount > 0) {
            await waitForSyncIdle();
          } else {
            await waitForPromotionIdle();
          }
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
          notifyActiveMutationIdle();
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

        if (activeAutoScanCount > 0) {
          await waitForAutoScanIdle();
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

    async acquireAutoSyncScanSlot(
      options: AcquireSlotOptions = {}
    ): Promise<WorkReportAutoSyncScanLease> {
      let waitingNotified = false;
      while (activeSyncCount > 0 || activeAutoScanCount > 0) {
        if (!waitingNotified) {
          waitingNotified = true;
          options.onWaiting?.();
        }
        if (activeSyncCount > 0) {
          await waitForSyncIdle();
        } else {
          await waitForAutoScanIdle();
        }
      }

      activeAutoScanCount += 1;
      let released = false;
      let promoting = false;
      let promoted = false;
      const releaseScan = (): void => {
        if (released || promoting || promoted) {
          return;
        }
        released = true;
        activeAutoScanCount -= 1;
        notifyAutoScanIdle();
      };

      return {
        async promote(): Promise<() => void> {
          if (released) {
            throw new Error("auto sync scan lease already released");
          }
          if (promoted) {
            throw new Error("auto sync scan lease already promoted");
          }
          if (promoting) {
            throw new Error("auto sync scan lease promotion already in progress");
          }
          promoting = true;
          activePromotionCount += 1;
          try {
            await waitForActiveMutationIdle();
            if (activeSyncCount > 0) {
              await waitForSyncIdle();
              await waitForActiveMutationIdle();
            }
          } catch (error) {
            activePromotionCount -= 1;
            promoting = false;
            notifyPromotionIdle();
            throw error;
          }
          // Keep the auto scan lease while waiting, so another bulk sync cannot
          // slip between the final tail read and generation promotion.
          activeAutoScanCount -= 1;
          notifyAutoScanIdle();
          activeSyncCount += 1;
          activePromotionCount -= 1;
          notifyPromotionIdle();
          promoting = false;
          promoted = true;
          let syncReleased = false;
          return () => {
            if (syncReleased) {
              return;
            }
            syncReleased = true;
            activeSyncCount -= 1;
            notifySyncIdle();
          };
        },
        release: releaseScan,
      };
    },

    waitForMutationIdle,

    shouldDeferAutoSyncForMutation(): boolean {
      return waitingMutationCount > 0 || activeMutationCount > 0;
    },
  };
}

export const workReportMutationSyncCoordinator =
  createWorkReportMutationSyncCoordinator();
