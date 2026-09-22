export interface ItDutyMember {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItDutyOverride {
  isoWeek: string;
  memberId: number;
  note: string | null;
  /**
   * true：之後所有週都從這筆 override 重新照順序排（cascading anchor）
   * false：只改這週、未來週仍照原本的 anchor 順序（單週修補）
   */
  propagateForward: boolean;
  updatedAt: string;
  updatedByLabel: string | null;
}

export interface ItDutySetting {
  weeksPerSlot: number;
  /**
   * Rotation 演算法的「初始錨點」。第一次有 active member 時 seed、之後固定。
   * 跟 override 表分開：override 是事件流（某週臨時換誰），anchor 是初始條件
   * （演算法起點）。member 被刪除/停用導致 anchor_member_id 失效時會被
   * refill 成最早 active member、anchor_iso_week 保持不變。
   *
   * 完全沒 active member 時兩者都會是 null。
   */
  anchorIsoWeek: string | null;
  anchorMemberId: number | null;
  updatedAt: string;
}

export type ItDutyDaySwapReason = "leave" | "repay";

export interface ItDutyDaySwap {
  id: number;
  coverDate: string; // YYYY-MM-DD
  originalMemberId: number;
  coverMemberId: number;
  reason: ItDutyDaySwapReason;
  pairedSwapId: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 兩人之間還沒清算的「請假代班」筆數摘要 */
export interface ItDutyDebtEntry {
  debtorMemberId: number; // 欠人天數的（leave 那筆的原值班 = 請假者）
  creditorMemberId: number; // 被欠的（leave 那筆的代班）
  unsettledDays: number;
}

/**
 * 純日備註 — 跟代班 / 債務無關，純文字提示某天有事。
 * 一天一筆（DB UNIQUE(note_date)）。
 */
export interface ItDutyDayNote {
  id: number;
  noteDate: string; // YYYY-MM-DD
  note: string;
  updatedByLabel: string | null;
  createdAt: string;
  updatedAt: string;
}
