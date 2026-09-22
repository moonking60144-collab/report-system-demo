import { realtimeEventBus } from "../../events/realtimeEventBus";

const activeForms = new Map<string, number>();

export function getSqliteAutoSyncStatus(): { activeFormIds: string[] } {
  return { activeFormIds: [...activeForms.keys()] };
}

function publishStatus(): void {
  realtimeEventBus.publish({ type: "sqlite-auto-sync-status", sqliteAutoSync: getSqliteAutoSyncStatus() });
}

export async function withSqliteAutoSyncActivity<T>(formId: string, run: () => Promise<T>): Promise<T> {
  activeForms.set(formId, (activeForms.get(formId) ?? 0) + 1);
  publishStatus();
  try {
    return await run();
  } finally {
    const remaining = (activeForms.get(formId) ?? 1) - 1;
    if (remaining > 0) activeForms.set(formId, remaining);
    else activeForms.delete(formId);
    publishStatus();
  }
}
