import { describe, expect, it } from "vitest";
import { resolveOptimisticMutationFeatureEnabled } from "./optimisticMutationFeatureFlags";

describe("optimistic mutation feature flags", () => {
  it.each([undefined, "", "1", "true", "on"])(
    "未明確關閉時預設啟用：%s",
    (value) => {
      expect(resolveOptimisticMutationFeatureEnabled(value)).toBe(true);
    }
  );

  it.each(["0", "false", "FALSE", "off", " Off "])(
    "可用明確值關閉單一 domain：%s",
    (value) => {
      expect(resolveOptimisticMutationFeatureEnabled(value)).toBe(false);
    }
  );
});
