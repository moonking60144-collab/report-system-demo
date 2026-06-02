import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";
import { readTaskActorContext } from "./taskActorContext";
import {
  itDutyRepository,
  type ItDutyRepository,
} from "../storage/sqlite/itDutyRepository";

const ISO_WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;

function readPositiveInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${fieldName} 必須為正整數`, "INVALID_PAYLOAD");
  }
  return parsed;
}

function readRequiredName(body: Record<string, unknown>): string {
  const raw = body.name;
  if (typeof raw !== "string") {
    throw new HttpError(400, "缺少必要欄位：name", "INVALID_PAYLOAD");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(400, "name 不可為空", "INVALID_PAYLOAD");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new HttpError(
      400,
      `name 長度不可超過 ${MAX_NAME_LENGTH}`,
      "INVALID_PAYLOAD"
    );
  }
  return trimmed;
}

function readOptionalName(body: Record<string, unknown>): string | undefined {
  const raw = body.name;
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new HttpError(400, "name 必須為字串", "INVALID_PAYLOAD");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HttpError(400, "name 不可為空", "INVALID_PAYLOAD");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new HttpError(
      400,
      `name 長度不可超過 ${MAX_NAME_LENGTH}`,
      "INVALID_PAYLOAD"
    );
  }
  return trimmed;
}

function readOptionalActive(body: Record<string, unknown>): boolean | undefined {
  if (!("active" in body)) {
    return undefined;
  }
  const raw = body.active;
  if (typeof raw === "boolean") {
    return raw;
  }
  throw new HttpError(400, "active 必須為布林值", "INVALID_PAYLOAD");
}

function readOptionalNote(body: Record<string, unknown>): string | null {
  const raw = body.note;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new HttpError(400, "note 必須為字串", "INVALID_PAYLOAD");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new HttpError(
      400,
      `note 長度不可超過 ${MAX_NOTE_LENGTH}`,
      "INVALID_PAYLOAD"
    );
  }
  return trimmed;
}

function readIsoWeekParam(value: unknown, fieldName: string): string {
  const trimmed = String(value ?? "").trim();
  if (!ISO_WEEK_REGEX.test(trimmed)) {
    throw new HttpError(
      400,
      `${fieldName} 格式錯誤，需為 YYYY-Www（例如 2026-W18）`,
      "INVALID_PAYLOAD"
    );
  }
  return trimmed;
}

function readDateParam(value: unknown, fieldName: string): string {
  const trimmed = String(value ?? "").trim();
  if (!DATE_REGEX.test(trimmed)) {
    throw new HttpError(
      400,
      `${fieldName} 格式錯誤，需為 YYYY-MM-DD`,
      "INVALID_PAYLOAD"
    );
  }
  // 驗證真的是合法日期（避免 2026-02-30 這種）
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== trimmed) {
    throw new HttpError(
      400,
      `${fieldName} 不是合法的日期：${trimmed}`,
      "INVALID_PAYLOAD"
    );
  }
  return trimmed;
}

export function createItDutyRouter(repository: ItDutyRepository): Router {
  const router = Router();

  router.get(
    "/it/duty/members",
    asyncHandler(async (_req, res) => {
      const data = await repository.listMembers();
      res.json({ data });
    })
  );

  router.post(
    "/it/duty/members",
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = readRequiredName(body);
      const active = readOptionalActive(body) ?? true;
      const member = await repository.insertMember({ name, active });
      res.status(201).json({ data: member });
    })
  );

  router.patch(
    "/it/duty/members/:id",
    asyncHandler(async (req, res) => {
      const id = readPositiveInteger(req.params.id, "id");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = readOptionalName(body);
      const active = readOptionalActive(body);
      if (name === undefined && active === undefined) {
        throw new HttpError(
          400,
          "至少需提供 name 或 active 其中一個欄位",
          "INVALID_PAYLOAD"
        );
      }
      const patch: { name?: string; active?: boolean } = {};
      if (name !== undefined) {
        patch.name = name;
      }
      if (active !== undefined) {
        patch.active = active;
      }
      const member = await repository.updateMember(id, patch);
      if (!member) {
        throw new HttpError(404, `找不到值班人員 id=${id}`, "MEMBER_NOT_FOUND");
      }
      res.json({ data: member });
    })
  );

  router.delete(
    "/it/duty/members/:id",
    asyncHandler(async (req, res) => {
      const id = readPositiveInteger(req.params.id, "id");
      const ok = await repository.deleteMember(id);
      if (!ok) {
        throw new HttpError(404, `找不到值班人員 id=${id}`, "MEMBER_NOT_FOUND");
      }
      res.json({ data: { ok: true } });
    })
  );

  router.put(
    "/it/duty/members/order",
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body.orderedIds;
      if (!Array.isArray(raw)) {
        throw new HttpError(400, "orderedIds 必須為陣列", "INVALID_PAYLOAD");
      }
      if (raw.length === 0) {
        throw new HttpError(400, "orderedIds 不可為空", "INVALID_PAYLOAD");
      }
      const orderedIds: number[] = [];
      const seen = new Set<number>();
      for (const value of raw) {
        const id = readPositiveInteger(value, "orderedIds[i]");
        if (seen.has(id)) {
          throw new HttpError(400, "orderedIds 內容不可重複", "INVALID_PAYLOAD");
        }
        seen.add(id);
        orderedIds.push(id);
      }
      const data = await repository.reorderMembers(orderedIds);
      res.json({ data });
    })
  );

  router.get(
    "/it/duty/overrides",
    asyncHandler(async (req, res) => {
      const fromRaw = String(req.query.from ?? "").trim();
      const toRaw = String(req.query.to ?? "").trim();
      if (!fromRaw && !toRaw) {
        const data = await repository.listAllOverrides();
        res.json({ data });
        return;
      }
      const from = readIsoWeekParam(fromRaw, "from");
      const to = readIsoWeekParam(toRaw, "to");
      if (from > to) {
        throw new HttpError(400, "from 不可大於 to", "INVALID_PAYLOAD");
      }
      const data = await repository.listOverridesInRange(from, to);
      res.json({ data });
    })
  );

  router.put(
    "/it/duty/overrides/:isoWeek",
    asyncHandler(async (req, res) => {
      const isoWeek = readIsoWeekParam(req.params.isoWeek, "isoWeek");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const memberId = readPositiveInteger(body.memberId, "memberId");
      const member = await repository.getMember(memberId);
      if (!member) {
        throw new HttpError(404, `找不到值班人員 id=${memberId}`, "MEMBER_NOT_FOUND");
      }
      const note = readOptionalNote(body);
      let propagateForward: boolean | undefined;
      if ("propagateForward" in body) {
        const raw = body.propagateForward;
        if (typeof raw !== "boolean") {
          throw new HttpError(
            400,
            "propagateForward 必須為布林值",
            "INVALID_PAYLOAD"
          );
        }
        propagateForward = raw;
      }
      const actor = readTaskActorContext(req);
      const override = await repository.upsertOverride({
        isoWeek,
        memberId,
        note,
        ...(propagateForward !== undefined ? { propagateForward } : {}),
        updatedByLabel: actor.actorLabel,
      });
      res.json({ data: override });
    })
  );

  router.delete(
    "/it/duty/overrides/:isoWeek",
    asyncHandler(async (req, res) => {
      const isoWeek = readIsoWeekParam(req.params.isoWeek, "isoWeek");
      const ok = await repository.deleteOverride(isoWeek);
      if (!ok) {
        throw new HttpError(404, `找不到 override iso_week=${isoWeek}`, "OVERRIDE_NOT_FOUND");
      }
      res.json({ data: { ok: true } });
    })
  );

  router.get(
    "/it/duty/settings",
    asyncHandler(async (_req, res) => {
      const data = await repository.getSetting();
      res.json({ data });
    })
  );

  router.put(
    "/it/duty/settings",
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = body.weeksPerSlot;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 52) {
        throw new HttpError(
          400,
          "weeksPerSlot 必須為 1~52 的整數",
          "INVALID_PAYLOAD"
        );
      }
      const data = await repository.updateSetting({ weeksPerSlot: parsed });
      res.json({ data });
    })
  );

  // === 日級代班 ===

  router.get(
    "/it/duty/swaps",
    asyncHandler(async (req, res) => {
      const fromRaw = String(req.query.from ?? "").trim();
      const toRaw = String(req.query.to ?? "").trim();
      if (!fromRaw && !toRaw) {
        const data = await repository.listAllSwaps();
        res.json({ data });
        return;
      }
      const from = readDateParam(fromRaw, "from");
      const to = readDateParam(toRaw, "to");
      if (from > to) {
        throw new HttpError(400, "from 不可大於 to", "INVALID_PAYLOAD");
      }
      const data = await repository.listSwapsInRange(from, to);
      res.json({ data });
    })
  );

  router.post(
    "/it/duty/swaps/leave",
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const coverDate = readDateParam(body.coverDate, "coverDate");
      const originalMemberId = readPositiveInteger(
        body.originalMemberId,
        "originalMemberId"
      );
      const coverMemberId = readPositiveInteger(
        body.coverMemberId,
        "coverMemberId"
      );
      if (originalMemberId === coverMemberId) {
        throw new HttpError(
          400,
          "originalMemberId 與 coverMemberId 不可相同",
          "INVALID_PAYLOAD"
        );
      }
      const original = await repository.getMember(originalMemberId);
      if (!original) {
        throw new HttpError(
          404,
          `找不到值班人員 id=${originalMemberId}`,
          "MEMBER_NOT_FOUND"
        );
      }
      const cover = await repository.getMember(coverMemberId);
      if (!cover) {
        throw new HttpError(
          404,
          `找不到值班人員 id=${coverMemberId}`,
          "MEMBER_NOT_FOUND"
        );
      }
      const note = readOptionalNote(body);
      try {
        const data = await repository.createLeaveSwap({
          coverDate,
          originalMemberId,
          coverMemberId,
          note,
        });
        res.status(201).json({ data });
      } catch (error) {
        // UNIQUE constraint fail → 同一天已有 swap
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("UNIQUE") ||
          message.includes("constraint") ||
          message.includes("already")
        ) {
          throw new HttpError(
            409,
            `${coverDate} 該天已有代班紀錄`,
            "SWAP_DATE_CONFLICT"
          );
        }
        throw error;
      }
    })
  );

  router.post(
    "/it/duty/swaps/repay",
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const coverDate = readDateParam(body.coverDate, "coverDate");
      const pairLeaveSwapId = readPositiveInteger(
        body.pairLeaveSwapId,
        "pairLeaveSwapId"
      );
      const note = readOptionalNote(body);
      try {
        const data = await repository.createRepaySwap({
          coverDate,
          pairLeaveSwapId,
          note,
        });
        res.status(201).json({ data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Target leave swap not found")) {
          throw new HttpError(
            404,
            `找不到可清算的請假紀錄 id=${pairLeaveSwapId}`,
            "LEAVE_SWAP_NOT_FOUND"
          );
        }
        if (
          message.includes("UNIQUE") ||
          message.includes("constraint")
        ) {
          throw new HttpError(
            409,
            `${coverDate} 該天已有代班紀錄`,
            "SWAP_DATE_CONFLICT"
          );
        }
        throw error;
      }
    })
  );

  router.delete(
    "/it/duty/swaps/:id",
    asyncHandler(async (req, res) => {
      const id = readPositiveInteger(req.params.id, "id");
      const ok = await repository.deleteSwap(id);
      if (!ok) {
        throw new HttpError(404, `找不到代班紀錄 id=${id}`, "SWAP_NOT_FOUND");
      }
      res.json({ data: { ok: true } });
    })
  );

  router.get(
    "/it/duty/debts",
    asyncHandler(async (_req, res) => {
      const data = await repository.listDebts();
      res.json({ data });
    })
  );

  return router;
}

const itDutyRouter = createItDutyRouter(itDutyRepository);
export default itDutyRouter;
