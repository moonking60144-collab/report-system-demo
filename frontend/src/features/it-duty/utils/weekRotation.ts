import type { ItDutyMember, ItDutyOverride } from "../../../api/itDuty";
import { isoWeekDiff } from "./isoWeek";

// 用來 dedupe defensive fallback 的 console.warn — 月曆一次 render 會 call
// calculateDutyForWeek 數十次（35 day cells + 5+ week rows），不去重 console 會被噴爆。
// 簡單實作：紀錄已 warn 過的 isoWeek，整個 session 同 isoWeek 只 warn 一次。
const warnedFallbackWeeks = new Set<string>();

export interface RotationLookupResult {
  member: ItDutyMember | null;
  source: "override" | "auto" | "empty";
  /**
   * 命中的「實際 propagating override」(來自 it_duty_assignment_override 表)。
   * 若是用 anchor（it_duty_setting）算出來的，這欄是 null。
   */
  appliedOverride: ItDutyOverride | null;
}

export interface RotationOptions {
  /**
   * 後端 it_duty_setting 持久化的 rotation 起點 — 第一次有 member 時 seed，
   * 之後固定不變。等同「永遠存在的最早一筆 propagating override」。
   * 為 null 時 = 還沒任何 member、整個 rotation 視為 empty。
   */
  anchorIsoWeek: string | null;
  anchorMemberId: number | null;
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
 * 演算法（從上往下找第一個命中的）：
 * 1. activeMembers = members 內 active=true 部份，依 sortOrder asc
 * 2. activeMembers 為空 → empty
 * 3. 該週有 exact override → 直接回該 override 的 member
 *    （exact override 的 member 已停用 → fall through 走下一條）
 * 4. 找 < 目標週、且 propagateForward=true 的最近一筆 override 當 anchor
 *    （= 目標週的 propagating override 已被 branch 3 的 exact override 接走）
 *    （命中且 member 仍 active → 從該 override 為「slot 起點」推算）
 *    （命中但已停用 → fall through 找更早一筆）
 * 5. 用 setting.anchorIsoWeek + anchorMemberId 推算
 *    （anchor 是後端持久化的初始條件，效果等於「永遠存在的最早 propagating override」）
 * 6. anchor member 已停用 → fall back 到 activeMembers[0]、anchor 週仍用 setting.anchorIsoWeek
 *    （member 失效時後端 getSetting 會 refill，理論上前端走到這條很罕見；保留作 defensive）
 *
 * Source 標記：override = exact 命中；auto = 走 propagating override 或 anchor 推算
 */
export function calculateDutyForWeek(
  isoWeek: string,
  members: ItDutyMember[],
  overrides: ItDutyOverride[],
  options: RotationOptions
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
      ((anchorIndex + slotsAdvanced) % activeMembers.length +
        activeMembers.length) %
      activeMembers.length;
    return {
      member: activeMembers[offset] ?? null,
      source: "auto",
      appliedOverride: override,
    };
  }

  // 3) 後端 setting 持久化的 anchor — 等同「永遠存在的最早 propagating override」
  if (!options.anchorIsoWeek) {
    // 不該到達：active members > 0 時、後端 getSetting 一定會 seed anchor。
    // 走到這條代表前端 setting state 還沒 refetch（race or stale cache）。
    // 防禦：給 activeMembers[0]，每週都同一人 — 故意「明顯錯」讓使用者察覺去重整。
    if (typeof console !== "undefined" && !warnedFallbackWeeks.has(isoWeek)) {
      warnedFallbackWeeks.add(isoWeek);
      console.warn(
        "[itDuty] calculateDutyForWeek fallback hit: anchorIsoWeek=null but activeMembers > 0. " +
          "Setting 可能還沒 refetch、rotation 退回 defensive。重整頁面即可。",
        { isoWeek }
      );
    }
    return {
      member: activeMembers[0] ?? null,
      source: "auto",
      appliedOverride: null,
    };
  }
  const anchorIndex =
    options.anchorMemberId !== null
      ? activeMembers.findIndex((m) => m.id === options.anchorMemberId)
      : -1;
  // anchor member 失效 → fall back 到 activeMembers[0]
  // （後端 getSetting 會 refill，理論上前端拿到的 setting 已 refresh）
  const effectiveAnchorIndex = anchorIndex >= 0 ? anchorIndex : 0;
  const weekDelta = isoWeekDiff(isoWeek, options.anchorIsoWeek);
  const slotsAdvanced =
    weekDelta >= 0
      ? Math.floor(weekDelta / weeksPerSlot)
      : -Math.ceil(-weekDelta / weeksPerSlot);
  const offset =
    ((effectiveAnchorIndex + slotsAdvanced) % activeMembers.length +
      activeMembers.length) %
    activeMembers.length;
  return {
    member: activeMembers[offset] ?? null,
    source: "auto",
    appliedOverride: null,
  };
}
