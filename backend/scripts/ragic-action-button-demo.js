/**
 * Demo Ragic action button.
 *
 * Recalculates one activity record, routes its work order to the matching
 * synthetic production line, and falls back to both lines when the routing
 * fields are incomplete. All paths, field IDs and process values are Demo-only.
 */
function syncDemoWorkReport(recordId) {
    var PATH_ACTIVITY = "/demo/activity-logs";
    var PATH_LINE_A = "/demo/work-orders/line-a";
    var PATH_LINE_B = "/demo/work-orders/line-b";

    var FIELD_ACTIVITY_WORK_ORDER = 9001047;
    var FIELD_ACTIVITY_PROCESS = 9001033;
    var FIELD_ACTIVITY_CATEGORY = 9001031;
    var FIELD_ACTIVITY_NORMAL_HOURS = 9001059;
    var FIELD_LINE_A_WORK_ORDER = 9001040;
    var FIELD_LINE_B_WORK_ORDER = 9001040;

    function nowMs() {
        return new Date().getTime();
    }

    function normalizeText(value) {
        return value ? String(value).trim().toUpperCase() : "";
    }

    function containsAny(source, candidates) {
        for (var i = 0; i < candidates.length; i += 1) {
            if (source.indexOf(candidates[i]) !== -1) {
                return true;
            }
        }
        return false;
    }

    function resolveTargets(categoryValue, processValue) {
        var combined = [normalizeText(categoryValue), normalizeText(processValue)]
            .filter(Boolean)
            .join("|");
        var matchesLineA = containsAny(combined, ["PA", "PROCESS-A"]);
        var matchesLineB = containsAny(combined, ["PB", "PROCESS-B"]);

        if (matchesLineA && !matchesLineB) {
            return { runLineA: true, runLineB: false, mode: "line-a-only" };
        }
        if (matchesLineB && !matchesLineA) {
            return { runLineA: false, runLineB: true, mode: "line-b-only" };
        }
        return { runLineA: true, runLineB: true, mode: "fallback-both" };
    }

    function relinkRecalculateAndSave(entry, executeWorkflow) {
        var startedAt = nowMs();
        entry.loadAllLinkAndLoad();
        entry.recalculateAllFormulas();
        entry.setIfDoLnls(false);
        entry.setIfExecuteWorkflow(executeWorkflow);
        entry.setRecalParentFormula(false);
        entry.save();
        return nowMs() - startedAt;
    }

    function findFirstByWorkOrder(path, fieldId, workOrderNo) {
        var startedAt = nowMs();
        var query = db.getAPIQuery(path);
        query.setIfIgnoreFixedFilter(true);
        query.addFilter(fieldId, "=", workOrderNo);
        query.setLimitSize(1);
        var results = query.getAPIResultsFull();
        return { entry: results.next(), elapsedMs: nowMs() - startedAt };
    }

    var totalStartedAt = nowMs();
    var activityQuery = db.getAPIQuery(PATH_ACTIVITY);
    activityQuery.setIfIgnoreFixedFilter(true);

    var activity = activityQuery.getAPIEntry(recordId);
    if (!activity) {
        response.setStatus("ERROR");
        response.setMessage("Demo activity not found: " + recordId);
        return;
    }

    var workOrderValue = activity.getFieldValue(FIELD_ACTIVITY_WORK_ORDER);
    var workOrderNo = workOrderValue ? String(workOrderValue).trim() : "";
    var processValue = activity.getFieldValue(FIELD_ACTIVITY_PROCESS);
    var categoryValue = activity.getFieldValue(FIELD_ACTIVITY_CATEGORY);
    var targets = resolveTargets(categoryValue, processValue);
    var activityMs = relinkRecalculateAndSave(activity, false);

    if (!workOrderNo) {
        response.setStatus("WARN");
        response.setMessage(
            "Activity recalculated; work order is empty" +
            " | recordId=" + recordId +
            " | route=" + targets.mode +
            " | normalHours=" + activity.getFieldValue(FIELD_ACTIVITY_NORMAL_HOURS) +
            " | activityMs=" + activityMs +
            " | totalMs=" + (nowMs() - totalStartedAt)
        );
        return;
    }

    var lineA = null;
    var lineAQueryMs = 0;
    var lineASaveMs = 0;
    if (targets.runLineA) {
        var foundLineA = findFirstByWorkOrder(PATH_LINE_A, FIELD_LINE_A_WORK_ORDER, workOrderNo);
        lineA = foundLineA.entry;
        lineAQueryMs = foundLineA.elapsedMs;
        if (lineA) {
            lineASaveMs = relinkRecalculateAndSave(lineA, true);
        }
    }

    var lineB = null;
    var lineBQueryMs = 0;
    var lineBSaveMs = 0;
    if (targets.runLineB) {
        var foundLineB = findFirstByWorkOrder(PATH_LINE_B, FIELD_LINE_B_WORK_ORDER, workOrderNo);
        lineB = foundLineB.entry;
        lineBQueryMs = foundLineB.elapsedMs;
        if (lineB) {
            lineBSaveMs = relinkRecalculateAndSave(lineB, true);
        }
    }

    response.setStatus("SUCCESS");
    response.setMessage(
        "Demo relink/recalculate/save completed" +
        " | workOrder=" + workOrderNo +
        " | route=" + targets.mode +
        " | lineA=" + (targets.runLineA ? (lineA ? "found" : "missing") : "skipped") +
        " | lineB=" + (targets.runLineB ? (lineB ? "found" : "missing") : "skipped") +
        " | lineAQueryMs=" + lineAQueryMs +
        " | lineBQueryMs=" + lineBQueryMs +
        " | activityMs=" + activityMs +
        " | lineASaveMs=" + lineASaveMs +
        " | lineBSaveMs=" + lineBSaveMs +
        " | totalMs=" + (nowMs() - totalStartedAt)
    );
}
