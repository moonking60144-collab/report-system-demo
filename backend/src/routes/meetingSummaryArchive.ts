import { restyleMeetingMinutesHtml } from "../services/meeting-minutes/meetingMinutesDocumentStyles";
import { Router } from "express";
import type { MeetingSummaryArchiveRepository } from "../storage/meeting-minutes/meetingSummaryArchiveRepository";
import { HttpError } from "../utils/httpError";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";

export function createMeetingSummaryArchiveRouter(
  repository: MeetingSummaryArchiveRepository,
  verifyAdminToken: (authorization: string | undefined) => unknown = verifySystemNoticeBearerToken,
  admissionState?: () => Promise<{ available: boolean; reason: string | null }>
): Router {
  const router = Router();
  router.use("/meetings/admin/summaries", (req, res, next) => {
    try {
      verifyAdminToken(req.header("authorization"));
      res.setHeader("Cache-Control", "no-store");
      next();
    } catch (error) { next(error); }
  });
  router.get("/meetings/admin/summaries", async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (query.length > 200 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new HttpError(400, "摘要查詢條件不合法。", "MEETING_SUMMARY_QUERY_INVALID");
      }
      const [items, stats] = await Promise.all([repository.list(50, offset, query), repository.stats()]);
      res.json({ data: { items, stats, admission: admissionState ? await admissionState() : null } });
    } catch (error) { next(error); }
  });
  router.get("/meetings/admin/summaries/:sessionId/html", async (req, res, next) => {
    try {
      const item = await repository.get(req.params.sessionId);
      if (!item) throw new HttpError(404, "找不到會議摘要。", "MEETING_SUMMARY_NOT_FOUND");
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="meeting-summary.html"`);
      res.type("html").send(restyleMeetingMinutesHtml(item.html));
    } catch (error) { next(error); }
  });
  return router;
}
