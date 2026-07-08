import { describe, expect, it } from "vitest";
import { shouldApplyDevAiThreadDetailSnapshot } from "./devAiViewUtils";

describe("shouldApplyDevAiThreadDetailSnapshot", () => {
  it("allows current detail responses", () => {
    expect(shouldApplyDevAiThreadDetailSnapshot(2, 2)).toBe(true);
  });

  it("drops stale detail responses after a newer local mutation", () => {
    expect(shouldApplyDevAiThreadDetailSnapshot(2, 3)).toBe(false);
  });
});
