import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { readTaskActorContext } from "./taskActorContext";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import { itSopDocumentService } from "../services/itSopDocumentService";

const itSopRouter = Router();

itSopRouter.get(
  "/it/sop-documents/:documentId",
  asyncHandler(async (req, res) => {
    verifySystemNoticeBearerToken(req.header("authorization"));
    const document = await itSopDocumentService.getDocument(req.params.documentId);
    res.json({ data: document });
  })
);

itSopRouter.put(
  "/it/sop-documents/:documentId",
  asyncHandler(async (req, res) => {
    const auth = verifySystemNoticeBearerToken(req.header("authorization"));
    const actor = readTaskActorContext(req);
    const document = await itSopDocumentService.saveDocument(
      req.params.documentId,
      req.body,
      actor.actorLabel ?? auth.username
    );
    res.json({ data: document });
  })
);

export default itSopRouter;
