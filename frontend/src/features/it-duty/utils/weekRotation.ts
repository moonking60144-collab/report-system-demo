import type { ItDutyMember, ItDutyOverride } from "../../../api/itDuty";
import { isoWeekDiff } from "./isoWeek";

export interface RotationLookupResult {
  member: ItDutyMember | null;
  source: "override" | "auto" | "empty";
  appliedOverride: ItDutyOverride | null;
}

export interface RotationOptions {
  /**
   * 沒有任何 override 命中時的後備錨點。
   * 通常傳「使用者目前在看的本週」進來，這樣第一次使用 (DB 全空)
   * 也能呈現「本週=member[0]、下下個 slot=member[1]…」的合理預設。
   */
  autoAnchorIsoWeek?: string;
  /**
   * 一個值班 slot 包幾週。預設 1（每週換人）；設成 2 → 每人連值 2 週。
   * Override 命中時，會以該 override 為新 slot 的起點，後續往前 N 週仍是同人。
   */
  weeksPerSlot?: number;
}

function normalizeWeeksPerSlot(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  const trunc = Math.trunc(raw);
  if (trunc < 1) return 1;
  if (trunc > 52) return 52;
  return trunc;
}

/**
 * 給定目標 ISO 週，計算該週的值班人員。
 *
 * 規則：
 * 1. activeMembers = members 內 active=true 部份，依 sortOrder asc
 * 2. 若該週有 exact override（不論 propagateForward）→ 直接回該 override 的 member
 * 3. 找 < 目標週、且 propagateForward=true 的最近一筆 override 當 anchor
 *    - 命中且 member 仍 active → 從該 override 為「slot 起點」推算
 *    - 命中但已停用 / 已刪 → 視為「無 override」走預設
 * 4. 無可用 anchor → 用 autoAnchorIsoWeek 為 slot 起點、activeMembers[0] 為第一人
 * 5. activeMembers 為空 → empty
 */
export function calculateDutyForWeek(
  isoWeek: string,
  members: ItDutyMember[],
  overrides: ItDutyOverride[],
  options: RotationOptions = {}
): RotationLookupResult {
  const activeMembers = [...members]
    .filter((m) => m.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  if (activeMembers.length === 0) {
    return { member: null, source: "empty", appliedOverride: null };
  }

  const weeksPerSlot = normalizeWeeksPerSlot(options.weeksPerSlot);

  // 1) Exact override：該週有 override 一律以 override 為準（不管 propagateForward）
  const exactOverride = overrides.find((o) => o.isoWeek === isoWeek);
  if (exactOverride) {
    const idx = activeMembers.findIndex((m) => m.id === exactOverride.memberId);
    if (idx >= 0) {
      return {
        member: activeMembers[idx] ?? null,
        source: "override",
        appliedOverride: exactOverride,
      };
    }
    // exact override 指向的 member 已停用 → fall through 走後續推算
  }

  // 2) Anchor override：找 < 目標週、propagateForward=true 的最近一筆
  const propagatingOverrides = overrides
    .filter((o) => o.isoWeek < isoWeek && o.propagateForward)
    .sort((a, b) => (a.isoWeek < b.isoWeek ? 1 : a.isoWeek > b.isoWeek ? -1 : 0));

  for (const override of propagatingOverrides) {
    const anchorIndex = activeMembers.findIndex((m) => m.id === override.memberId);
    if (anchorIndex < 0) continue;
    const weekDelta = isoWeekDiff(isoWeek, override.isoWeek);
    if (weekDelta < 0) continue;
    const slotsAdvanced = Math.floor(weekDelta / weeksPerSlot);
    const offset =
      ((anchorIndex + slotsAdvanced) % activeMembers.length + activeMembers.length) %
      activeMembers.length;
    return {
      member: activeMembers[offset] ?? null,
      source: "auto",
      appliedOverride: override,
    };
  }

  // 3) 沒任何 anchor：用 autoAnchorIsoWeek + member[0] 推算
  const autoAnchor = options.autoAnchorIsoWeek ?? isoWeek;
  const autoWeekDelta = isoWeekDiff(isoWeek, autoAnchor);
  const slotsAdvanced =
    autoWeekDelta >= 0
      ? Math.floor(autoWeekDelta / weeksPerSlot)
      : -Math.ceil(-autoWeekDelta / weeksPerSlot);
  const autoOffset =
    ((slotsAdvanced % activeMembers.length) + activeMembers.length) %
    activeMembers.length;
  return {
    member: activeMembers[autoOffset] ?? null,
    source: "auto",
    appliedOverride: null,
  };
}
