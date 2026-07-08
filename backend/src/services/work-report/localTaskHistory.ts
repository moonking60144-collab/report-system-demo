import type { WorkReportQueueTaskStatus } from "./workReportTaskRegistryService";

export const WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT = 200;

export interface LocalTaskHistoryItem {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

function isTerminalTaskStatus(status: WorkReportQueueTaskStatus): boolean {
  return status === "success" || status === "failed";
}

function resolveTaskSortTimestamp(task: LocalTaskHistoryItem): string {
  return task.finishedAt ?? task.updatedAt ?? task.createdAt;
}

export function pruneTerminalTaskHistory<T extends LocalTaskHistoryItem>(
  tasks: Map<string, T>,
  limit = WORK_REPORT_LOCAL_TERMINAL_TASK_HISTORY_LIMIT
): number {
  if (limit < 0) {
    return 0;
  }

  const terminalTasks = Array.from(tasks.entries())
    .filter(([, task]) => isTerminalTaskStatus(task.status))
    .sort((left, right) => {
      const timestampCompare = resolveTaskSortTimestamp(left[1]).localeCompare(
        resolveTaskSortTimestamp(right[1])
      );
      if (timestampCompare !== 0) {
        return timestampCompare;
      }
      return left[1].taskId.localeCompare(right[1].taskId);
    });

  const overflowCount = terminalTasks.length - limit;
  if (overflowCount <= 0) {
    return 0;
  }

  for (const [taskId] of terminalTasks.slice(0, overflowCount)) {
    tasks.delete(taskId);
  }
  return overflowCount;
}
