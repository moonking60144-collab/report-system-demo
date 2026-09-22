import { env, shouldUseSqliteReadForForm } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { reportFullSnapshotService } from "../../reportFullSnapshotService";
import { workReportReadService } from "../workReportReadService";

const log = createLogger("work-report-mutation-cache");

class WorkReportMutationCacheService {
  markReportFullCacheDirty(formId: string): void {
    if (!env.REPORT_FULL_CACHE_ENABLED) {
      return;
    }
    if (shouldUseSqliteReadForForm(formId)) {
      log.info({
        event: "full-cache.rebuild-skipped",
        formId,
        reason: "sqlite-primary-read-model",
      });
      return;
    }

    reportFullSnapshotService.markDirty(formId);
    const triggered = reportFullSnapshotService.triggerRebuildInBackground(
      formId,
      async () => workReportReadService.buildFullReportRecords(formId),
      "mutation"
    );
    if (triggered) {
      log.info({
        event: "full-cache.rebuild-triggered",
        formId,
        source: "mutation",
      });
    }
  }
}

export const workReportMutationCacheService = new WorkReportMutationCacheService();
