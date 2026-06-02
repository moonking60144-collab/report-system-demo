/**
 * [16] 動作按鈕：重算目前這筆 [16]，再各重算一次對應 [104] / [105]
 * Action Button: syncWorkReport16({id})
 *
 * 簡化原則：
 * 1. 只處理目前這筆 /c1/16
 * 2. 先依 [16] 製程大分類 / 製程代碼判斷只算 [104] 或 [105]；判斷不出來再 fallback 雙算
 * 3. [16] / [104] / [105] 全部保留 workflow，讓既有 post 邏輯正常執行
 * 4. 全部不往 parent recalc，避免鏈式放大
 * 5. 回傳各步驟耗時，方便定位慢點
 */
function syncWorkReport16(recordId) {
    var PATH_16 = "/c1/16";
    var PATH_104 = "/forms8/104";
    var PATH_105 = "/forms8/105";

    var FIELD_16_WORK_ORDER_NO = 1006365;
    var FIELD_16_PROCESS = 1002195;
    var FIELD_16_PROD_TYPE = 1002191;
    var FIELD_104_WORK_ORDER_NO = 1005984;
    var FIELD_105_WORK_ORDER_NO = 1005984;
    var F_NORMAL = 1009096;  // [實際]時間-正常班(Hr)

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

    function resolveTargetForms(prodTypeValue, processValue) {
        var prodTypeText = normalizeText(prodTypeValue);
        var processText = normalizeText(processValue);
        var combined = [prodTypeText, processText].filter(Boolean).join("|");
        var matches104 = containsAny(combined, ["TI", "Process A"]);
        var matches105 = containsAny(combined, ["HF", "Process B"]);

        if (matches104 && !matches105) {
            return {
                run104: true,
                run105: false,
                mode: "104-only",
                debugSource: combined
            };
        }
        if (matches105 && !matches104) {
            return {
                run104: false,
                run105: true,
                mode: "105-only",
                debugSource: combined
            };
        }
        return {
            run104: true,
            run105: true,
            mode: "fallback-both",
            debugSource: combined
        };
    }

    function relinkRecalcAndSave(entry, options) {
        var startedAt = nowMs();
        var executeWorkflow = Boolean(options && options.executeWorkflow);
        entry.loadAllLinkAndLoad();
        entry.recalculateAllFormulas();
        entry.setIfDoLnls(false);
        entry.setIfExecuteWorkflow(executeWorkflow);
        entry.setRecalParentFormula(false);
        entry.save();
        return nowMs() - startedAt;
    }

    function findFirstEntryByWorkOrder(path, fieldId, workOrderText) {
        var startedAt = nowMs();
        var query = db.getAPIQuery(path);
        query.setIfIgnoreFixedFilter(true);
        query.addFilter(fieldId, "=", workOrderText);
        query.setLimitSize(1);

        var results = query.getAPIResultsFull();
        return {
            entry: results.next(),
            elapsedMs: nowMs() - startedAt
        };
    }

    var totalStartedAt = nowMs();
    var q16 = db.getAPIQuery(PATH_16);
    q16.setIfIgnoreFixedFilter(true);

    var e16 = q16.getAPIEntry(recordId);
    if (!e16) {
        response.setStatus("ERROR");
        response.setMessage("找不到 [16] 紀錄，recordId=" + recordId);
        return;
    }

    var workOrderNo = e16.getFieldValue(FIELD_16_WORK_ORDER_NO);
    var workOrderText = workOrderNo ? String(workOrderNo).trim() : "";
    var processValue = e16.getFieldValue(FIELD_16_PROCESS);
    var prodTypeValue = e16.getFieldValue(FIELD_16_PROD_TYPE);
    var targetForms = resolveTargetForms(prodTypeValue, processValue);
    var timing16Ms = relinkRecalcAndSave(e16, { executeWorkflow: false });

    if (!workOrderText) {
        response.setStatus("WARN");
        response.setMessage(
            "已完成 [16] relink/recalc/save，但工令單號為空，未重算 [104]/[105]" +
            "｜recordId=" + recordId +
            "｜routeMode=" + targetForms.mode +
            "｜normalHr=" + e16.getFieldValue(F_NORMAL) +
            "｜16Ms=" + timing16Ms +
            "｜totalMs=" + (nowMs() - totalStartedAt)
        );
        return;
    }

    var e104 = null;
    var query104Ms = 0;
    var timing104Ms = 0;
    if (targetForms.run104) {
        var found104 = findFirstEntryByWorkOrder(PATH_104, FIELD_104_WORK_ORDER_NO, workOrderText);
        e104 = found104.entry;
        query104Ms = found104.elapsedMs;
        if (e104) {
            timing104Ms = relinkRecalcAndSave(e104, { executeWorkflow: true });
        }
    }

    var e105 = null;
    var query105Ms = 0;
    var timing105Ms = 0;
    if (targetForms.run105) {
        var found105 = findFirstEntryByWorkOrder(PATH_105, FIELD_105_WORK_ORDER_NO, workOrderText);
        e105 = found105.entry;
        query105Ms = found105.elapsedMs;
        if (e105) {
            timing105Ms = relinkRecalcAndSave(e105, { executeWorkflow: true });
        }
    }

    response.setStatus("SUCCESS");
    response.setMessage(
        "已完成 relink/recalc/save" +
        "｜工令=" + workOrderText +
        "｜routeMode=" + targetForms.mode +
        "｜prodType=" + normalizeText(prodTypeValue) +
        "｜process=" + normalizeText(processValue) +
        "｜[16]=1" +
        "｜[104]=" + (targetForms.run104 ? (e104 ? "1" : "0") : "skip") +
        "｜[105]=" + (targetForms.run105 ? (e105 ? "1" : "0") : "skip") +
        "｜normalHr=" + e16.getFieldValue(F_NORMAL) +
        "｜q104Ms=" + query104Ms +
        "｜q105Ms=" + query105Ms +
        "｜16Ms=" + timing16Ms +
        "｜104Ms=" + timing104Ms +
        "｜105Ms=" + timing105Ms +
        "｜totalMs=" + (nowMs() - totalStartedAt)
    );
}
// * Action Button: syncWorkReport16({id}) END ==============================================================
