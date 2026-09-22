import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import { ragicDefinitionsReadService } from "../services/dev/ragicDefinitionsReadService";
import { isRagicDefinitionsRevision } from "../services/dev/ragicDefinitionsSnapshotService";
import type {
  RagicDefinitionsSnapshotDescriptor,
  RagicDefinitionsSnapshotHistoryItem,
} from "@shared-types/ragicDefinitions";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";

const log = createLogger("ragic-definitions-source");
const SOURCE_CONTRACT = "ragic-definitions-source-v1";
const TOKEN_MIN_LENGTH = 32;

export interface RagicDefinitionsSourceRouterOptions {
  service?: {
    getSnapshotDescriptor: typeof ragicDefinitionsReadService.getSnapshotDescriptor;
    listSnapshots: typeof ragicDefinitionsReadService.listSnapshots;
    getSnapshotHistoryDescriptor: typeof ragicDefinitionsReadService.getSnapshotHistoryDescriptor;
    loadCurrentSnapshot: typeof ragicDefinitionsReadService.loadCurrentSnapshot;
    loadSnapshot: typeof ragicDefinitionsReadService.loadSnapshot;
  };
  sourceToken?: string;
}

function bearerToken(authorizationHeader: string | undefined): string {
  const raw = String(authorizationHeader ?? "").trim();
  if (!raw) {
    throw new HttpError(
      401,
      "缺少 Ragic Definitions Source API token",
      "RAGIC_DEFINITIONS_SOURCE_TOKEN_MISSING"
    );
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  const token = match?.[1]?.trim() ?? "";
  if (!token) {
    throw new HttpError(
      401,
      "授權格式錯誤，需使用 Bearer token",
      "RAGIC_DEFINITIONS_SOURCE_TOKEN_INVALID"
    );
  }
  return token;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf-8").digest();
}

function assertSourceToken(
  authorizationHeader: string | undefined,
  configuredToken: string
): void {
  if (configuredToken.length < TOKEN_MIN_LENGTH) {
    throw new HttpError(
      503,
      "Ragic Definitions Source API 尚未啟用",
      "RAGIC_DEFINITIONS_SOURCE_API_DISABLED"
    );
  }
  const provided = bearerToken(authorizationHeader);
  if (!timingSafeEqual(tokenDigest(provided), tokenDigest(configuredToken))) {
    throw new HttpError(
      401,
      "Ragic Definitions Source API token 無效",
      "RAGIC_DEFINITIONS_SOURCE_TOKEN_INVALID"
    );
  }
}

function normalizedRevision(raw: string): string {
  const value = raw.trim().toLowerCase();
  const revision = /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : value;
  if (!isRagicDefinitionsRevision(revision)) {
    throw new HttpError(
      400,
      "revision 必須是 sha256:<64 hex> 或 64 hex",
      "RAGIC_DEFINITIONS_REVISION_INVALID"
    );
  }
  return revision;
}

function revisionEtag(revision: string): string {
  return `W/"${revision.replace(":", "-")}"`;
}

function requestMatchesEtag(req: Request, etag: string): boolean {
  const raw = String(req.header("if-none-match") ?? "").trim();
  if (!raw) return false;
  const expected = etag.replace(/^W\//, "");
  return raw
    .split(",")
    .map((item) => item.trim())
    .some(
      (item) =>
        item === "*" ||
        item === etag ||
        item.replace(/^W\//, "") === expected
    );
}

function selectSnapshotEncoding(req: Request): "gzip" | "identity" {
  const selected = req.acceptsEncodings("gzip", "identity");
  if (selected === "gzip" || selected === "identity") return selected;
  throw new HttpError(
    406,
    "不支援要求的 snapshot content encoding",
    "RAGIC_DEFINITIONS_ENCODING_NOT_ACCEPTABLE"
  );
}

type SnapshotHeaderDescriptor = RagicDefinitionsSnapshotDescriptor &
  Partial<
    Pick<
      RagicDefinitionsSnapshotHistoryItem,
      "materializedAt" | "payloadSha256" | "compressedBytes"
    >
  >;

function setSnapshotHeaders(
  res: Response,
  descriptor: SnapshotHeaderDescriptor,
  encoding: "gzip" | "identity",
  compressedBytes?: number
): void {
  const etag = revisionEtag(descriptor.revision);
  const revisionHex = descriptor.revision.slice("sha256:".length);
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `inline; filename="ragic-definitions-${revisionHex}.json"`,
    ETag: etag,
    "X-Ragic-Definitions-Revision": descriptor.revision,
    "X-Ragic-Definitions-Schema": SOURCE_CONTRACT,
    Vary: "Accept-Encoding",
  };
  if (descriptor.payloadSha256) {
    headers["X-Ragic-Definitions-Payload-SHA256"] = descriptor.payloadSha256;
  }
  const lastModified = descriptor.publishedAt ?? descriptor.materializedAt;
  if (lastModified) {
    headers["Last-Modified"] = new Date(lastModified).toUTCString();
  }
  if (encoding === "gzip") {
    headers["Content-Encoding"] = "gzip";
    const contentLength = compressedBytes ?? descriptor.compressedBytes;
    if (contentLength !== undefined) {
      headers["Content-Length"] = String(contentLength);
    }
  }
  res.set(headers);
}

function finishSnapshotPreflight(
  req: Request,
  res: Response,
  descriptor: SnapshotHeaderDescriptor,
  encoding: "gzip" | "identity"
): boolean {
  const etag = revisionEtag(descriptor.revision);
  if (requestMatchesEtag(req, etag)) {
    setSnapshotHeaders(res, descriptor, encoding);
    res.status(304).end();
    return true;
  }
  if (req.method === "HEAD") {
    setSnapshotHeaders(res, descriptor, encoding);
    res.status(200).end();
    return true;
  }
  return false;
}

async function sendSnapshot(
  res: Response,
  artifact: {
    descriptor: RagicDefinitionsSnapshotHistoryItem;
    content: Buffer;
  },
  encoding: "gzip" | "identity"
): Promise<void> {
  const { descriptor, content } = artifact;
  setSnapshotHeaders(res, descriptor, encoding, content.length);
  if (encoding === "gzip") {
    res.status(200).end(content);
    return;
  }
  await pipeline(Readable.from([content]), createGunzip(), res);
}

export function createRagicDefinitionsSourceRouter(
  options: RagicDefinitionsSourceRouterOptions = {}
): Router {
  const router = Router();
  const service = options.service ?? ragicDefinitionsReadService;
  const sourceToken = String(
    options.sourceToken ?? env.RAGIC_DEFINITIONS_SOURCE_API_TOKEN
  ).trim();

  router.use((req, _res, next) => {
    try {
      assertSourceToken(req.header("authorization"), sourceToken);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/state",
    asyncHandler(async (req, res) => {
      const current = await service.getSnapshotDescriptor();
      if (!current) {
        throw new HttpError(
          503,
          "Ragic Definitions snapshot 尚未建立",
          "RAGIC_DEFINITIONS_SOURCE_UNAVAILABLE"
        );
      }
      const etag = revisionEtag(current.revision);
      res.set({
        "Cache-Control": "private, no-cache",
        ETag: etag,
        "X-Ragic-Definitions-Revision": current.revision,
        "X-Ragic-Definitions-Schema": SOURCE_CONTRACT,
      });
      if (requestMatchesEtag(req, etag)) {
        res.status(304).end();
        return;
      }
      res.json({
        data: {
          schemaVersion: 1,
          contract: SOURCE_CONTRACT,
          current,
          endpoints: {
            snapshot: "/api/integrations/ragic-definitions/snapshot",
            snapshots: "/api/integrations/ragic-definitions/snapshots",
          },
        },
      });
    })
  );

  router.get(
    "/snapshot",
    asyncHandler(async (req, res) => {
      try {
        const encoding = selectSnapshotEncoding(req);
        const descriptor = await service.getSnapshotDescriptor();
        if (!descriptor) {
          throw new HttpError(
            503,
            "Ragic Definitions snapshot 尚未建立",
            "RAGIC_DEFINITIONS_SOURCE_UNAVAILABLE"
          );
        }
        if (finishSnapshotPreflight(req, res, descriptor, encoding)) return;
        await sendSnapshot(
          res,
          await service.loadCurrentSnapshot(),
          encoding
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        log.warn({
          event: "current-snapshot-open-failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(
          503,
          "Ragic Definitions snapshot 暫時無法讀取",
          "RAGIC_DEFINITIONS_SOURCE_UNAVAILABLE"
        );
      }
    })
  );

  router.get(
    "/snapshots",
    asyncHandler(async (_req, res) => {
      const snapshots = await service.listSnapshots();
      res.set("Cache-Control", "private, no-cache");
      res.json({
        data: snapshots,
        meta: {
          count: snapshots.length,
          contract: SOURCE_CONTRACT,
        },
      });
    })
  );

  router.get(
    "/snapshots/:revision",
    asyncHandler(async (req, res) => {
      const revision = normalizedRevision(String(req.params.revision ?? ""));
      const encoding = selectSnapshotEncoding(req);
      let found = false;
      try {
        const descriptor = await service.getSnapshotHistoryDescriptor(revision);
        if (!descriptor) {
          throw new HttpError(
            404,
            "找不到指定的 Ragic Definitions snapshot",
            "RAGIC_DEFINITIONS_SNAPSHOT_NOT_FOUND"
          );
        }
        if (finishSnapshotPreflight(req, res, descriptor, encoding)) return;
        const artifact = await service.loadSnapshot(revision);
        if (artifact) {
          found = true;
          await sendSnapshot(res, artifact, encoding);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        log.warn({
          event: "historical-snapshot-open-failed",
          revision,
          error: error instanceof Error ? error.message : String(error),
        });
        if (res.headersSent) throw error;
      }
      if (!found) {
        throw new HttpError(
          404,
          "找不到指定的 Ragic Definitions snapshot",
          "RAGIC_DEFINITIONS_SNAPSHOT_NOT_FOUND"
        );
      }
    })
  );

  return router;
}

export default createRagicDefinitionsSourceRouter();
