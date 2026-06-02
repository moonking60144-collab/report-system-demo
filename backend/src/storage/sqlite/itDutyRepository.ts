import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";
import type {
  ItDutyDaySwap,
  ItDutyDaySwapReason,
  ItDutyDebtEntry,
  ItDutyMember,
  ItDutyOverride,
  ItDutySetting,
} from "../../types/itDuty";

interface ItDutyMemberRow {
  id: number;
  name: string;
  sort_order: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface ItDutyOverrideRow {
  iso_week: string;
  member_id: number;
  note: string | null;
  propagate_forward: number;
  updated_at: string;
  updated_by_label: string | null;
}

interface ItDutySettingRow {
  weeks_per_slot: number;
  updated_at: string;
}

interface ItDutyDaySwapRow {
  id: number;
  cover_date: string;
  original_member_id: number;
  cover_member_id: number;
  reason: string;
  paired_swap_id: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const MIN_WEEKS_PER_SLOT = 1;
const MAX_WEEKS_PER_SLOT = 52;

function mapMember(row: ItDutyMemberRow): ItDutyMember {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOverride(row: ItDutyOverrideRow): ItDutyOverride {
  return {
    isoWeek: row.iso_week,
    memberId: row.member_id,
    note: row.note,
    propagateForward: row.propagate_forward !== 0,
    updatedAt: row.updated_at,
    updatedByLabel: row.updated_by_label,
  };
}

function mapDaySwap(row: ItDutyDaySwapRow): ItDutyDaySwap {
  const reason: ItDutyDaySwapReason =
    row.reason === "repay" ? "repay" : "leave";
  return {
    id: row.id,
    coverDate: row.cover_date,
    originalMemberId: row.original_member_id,
    coverMemberId: row.cover_member_id,
    reason,
    pairedSwapId: row.paired_swap_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSetting(row: ItDutySettingRow): ItDutySetting {
  const weeks =
    typeof row.weeks_per_slot === "number" && Number.isFinite(row.weeks_per_slot)
      ? Math.trunc(row.weeks_per_slot)
      : 1;
  return {
    weeksPerSlot: Math.min(Math.max(weeks, MIN_WEEKS_PER_SLOT), MAX_WEEKS_PER_SLOT),
    updatedAt: row.updated_at,
  };
}

export interface ItDutyRepository {
  listMembers(): Promise<ItDutyMember[]>;
  getMember(id: number): Promise<ItDutyMember | null>;
  insertMember(input: {
    name: string;
    sortOrder?: number;
    active?: boolean;
  }): Promise<ItDutyMember>;
  updateMember(
    id: number,
    patch: { name?: string; active?: boolean }
  ): Promise<ItDutyMember | null>;
  deleteMember(id: number): Promise<boolean>;
  reorderMembers(orderedIds: number[]): Promise<ItDutyMember[]>;
  listOverridesInRange(
    fromIsoWeek: string,
    toIsoWeek: string
  ): Promise<ItDutyOverride[]>;
  listAllOverrides(): Promise<ItDutyOverride[]>;
  getMostRecentOverride(
    beforeOrEqualIsoWeek: string
  ): Promise<ItDutyOverride | null>;
  upsertOverride(input: {
    isoWeek: string;
    memberId: number;
    note?: string | null;
    propagateForward?: boolean;
    updatedByLabel?: string | null;
  }): Promise<ItDutyOverride>;
  deleteOverride(isoWeek: string): Promise<boolean>;
  getSetting(): Promise<ItDutySetting>;
  updateSetting(input: { weeksPerSlot: number }): Promise<ItDutySetting>;

  // === 日級代班 ===
  listSwapsInRange(fromDate: string, toDate: string): Promise<ItDutyDaySwap[]>;
  listAllSwaps(): Promise<ItDutyDaySwap[]>;
  getSwapById(id: number): Promise<ItDutyDaySwap | null>;
  /**
   * 建立 leave swap：A 請假該天，B 代班
   * 同一天若已有 swap 會 throw（DB UNIQUE 限制）
   */
  createLeaveSwap(input: {
    coverDate: string;
    originalMemberId: number;
    coverMemberId: number;
    note?: string | null;
  }): Promise<ItDutyDaySwap>;
  /**
   * 建立 repay swap 並自動跟某筆 leave 配對清算
   * - repay 的 originalMember = leave 的 coverMember (B)
   * - repay 的 coverMember = leave 的 originalMember (A)
   * - 雙向 link paired_swap_id
   */
  createRepaySwap(input: {
    coverDate: string;
    pairLeaveSwapId: number;
    note?: string | null;
  }): Promise<{ leave: ItDutyDaySwap; repay: ItDutyDaySwap }>;
  /**
   * 刪除一筆 swap；若它有配對，配對方的 paired_swap_id 會被 ON DELETE SET NULL 清掉
   */
  deleteSwap(id: number): Promise<boolean>;
  /** 計算各對成員之間「未清算」的 leave 天數（debtor 欠 creditor 多少天） */
  listDebts(): Promise<ItDutyDebtEntry[]>;
}

export function createItDutyRepository(
  getDb: () => Promise<Database>
): ItDutyRepository {
  let writeChain: Promise<void> = Promise.resolve();

  async function runSerializedWrite<T>(
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const scheduled = writeChain
      .catch(() => {
        // 避免前一次失敗讓後續寫入鏈卡死
      })
      .then(async () => operation(await getDb()));

    writeChain = scheduled.then(
      () => undefined,
      () => undefined
    );

    return scheduled;
  }

  return {
    async listMembers() {
      const db = await getDb();
      const rows = await db.all<ItDutyMemberRow[]>(
        `
        SELECT id, name, sort_order, active, created_at, updated_at
        FROM it_duty_member
        ORDER BY sort_order ASC, id ASC
        `
      );
      return rows.map(mapMember);
    },

    async getMember(id) {
      const db = await getDb();
      const row = await db.get<ItDutyMemberRow>(
        `
        SELECT id, name, sort_order, active, created_at, updated_at
        FROM it_duty_member
        WHERE id = ?
        `,
        id
      );
      return row ? mapMember(row) : null;
    },

    async insertMember(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        let sortOrder = input.sortOrder;
        if (sortOrder === undefined) {
          const maxRow = await db.get<{ max_order: number | null }>(
            "SELECT MAX(sort_order) AS max_order FROM it_duty_member"
          );
          sortOrder =
            typeof maxRow?.max_order === "number" && Number.isFinite(maxRow.max_order)
              ? maxRow.max_order + 1
              : 0;
        }
        const result = await db.run(
          `
          INSERT INTO it_duty_member (name, sort_order, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          `,
          input.name,
          sortOrder,
          input.active === false ? 0 : 1,
          now,
          now
        );
        const id = result.lastID;
        if (typeof id !== "number") {
          throw new Error("Failed to insert it_duty_member: missing lastID");
        }
        const row = await db.get<ItDutyMemberRow>(
          `
          SELECT id, name, sort_order, active, created_at, updated_at
          FROM it_duty_member
          WHERE id = ?
          `,
          id
        );
        if (!row) {
          throw new Error(`Failed to load inserted it_duty_member id=${id}`);
        }
        return mapMember(row);
      });
    },

    async updateMember(id, patch) {
      return runSerializedWrite(async (db) => {
        const existing = await db.get<ItDutyMemberRow>(
          `
          SELECT id, name, sort_order, active, created_at, updated_at
          FROM it_duty_member
          WHERE id = ?
          `,
          id
        );
        if (!existing) {
          return null;
        }
        const nextName = patch.name !== undefined ? patch.name : existing.name;
        const nextActive =
          patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active;
        const now = new Date().toISOString();
        await db.run(
          `
          UPDATE it_duty_member
          SET name = ?, active = ?, updated_at = ?
          WHERE id = ?
          `,
          nextName,
          nextActive,
          now,
          id
        );
        const row = await db.get<ItDutyMemberRow>(
          `
          SELECT id, name, sort_order, active, created_at, updated_at
          FROM it_duty_member
          WHERE id = ?
          `,
          id
        );
        return row ? mapMember(row) : null;
      });
    },

    async deleteMember(id) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          "DELETE FROM it_duty_member WHERE id = ?",
          id
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async reorderMembers(orderedIds) {
      return runSerializedWrite(async (db) => {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const now = new Date().toISOString();
          for (let i = 0; i < orderedIds.length; i += 1) {
            await db.run(
              `
              UPDATE it_duty_member
              SET sort_order = ?, updated_at = ?
              WHERE id = ?
              `,
              i,
              now,
              orderedIds[i]
            );
          }
          await db.exec("COMMIT");
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
        const rows = await db.all<ItDutyMemberRow[]>(
          `
          SELECT id, name, sort_order, active, created_at, updated_at
          FROM it_duty_member
          ORDER BY sort_order ASC, id ASC
          `
        );
        return rows.map(mapMember);
      });
    },

    async listOverridesInRange(fromIsoWeek, toIsoWeek) {
      const db = await getDb();
      const rows = await db.all<ItDutyOverrideRow[]>(
        `
        SELECT iso_week, member_id, note, propagate_forward, updated_at, updated_by_label
        FROM it_duty_assignment_override
        WHERE iso_week >= ? AND iso_week <= ?
        ORDER BY iso_week ASC
        `,
        fromIsoWeek,
        toIsoWeek
      );
      return rows.map(mapOverride);
    },

    async listAllOverrides() {
      const db = await getDb();
      const rows = await db.all<ItDutyOverrideRow[]>(
        `
        SELECT iso_week, member_id, note, propagate_forward, updated_at, updated_by_label
        FROM it_duty_assignment_override
        ORDER BY iso_week ASC
        `
      );
      return rows.map(mapOverride);
    },

    async getMostRecentOverride(beforeOrEqualIsoWeek) {
      const db = await getDb();
      const row = await db.get<ItDutyOverrideRow>(
        `
        SELECT iso_week, member_id, note, propagate_forward, updated_at, updated_by_label
        FROM it_duty_assignment_override
        WHERE iso_week <= ?
        ORDER BY iso_week DESC
        LIMIT 1
        `,
        beforeOrEqualIsoWeek
      );
      return row ? mapOverride(row) : null;
    },

    async upsertOverride(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        const propagateForward = input.propagateForward !== false ? 1 : 0;
        await db.run(
          `
          INSERT INTO it_duty_assignment_override (
            iso_week, member_id, note, propagate_forward, updated_at, updated_by_label
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(iso_week)
          DO UPDATE SET
            member_id = excluded.member_id,
            note = excluded.note,
            propagate_forward = excluded.propagate_forward,
            updated_at = excluded.updated_at,
            updated_by_label = excluded.updated_by_label
          `,
          input.isoWeek,
          input.memberId,
          input.note ?? null,
          propagateForward,
          now,
          input.updatedByLabel ?? null
        );
        const row = await db.get<ItDutyOverrideRow>(
          `
          SELECT iso_week, member_id, note, propagate_forward, updated_at, updated_by_label
          FROM it_duty_assignment_override
          WHERE iso_week = ?
          `,
          input.isoWeek
        );
        if (!row) {
          throw new Error(
            `Failed to load upserted override iso_week=${input.isoWeek}`
          );
        }
        return mapOverride(row);
      });
    },

    async deleteOverride(isoWeek) {
      return runSerializedWrite(async (db) => {
        const result = await db.run(
          "DELETE FROM it_duty_assignment_override WHERE iso_week = ?",
          isoWeek
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async getSetting() {
      const db = await getDb();
      const row = await db.get<ItDutySettingRow>(
        "SELECT weeks_per_slot, updated_at FROM it_duty_setting WHERE id = 1"
      );
      if (!row) {
        // schema 啟動時就 INSERT OR IGNORE 一筆，理論上不該發生；fallback 預設值
        return { weeksPerSlot: 1, updatedAt: "1970-01-01T00:00:00.000Z" };
      }
      return mapSetting(row);
    },

    async updateSetting(input) {
      return runSerializedWrite(async (db) => {
        const clamped = Math.min(
          Math.max(Math.trunc(input.weeksPerSlot), MIN_WEEKS_PER_SLOT),
          MAX_WEEKS_PER_SLOT
        );
        const now = new Date().toISOString();
        await db.run(
          `
          INSERT INTO it_duty_setting (id, weeks_per_slot, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id)
          DO UPDATE SET
            weeks_per_slot = excluded.weeks_per_slot,
            updated_at = excluded.updated_at
          `,
          clamped,
          now
        );
        const row = await db.get<ItDutySettingRow>(
          "SELECT weeks_per_slot, updated_at FROM it_duty_setting WHERE id = 1"
        );
        if (!row) {
          throw new Error("Failed to load it_duty_setting after upsert");
        }
        return mapSetting(row);
      });
    },

    async listSwapsInRange(fromDate, toDate) {
      const db = await getDb();
      const rows = await db.all<ItDutyDaySwapRow[]>(
        `
        SELECT id, cover_date, original_member_id, cover_member_id,
               reason, paired_swap_id, note, created_at, updated_at
        FROM it_duty_day_swap
        WHERE cover_date >= ? AND cover_date <= ?
        ORDER BY cover_date ASC
        `,
        fromDate,
        toDate
      );
      return rows.map(mapDaySwap);
    },

    async listAllSwaps() {
      const db = await getDb();
      const rows = await db.all<ItDutyDaySwapRow[]>(
        `
        SELECT id, cover_date, original_member_id, cover_member_id,
               reason, paired_swap_id, note, created_at, updated_at
        FROM it_duty_day_swap
        ORDER BY cover_date ASC
        `
      );
      return rows.map(mapDaySwap);
    },

    async getSwapById(id) {
      const db = await getDb();
      const row = await db.get<ItDutyDaySwapRow>(
        `
        SELECT id, cover_date, original_member_id, cover_member_id,
               reason, paired_swap_id, note, created_at, updated_at
        FROM it_duty_day_swap
        WHERE id = ?
        `,
        id
      );
      return row ? mapDaySwap(row) : null;
    },

    async createLeaveSwap(input) {
      if (!DATE_REGEX.test(input.coverDate)) {
        throw new Error(`Invalid coverDate: ${input.coverDate}`);
      }
      if (input.originalMemberId === input.coverMemberId) {
        throw new Error("originalMember 與 coverMember 不能相同");
      }
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        const result = await db.run(
          `
          INSERT INTO it_duty_day_swap (
            cover_date, original_member_id, cover_member_id, reason,
            paired_swap_id, note, created_at, updated_at
          ) VALUES (?, ?, ?, 'leave', NULL, ?, ?, ?)
          `,
          input.coverDate,
          input.originalMemberId,
          input.coverMemberId,
          input.note ?? null,
          now,
          now
        );
        const id = result.lastID;
        if (typeof id !== "number") {
          throw new Error("Failed to insert it_duty_day_swap");
        }
        const row = await db.get<ItDutyDaySwapRow>(
          `
          SELECT id, cover_date, original_member_id, cover_member_id,
                 reason, paired_swap_id, note, created_at, updated_at
          FROM it_duty_day_swap WHERE id = ?
          `,
          id
        );
        if (!row) throw new Error(`Failed to load swap id=${id}`);
        return mapDaySwap(row);
      });
    },

    async createRepaySwap(input) {
      if (!DATE_REGEX.test(input.coverDate)) {
        throw new Error(`Invalid coverDate: ${input.coverDate}`);
      }
      return runSerializedWrite(async (db) => {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          // 1) 找目標 leave swap，必須 reason='leave' 且未配對
          const leaveRow = await db.get<ItDutyDaySwapRow>(
            `
            SELECT id, cover_date, original_member_id, cover_member_id,
                   reason, paired_swap_id, note, created_at, updated_at
            FROM it_duty_day_swap
            WHERE id = ? AND reason = 'leave' AND paired_swap_id IS NULL
            `,
            input.pairLeaveSwapId
          );
          if (!leaveRow) {
            throw new Error(
              `Target leave swap not found or already paired: id=${input.pairLeaveSwapId}`
            );
          }
          // 2) 建 repay swap：原值班 = leave 的代班 (B)、代班 = leave 的原值班 (A)
          const now = new Date().toISOString();
          const result = await db.run(
            `
            INSERT INTO it_duty_day_swap (
              cover_date, original_member_id, cover_member_id, reason,
              paired_swap_id, note, created_at, updated_at
            ) VALUES (?, ?, ?, 'repay', ?, ?, ?, ?)
            `,
            input.coverDate,
            leaveRow.cover_member_id,
            leaveRow.original_member_id,
            leaveRow.id,
            input.note ?? null,
            now,
            now
          );
          const repayId = result.lastID;
          if (typeof repayId !== "number") {
            throw new Error("Failed to insert repay swap");
          }
          // 3) 雙向 link
          await db.run(
            `UPDATE it_duty_day_swap SET paired_swap_id = ? WHERE id = ?`,
            repayId,
            leaveRow.id
          );
          const updatedLeave = await db.get<ItDutyDaySwapRow>(
            `
            SELECT id, cover_date, original_member_id, cover_member_id,
                   reason, paired_swap_id, note, created_at, updated_at
            FROM it_duty_day_swap WHERE id = ?
            `,
            leaveRow.id
          );
          const newRepay = await db.get<ItDutyDaySwapRow>(
            `
            SELECT id, cover_date, original_member_id, cover_member_id,
                   reason, paired_swap_id, note, created_at, updated_at
            FROM it_duty_day_swap WHERE id = ?
            `,
            repayId
          );
          if (!updatedLeave || !newRepay) {
            throw new Error("Failed to reload swap rows after pairing");
          }
          await db.exec("COMMIT");
          return {
            leave: mapDaySwap(updatedLeave),
            repay: mapDaySwap(newRepay),
          };
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
      });
    },

    async deleteSwap(id) {
      // 刪除一筆 swap 時，若有配對，連配對方一起刪 — 避免變成 orphan repay
      // (例如刪 leave 留 repay → B 突然「被代班」沒任何 leave 對應，邏輯上沒意義)
      return runSerializedWrite(async (db) => {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const swap = await db.get<{ id: number; paired_swap_id: number | null }>(
            "SELECT id, paired_swap_id FROM it_duty_day_swap WHERE id = ?",
            id
          );
          if (!swap) {
            await db.exec("COMMIT");
            return false;
          }
          if (swap.paired_swap_id) {
            await db.run(
              "DELETE FROM it_duty_day_swap WHERE id = ?",
              swap.paired_swap_id
            );
          }
          await db.run("DELETE FROM it_duty_day_swap WHERE id = ?", id);
          await db.exec("COMMIT");
          return true;
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
      });
    },

    async listDebts() {
      const db = await getDb();
      // 未配對的 leave 才算未清算
      const rows = await db.all<
        Array<{ original_member_id: number; cover_member_id: number; cnt: number }>
      >(
        `
        SELECT original_member_id, cover_member_id, COUNT(*) AS cnt
        FROM it_duty_day_swap
        WHERE reason = 'leave' AND paired_swap_id IS NULL
        GROUP BY original_member_id, cover_member_id
        ORDER BY cnt DESC
        `
      );
      return rows.map((r) => ({
        debtorMemberId: r.original_member_id,
        creditorMemberId: r.cover_member_id,
        unsettledDays: r.cnt,
      }));
    },
  };
}

export const itDutyRepository: ItDutyRepository = createItDutyRepository(() =>
  sqliteClient.getDb()
);
