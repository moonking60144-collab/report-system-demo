import { describe, expect, it } from "vitest";
import {
  resolveWorkReportFrontendEventCategory,
  WORK_REPORT_REQUIRED_FRONTEND_EVENT_ACTIONS,
} from "./workReportDeveloperContract";

describe("work report read performance event contract", () => {
  it("列表 preview latency 是必備 API diagnostic event", () => {
    expect(resolveWorkReportFrontendEventCategory("list-preview-read")).toBe("api");
    expect(WORK_REPORT_REQUIRED_FRONTEND_EVENT_ACTIONS.list).toContain(
      "list-preview-read"
    );
  });
});
