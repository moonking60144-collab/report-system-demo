import { describe, expect, it } from "vitest";
import { DEV_TOOLS } from "./devTools";

describe("DEV_TOOLS", () => {
  it("用同一個 NUI GUI 入口承接 definitions 操作", () => {
    const tool = DEV_TOOLS.find((item) => item.id === "definitions");

    expect(tool).toMatchObject({
      path: "/dev/definitions",
      label: "NUI GUI",
      group: "primary",
    });
    expect(DEV_TOOLS.filter((item) => item.path === "/dev/definitions")).toHaveLength(1);
  });
});
