import { describe, expect, it } from "vitest";
import { isWorkOrderClosedStatus } from "./workOrderStatus";

describe("isWorkOrderClosedStatus", () => {
  it("只把正式已結案狀態視為不可編輯", () => {
    expect(isWorkOrderClosedStatus("已結案")).toBe(true);
    expect(isWorkOrderClosedStatus("未結案")).toBe(false);
    expect(isWorkOrderClosedStatus(null)).toBe(false);
  });
});
