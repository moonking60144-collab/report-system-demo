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
