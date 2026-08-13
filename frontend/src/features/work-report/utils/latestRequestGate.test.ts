import { describe, expect, it } from "vitest";
import { LatestRequestGate } from "./latestRequestGate";

describe("LatestRequestGate", () => {
  it("只允許最新開始的 request 更新 state", () => {
    const gate = new LatestRequestGate();
    const first = gate.start();
    const second = gate.start();

    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });

  it("新 request 開始前保留目前 request 的更新權", () => {
    const gate = new LatestRequestGate();
    const current = gate.start();

    expect(gate.isLatest(current)).toBe(true);
  });
});
