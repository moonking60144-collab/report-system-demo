import { describe, expect, it } from "vitest";
import { parseContentDispositionFilename } from "./downloadResponse";

describe("parseContentDispositionFilename", () => {
  it("優先解析 RFC 5987 UTF-8 filename", () => {
    expect(
      parseContentDispositionFilename(
        "attachment; filename=report.xlsx; filename*=UTF-8''c1-6-%E5%88%86%E6%9E%90.xlsx"
      )
    ).toBe("c1-6-分析.xlsx");
  });

  it("支援一般 quoted filename 並移除路徑", () => {
    expect(parseContentDispositionFilename('attachment; filename="../c1-6-2026-06.csv"')).toBe(
      "c1-6-2026-06.csv"
    );
    expect(
      parseContentDispositionFilename(
        `attachment; filename="report${String.fromCharCode(0, 31, 127)}.csv"`
      )
    ).toBe("report.csv");
  });

  it("無有效 filename 時回 null", () => {
    expect(parseContentDispositionFilename(undefined)).toBeNull();
    expect(parseContentDispositionFilename("attachment")).toBeNull();
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''%ZZ")).toBeNull();
  });
});
