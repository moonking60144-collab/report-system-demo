import type { CircuitState } from "../../infra/circuitBreaker";
import {
  ragicRequestScheduler,
  type RagicReadinessCircuitStates,
} from "../../infra/ragicRequestScheduler";
import {
  workReportSqliteRepository,
  type StoredSyncState,
} from "../../storage/sqlite/workReportSqliteRepository";
import { hasReadableSqliteSnapshot } from "./readModelState";
import { getWorkReportEntryMutationQueueStats } from "./workReportEntryMutationQueue";
import { systemNoticeService } from "../systemNoticeService";
import { SERVER_BOOT_ID } from "../../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../../observability/deployVersionState";

const WORK_REPORT_FORM_IDS = ["901", "902"] as const;

export interface WorkReportReadinessFormState {
  available: boolean;
  readable: boolean;
  status: string | null;
  snapshotAt: string | null;
  readModelVersion: number | null;
  error: string | null;
}

export interface WorkReportReadinessSnapshot {
  ready: boolean;
  mode: "ready" | "degraded" | "unavailable";
  checkedAt: string;
  bootId: string;
  deployVersion: string;
  capabilities: {
    frontend: true;
    workReportRead: boolean;
    workReportWrite: boolean;
    realtime: true;
  };
  dependencies: {
    maintenanceMode: boolean;
    sqlite: Record<(typeof WORK_REPORT_FORM_IDS)[number], WorkReportReadinessFormState>;
    mutationQueue: {
      accepting: boolean;
      activeKeyCount: number;
      pendingTaskCount: number;
    };
    ragic: {
      readCircuitState: CircuitState;
      mutationCircuitState: CircuitState;
      writeCircuitState: CircuitState;
    };
  };
  issues: string[];
}

interface WorkReportReadinessServiceDeps {
  getSyncState: (formId: string) => Promise<StoredSyncState | null>;
  getMutationQueueStats: typeof getWorkReportEntryMutationQueueStats;
  getRagicCircuitStates: () => RagicReadinessCircuitStates;
  getMaintenanceMode: () => Promise<boolean>;
  getBootId: () => string;
  getDeployVersion: () => string;
  now: () => Date;
}

async function readFormState(
  formId: string,
  getSyncState: WorkReportReadinessServiceDeps["getSyncState"]
): Promise<WorkReportReadinessFormState> {
  try {
    const syncState = await getSyncState(formId);
    return {
      available: true,
      readable: hasReadableSqliteSnapshot(syncState),
      status: syncState?.status ?? null,
      snapshotAt: syncState?.snapshotAt ?? null,
      readModelVersion: syncState?.readModelVersion ?? null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      readable: false,
      status: null,
      snapshotAt: null,
      readModelVersion: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createWorkReportReadinessService(
  overrides: Partial<WorkReportReadinessServiceDeps> = {}
): { getSnapshot: () => Promise<WorkReportReadinessSnapshot> } {
  const deps: WorkReportReadinessServiceDeps = {
    getSyncState: (formId) => workReportSqliteRepository.getSyncState(formId),
    getMutationQueueStats: getWorkReportEntryMutationQueueStats,
    getRagicCircuitStates: () => ragicRequestScheduler.getReadinessCircuitStates(),
    getMaintenanceMode: async () => (await systemNoticeService.getNotice()).maintenanceMode,
    getBootId: () => SERVER_BOOT_ID,
    getDeployVersion: () => SERVER_DEPLOY_VERSION,
    now: () => new Date(),
    ...overrides,
  };
  let inFlight: Promise<WorkReportReadinessSnapshot> | null = null;

  const computeSnapshot = async (): Promise<WorkReportReadinessSnapshot> => {
    const [form901, form902, maintenanceResult] = await Promise.all([
      readFormState("901", deps.getSyncState),
      readFormState("902", deps.getSyncState),
      deps.getMaintenanceMode().then(
        (maintenanceMode) => ({ maintenanceMode, error: null as string | null }),
        (error) => ({
          maintenanceMode: false,
          error: error instanceof Error ? error.message : String(error),
        })
      ),
    ]);
    const sqlite = { "901": form901, "902": form902 };
    const mutationQueue = deps.getMutationQueueStats();
    const ragic = deps.getRagicCircuitStates();
    const ragicReadAvailable = ragic.readCircuitState !== "open";
    const workReportRead = WORK_REPORT_FORM_IDS.every(
      (formId) => sqlite[formId].readable || ragicReadAvailable
    );
    const workReportWrite =
      mutationQueue.accepting &&
      ragic.mutationCircuitState !== "open" &&
      ragic.writeCircuitState !== "open";
    const ready = workReportRead && workReportWrite;
    const issues: string[] = [];

    if (maintenanceResult.error) issues.push("SYSTEM_NOTICE_STATE_UNAVAILABLE");
    if (!mutationQueue.accepting) issues.push("MUTATION_QUEUE_CLOSED");
    for (const formId of WORK_REPORT_FORM_IDS) {
      const state = sqlite[formId];
      if (!state.available) {
        issues.push(`SQLITE_${formId}_UNAVAILABLE`);
      } else if (!state.readable) {
        issues.push(`SQLITE_SNAPSHOT_${formId}_UNAVAILABLE`);
      }
    }
    if (ragic.readCircuitState !== "closed") {
      issues.push(`RAGIC_READ_CIRCUIT_${ragic.readCircuitState.toUpperCase()}`);
    }
    if (ragic.mutationCircuitState !== "closed") {
      issues.push(`RAGIC_MUTATION_CIRCUIT_${ragic.mutationCircuitState.toUpperCase()}`);
    }
    if (ragic.writeCircuitState !== "closed") {
      issues.push(`RAGIC_WRITE_CIRCUIT_${ragic.writeCircuitState.toUpperCase()}`);
    }

    return {
      ready,
      mode: !ready ? "unavailable" : issues.length > 0 ? "degraded" : "ready",
      checkedAt: deps.now().toISOString(),
      bootId: deps.getBootId(),
      deployVersion: deps.getDeployVersion(),
      capabilities: {
        frontend: true,
        workReportRead,
        workReportWrite,
        realtime: true,
      },
      dependencies: {
        maintenanceMode: maintenanceResult.maintenanceMode,
        sqlite,
        mutationQueue,
        ragic: {
          readCircuitState: ragic.readCircuitState,
          mutationCircuitState: ragic.mutationCircuitState,
          writeCircuitState: ragic.writeCircuitState,
        },
      },
      issues,
    };
  };

  return {
    async getSnapshot() {
      if (inFlight) return inFlight;
      inFlight = computeSnapshot().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

export const workReportReadinessService = createWorkReportReadinessService();
