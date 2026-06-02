import { describe, expect, test } from "vitest";
import type { ItDutyMember, ItDutyOverride } from "../../../api/itDuty";
import { calculateDutyForWeek } from "./rotationCalculator";

function makeMember(
  id: number,
  name: string,
  sortOrder: number,
  active = true
): ItDutyMember {
  return {
    id,
    name,
    sortOrder,
    active,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeOverride(
  isoWeek: string,
  memberId: number,
  propagateForward = true
): ItDutyOverride {
  return {
    isoWeek,
    memberId,
    note: null,
    propagateForward,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedByLabel: null,
  };
}

describe("calculateDutyForWeek", () => {
  test("沒成員 → empty", () => {
    const result = calculateDutyForWeek("2026-W18", [], []);
    expect(result.member).toBeNull();
    expect(result.source).toBe("empty");
  });

  test("沒 override → 預設用 sort=0 第一個 active member", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const result = calculateDutyForWeek("2026-W18", members, []);
    expect(result.member?.name).toBe("A");
    expect(result.source).toBe("auto");
    expect(result.appliedOverride).toBeNull();
  });

  test("override 命中當週 → source = override", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const overrides = [makeOverride("2026-W18", 2)];
    const result = calculateDutyForWeek("2026-W18", members, overrides);
    expect(result.member?.name).toBe("B");
    expect(result.source).toBe("override");
  });

  test("override 在過去 → 推算當週為 auto", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // W10 anchor=B；W11=C；W12=A；W13=B
    const overrides = [makeOverride("2026-W10", 2)];
    const w10 = calculateDutyForWeek("2026-W10", members, overrides);
    const w11 = calculateDutyForWeek("2026-W11", members, overrides);
    const w12 = calculateDutyForWeek("2026-W12", members, overrides);
    const w13 = calculateDutyForWeek("2026-W13", members, overrides);
    expect(w10.member?.name).toBe("B");
    expect(w11.member?.name).toBe("C");
    expect(w12.member?.name).toBe("A");
    expect(w13.member?.name).toBe("B");
    expect(w11.source).toBe("auto");
    expect(w11.appliedOverride?.isoWeek).toBe("2026-W10");
  });

  test("多個 override，取最近 ≤ 目標週的那筆當 anchor", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    const overrides = [
      makeOverride("2026-W10", 1), // anchor=A
      makeOverride("2026-W15", 3), // anchor=C
    ];
    // W12 → 最近 override 是 W10 (anchor=A, delta=2) → C
    expect(calculateDutyForWeek("2026-W12", members, overrides).member?.name).toBe("C");
    // W15 → override 命中 W15 → C
    const w15 = calculateDutyForWeek("2026-W15", members, overrides);
    expect(w15.member?.name).toBe("C");
    expect(w15.source).toBe("override");
    // W16 → anchor=W15(C), delta=1 → A
    expect(calculateDutyForWeek("2026-W16", members, overrides).member?.name).toBe("A");
    // W17 → anchor=W15(C), delta=2 → B
    expect(calculateDutyForWeek("2026-W17", members, overrides).member?.name).toBe("B");
  });

  test("override 指向已停用的 member → fallback 到前一筆 override", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1, false), // 停用
      makeMember(3, "C", 2),
    ];
    const overrides = [
      makeOverride("2026-W10", 1), // anchor=A → 有效
      makeOverride("2026-W15", 2), // anchor=B → 已停用 → 跳過
    ];
    // W16：應該回退用 W10(A) 為 anchor，delta=6 → A,C,A,C,A,C,A → activeMembers=[A,C]，offset=(0+6)%2=0 → A
    const w16 = calculateDutyForWeek("2026-W16", members, overrides);
    expect(w16.member?.name).toBe("A");
    expect(w16.appliedOverride?.isoWeek).toBe("2026-W10");
  });

  test("所有 override 都指向已停用 member → 走預設第一個 active", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1, false),
    ];
    const overrides = [makeOverride("2026-W10", 2)];
    const result = calculateDutyForWeek("2026-W18", members, overrides);
    expect(result.member?.name).toBe("A");
    expect(result.source).toBe("auto");
    expect(result.appliedOverride).toBeNull();
  });

  test("inactive member 不參與輪值順序計算", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "X", 1, false), // X 停用
      makeMember(3, "C", 2),
    ];
    // 沒 override，autoAnchor=W18 → W18=A, W19=C, W20=A
    const opts = { autoAnchorIsoWeek: "2026-W18" };
    expect(calculateDutyForWeek("2026-W18", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, [], opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W20", members, [], opts).member?.name).toBe("A");
  });

  test("沒 override 帶 autoAnchorIsoWeek → 從 anchor 週起 member[0] 開輪", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    const opts = { autoAnchorIsoWeek: "2026-W18" };
    expect(calculateDutyForWeek("2026-W18", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W20", members, [], opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W21", members, [], opts).member?.name).toBe("A");
  });

  test("跨年的 ISO 週也能正確推算", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const overrides = [makeOverride("2025-W52", 1)];
    // 2025-W52 → A; 2026-W01 → B; 2026-W02 → A
    expect(calculateDutyForWeek("2025-W52", members, overrides).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W01", members, overrides).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W02", members, overrides).member?.name).toBe("A");
  });

  test("weeksPerSlot=2：每人連值 2 週", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = { autoAnchorIsoWeek: "2026-W18", weeksPerSlot: 2 };
    expect(calculateDutyForWeek("2026-W18", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W20", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W21", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W22", members, [], opts).member?.name).toBe("A");
  });

  test("weeksPerSlot=3：每人連值 3 週", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    const opts = { autoAnchorIsoWeek: "2026-W18", weeksPerSlot: 3 };
    // W18-W20 = A; W21-W23 = B; W24-W26 = C; W27-W29 = A
    expect(calculateDutyForWeek("2026-W18", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W20", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W21", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W23", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W24", members, [], opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W27", members, [], opts).member?.name).toBe("A");
  });

  test("weeksPerSlot=2 且 override 落在 slot 中間：override 重置 slot 起點", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // W18 起 anchor=A weeksPerSlot=2 → W18,W19=A; W20,W21=B
    // 但 W19 manually 改派為 C → W19 起新 slot
    // → W19=C(override), W20=C(slot 同), W21=A, W22=A, W23=B, W24=B
    const overrides = [makeOverride("2026-W19", 3)];
    const opts = { autoAnchorIsoWeek: "2026-W18", weeksPerSlot: 2 };
    expect(calculateDutyForWeek("2026-W18", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, overrides, opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W20", members, overrides, opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W21", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W22", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W23", members, overrides, opts).member?.name).toBe("B");
  });

  test("weeksPerSlot=1 跟原本行為一致（不傳 = 預設 1）", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = { autoAnchorIsoWeek: "2026-W18" };
    expect(calculateDutyForWeek("2026-W18", members, [], opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, [], opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W20", members, [], opts).member?.name).toBe("A");
  });

  test("propagateForward=false：override 只改當週、之後仍照原順序", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // autoAnchor=W18 → W18=A,W19=B,W20=C,W21=A
    // 在 W19 改派為 C、不影響後續 → W19=C(override)、W20=C(原本順序)、W21=A(原本)
    const overrides = [makeOverride("2026-W19", 3, false)];
    const opts = { autoAnchorIsoWeek: "2026-W18" };
    expect(calculateDutyForWeek("2026-W18", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, overrides, opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W20", members, overrides, opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W21", members, overrides, opts).member?.name).toBe("A");
  });

  test("propagateForward=true（預設）：override 後從新順序開始", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // 在 W19 改派為 C、且影響後續 → W19=C, W20=A, W21=B, W22=C
    const overrides = [makeOverride("2026-W19", 3, true)];
    const opts = { autoAnchorIsoWeek: "2026-W18" };
    expect(calculateDutyForWeek("2026-W18", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W19", members, overrides, opts).member?.name).toBe("C");
    expect(calculateDutyForWeek("2026-W20", members, overrides, opts).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W21", members, overrides, opts).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W22", members, overrides, opts).member?.name).toBe("C");
  });

  test("混用：propagating override + 後續單週 patch 不互相干擾", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // W10 anchor=B (propagate) → W10=B, W11=C, W12=A, W13=B
    // W11 patch=A (single-week) → W11=A 但 W12 仍按 W10 anchor 計算 = A
    // 所以：W10=B, W11=A(patch), W12=A(propagate W10 + delta 2), W13=B
    const overrides = [
      makeOverride("2026-W10", 2, true),
      makeOverride("2026-W11", 1, false),
    ];
    expect(calculateDutyForWeek("2026-W10", members, overrides).member?.name).toBe("B");
    expect(calculateDutyForWeek("2026-W11", members, overrides).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W12", members, overrides).member?.name).toBe("A");
    expect(calculateDutyForWeek("2026-W13", members, overrides).member?.name).toBe("B");
  });
});
