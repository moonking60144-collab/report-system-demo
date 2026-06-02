import { describe, expect, test } from "vitest";
import dayjs from "dayjs";
import type {
  ItDutyDaySwap,
  ItDutyDaySwapReason,
  ItDutyMember,
  ItDutyOverride,
} from "../../../api/itDuty";
import { calculateDutyForDay, findNextDutyDateForMember } from "./dayResolver";

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

let swapId = 1;
function makeSwap(
  coverDate: string,
  originalMemberId: number,
  coverMemberId: number,
  reason: ItDutyDaySwapReason = "leave",
  pairedSwapId: number | null = null
): ItDutyDaySwap {
  return {
    id: swapId++,
    coverDate,
    originalMemberId,
    coverMemberId,
    reason,
    pairedSwapId,
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("calculateDutyForDay", () => {
  test("沒成員 → empty", () => {
    const result = calculateDutyForDay("2026-05-06", [], [], []);
    expect(result.member).toBeNull();
    expect(result.baseMember).toBeNull();
    expect(result.swap).toBeNull();
    expect(result.baseSource).toBe("empty");
  });

  test("沒 swap → 回該週 base member", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = { autoAnchorIsoWeek: "2026-W19" };
    // 2026-05-06 is W19 (Mon May 4 ~ Sun May 10) → base = A
    const result = calculateDutyForDay(
      "2026-05-06",
      members,
      [],
      [],
      opts
    );
    expect(result.member?.name).toBe("A");
    expect(result.baseMember?.name).toBe("A");
    expect(result.swap).toBeNull();
  });

  test("該天有 leave swap → 回 cover member, base 仍是該週 base", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const swap = makeSwap("2026-05-06", 1, 2);
    const opts = { autoAnchorIsoWeek: "2026-W19" };
    const result = calculateDutyForDay(
      "2026-05-06",
      members,
      [],
      [swap],
      opts
    );
    expect(result.member?.name).toBe("B");
    expect(result.baseMember?.name).toBe("A");
    expect(result.swap?.id).toBe(swap.id);
  });

  test("Override 變更後，swap 仍以紀錄的 cover_member 為準（baseMember 反映現在）", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1),
      makeMember(3, "C", 2),
    ];
    // Original W19 leave: A→B (5/6)
    const swap = makeSwap("2026-05-06", 1, 2);
    // 之後改 W19 = C
    const overrides = [makeOverride("2026-W19", 3, false)];
    const result = calculateDutyForDay(
      "2026-05-06",
      members,
      overrides,
      [swap]
    );
    // 該天還是 B 在代班（swap 還在）
    expect(result.member?.name).toBe("B");
    // 但「現在算」的 base 是 C（override 改了）
    expect(result.baseMember?.name).toBe("C");
    expect(result.swap?.originalMemberId).toBe(1); // 紀錄的 original 仍是 A
  });

  test("repay swap 也會 overlay 該天值班", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    // Repay swap: B 原本 5/18 值，A 代班還班
    const swap = makeSwap("2026-05-18", 2, 1, "repay", 999);
    const opts = { autoAnchorIsoWeek: "2026-W19", weeksPerSlot: 1 };
    // 2026-05-18 是 W21（A 又輪到值班，但 swap 把它變成... 實際應 A 已經本來就值班 W21
    // 這個測試重點是 swap.coverMember 蓋過 base
    const result = calculateDutyForDay(
      "2026-05-18",
      members,
      [],
      [swap],
      opts
    );
    expect(result.member?.id).toBe(1); // swap.coverMember = A
    expect(result.swap?.reason).toBe("repay");
  });

  test("swap 指向已停用的 cover member → 仍回該人（紀錄忠於歷史，UI 自己決定怎麼顯示）", () => {
    const members = [
      makeMember(1, "A", 0),
      makeMember(2, "B", 1, false), // B 已停用
    ];
    const swap = makeSwap("2026-05-06", 1, 2);
    const result = calculateDutyForDay("2026-05-06", members, [], [swap]);
    expect(result.member?.id).toBe(2);
    expect(result.member?.active).toBe(false);
    expect(result.swap?.id).toBe(swap.id);
  });

  test("swap 指向已刪除的 member（members 列表沒有）→ member null", () => {
    const members = [makeMember(1, "A", 0)];
    const swap = makeSwap("2026-05-06", 1, 999); // 999 不存在
    const result = calculateDutyForDay("2026-05-06", members, [], [swap]);
    expect(result.member).toBeNull();
    expect(result.swap?.id).toBe(swap.id);
  });

  test("接受 dayjs 物件 / Date / string", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = { autoAnchorIsoWeek: "2026-W19" };
    expect(
      calculateDutyForDay(dayjs("2026-05-06"), members, [], [], opts).member
        ?.name
    ).toBe("A");
    expect(
      calculateDutyForDay(new Date("2026-05-06"), members, [], [], opts).member
        ?.name
    ).toBe("A");
    expect(
      calculateDutyForDay("2026-05-06", members, [], [], opts).member?.name
    ).toBe("A");
  });

  test("swap 不命中當天 → 不影響 base member", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const swap = makeSwap("2026-05-07", 1, 2);
    const opts = { autoAnchorIsoWeek: "2026-W19" };
    // 查 5/6（前一天），swap 在 5/7
    const result = calculateDutyForDay(
      "2026-05-06",
      members,
      [],
      [swap],
      opts
    );
    expect(result.member?.name).toBe("A");
    expect(result.swap).toBeNull();
  });
});

describe("findNextDutyDateForMember", () => {
  test("creditor 現在不在值班 → 回他下一輪 cycle 第一天", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
    };
    // W19=A, W20=B, W21=A → 從 5/4 找 B → 5/11
    const result = findNextDutyDateForMember(2, members, [], [], opts);
    expect(result).toBe("2026-05-11");
  });

  test("creditor 現在正在值班 → 跳過這輪，回再次輪到的第一天", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
    };
    // W19=A 進行中。找 A → 不能回 5/4-5/10（這輪），要 5/18 (W21)
    const result = findNextDutyDateForMember(1, members, [], [], opts);
    expect(result).toBe("2026-05-18");
  });

  test("跳過已被 swap 占用的日期", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
      blockedDates: new Set(["2026-05-11"]),
    };
    // B cycle W20 第一天 5/11 被占 → 推到 5/12
    const result = findNextDutyDateForMember(2, members, [], [], opts);
    expect(result).toBe("2026-05-12");
  });

  test("整週都被占 → 跳到下下個 cycle", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const blockedDates = new Set([
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
    ]);
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
      blockedDates,
    };
    // W20 整週被占 → 跳到 B 的下一輪 W22 = 5/25
    const result = findNextDutyDateForMember(2, members, [], [], opts);
    expect(result).toBe("2026-05-25");
  });

  test("該 member 從未排到（搜尋上限內）→ null", () => {
    const members = [makeMember(1, "A", 0)];
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
    };
    const result = findNextDutyDateForMember(999, members, [], [], opts);
    expect(result).toBeNull();
  });

  test("creditor cycle 第一天剛好被 swap 蓋掉 → 跳到 cycle 內下一未占日", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    // B 的 W20 第一天 5/11 已被代班占
    const swap = makeSwap("2026-05-11", 2, 1);
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 1,
      blockedDates: new Set(["2026-05-11"]),
    };
    // 找 B 下一輪：應跳到 5/12（B 仍 base 在 W20）
    const result = findNextDutyDateForMember(2, members, [], [swap], opts);
    expect(result).toBe("2026-05-12");
  });

  test("weeksPerSlot=2：creditor 現在連值 2 週中 → 跳過整 2 週", () => {
    const members = [makeMember(1, "A", 0), makeMember(2, "B", 1)];
    const opts = {
      fromDate: "2026-05-04",
      autoAnchorIsoWeek: "2026-W19",
      weeksPerSlot: 2,
    };
    // W19+W20 = A; W21+W22 = B; W23+W24 = A
    // 找 A → 跳過 W19+W20，跳過 W21+W22 (B)，回 W23 = 6/1
    const result = findNextDutyDateForMember(1, members, [], [], opts);
    expect(result).toBe("2026-06-01");
  });
});
