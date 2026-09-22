import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { HttpError, ValidationError } from "../../utils/httpError";
import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";

export const MEETING_AUDIO_SOURCE_IDS = ["room-mic", "remote-tab"] as const;
export type MeetingAudioSourceId = (typeof MEETING_AUDIO_SOURCE_IDS)[number];
export type MeetingRecordingStatus = "recording" | "finalized";

interface MeetingRecordingChunkManifest {
  sequence: number;
  sizeBytes: number;
  sha256: string;
}

interface MeetingRecordingTrackManifest {
  sourceId: MeetingAudioSourceId;
  mimeType: string;
  chunks: MeetingRecordingChunkManifest[];
  chunkCount: number;
  sizeBytes: number;
  outputFile: string | null;
}

interface MeetingRecordingManifest {
  schemaVersion: 1 | 2 | 3 | 4;
  sessionId: string;
  ownerId: string | null;
  recorderGrantId: string | null;
  sessionCapabilityDigest: string | null;
  recorderLibraryAccessVersion: number | null;
  sessionCapabilityExpiresAt: string | null;
  title: string;
  status: MeetingRecordingStatus;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  durationMs: number | null;
  totalSizeBytes: number;
  tracks: MeetingRecordingTrackManifest[];
}

export interface MeetingRecordingTrack {
  sourceId: MeetingAudioSourceId;
  mimeType: string;
  chunkCount: number;
  sizeBytes: number;
  available: boolean;
}

export interface MeetingRecordingSession {
  sessionId: string;
  title: string;
  status: MeetingRecordingStatus;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  durationMs: number | null;
  totalSizeBytes: number;
  tracks: MeetingRecordingTrack[];
}

export interface MeetingRecordingOwnerSummary {
  ownerId: string;
  recordingCount: number;
  latestRecording: MeetingRecordingSession | null;
  recordingTitles: string[];
}

export interface MeetingRecordingSessionPage {
  items: MeetingRecordingSession[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface MeetingRecordingSessionCapabilityAccess {
  ownerId: string;
  libraryAccessVersion: number;
}

export interface MeetingRecordingCleanupResult {
  deletedSessionIds: string[];
  deletedStaleSessionIds: string[];
  retainedBytes: number;
  maxTotalBytes: number;
}

export interface MeetingRecordingProcessingInput {
  sessionId: string;
  ownerId: string;
  title: string;
  durationMs: number;
  tracks: Array<{
    sourceId: MeetingAudioSourceId;
    mimeType: string;
    filePath: string;
    sizeBytes: number;
  }>;
}

interface MeetingRecordingProcessingLock {
  schemaVersion: 1;
  sessionId: string;
  jobId: string;
  createdAt: string;
}

interface MeetingRecordingStorageServiceDeps {
  storageDir?: string;
  maxTotalBytes?: number;
  maxSessionBytes?: number;
  maxChunkBytes?: number;
  staleSessionMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  readChunkFile?: (filePath: string) => Promise<Buffer>;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_ID_PATTERN = SESSION_ID_PATTERN;
const SESSION_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SEQUENCE = 100_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LOCK_FILE = ".processing-lock.json";
const log = createLogger("meeting-recording-storage");

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isMeetingAudioSourceId(value: string): value is MeetingAudioSourceId {
  return MEETING_AUDIO_SOURCE_IDS.includes(value as MeetingAudioSourceId);
}

function normalizeMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  const baseType = normalized.split(";", 1)[0]?.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 120 ||
    (baseType !== "audio/webm" && baseType !== "audio/ogg")
  ) {
    throw new ValidationError("錄音格式不受支援。", "MEETING_RECORDING_MIME_TYPE_INVALID");
  }
  return normalized;
}

function extensionForMimeType(mimeType: string): "webm" | "ogg" {
  return mimeType.startsWith("audio/ogg") ? "ogg" : "webm";
}

function toPublicSession(manifest: MeetingRecordingManifest): MeetingRecordingSession {
  return {
    sessionId: manifest.sessionId,
    title: manifest.title,
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    finalizedAt: manifest.finalizedAt,
    durationMs: manifest.durationMs,
    totalSizeBytes: manifest.totalSizeBytes,
    tracks: manifest.tracks.map((track) => ({
      sourceId: track.sourceId,
      mimeType: track.mimeType,
      chunkCount: track.chunkCount,
      sizeBytes: track.sizeBytes,
      available: manifest.status === "finalized" && Boolean(track.outputFile),
    })),
  };
}

function encodeSessionCursor(session: Pick<MeetingRecordingManifest, "createdAt" | "sessionId">): string {
  return Buffer.from(
    JSON.stringify({ v: 1, createdAt: session.createdAt, sessionId: session.sessionId }),
    "utf8"
  ).toString("base64url");
}

function decodeSessionCursor(value: string | null | undefined): {
  createdAt: string;
  sessionId: string;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      createdAt?: unknown;
      sessionId?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.sessionId !== "string" ||
      !SESSION_ID_PATTERN.test(parsed.sessionId)
    ) {
      throw new Error("invalid recording cursor");
    }
    return { createdAt: parsed.createdAt, sessionId: parsed.sessionId };
  } catch {
    throw new ValidationError(
      "錄音清單游標不合法。",
      "MEETING_RECORDING_CURSOR_INVALID"
    );
  }
}

export class MeetingRecordingStorageService {
  private readonly storageDir: string;
  private readonly trashDir: string;
  private readonly maxTotalBytes: number;
  private readonly maxSessionBytes: number;
  private readonly maxChunkBytes: number;
  private readonly staleSessionMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly readChunkFile: (filePath: string) => Promise<Buffer>;
  private initializedPromise: Promise<void> | null = null;
  private readonly sessionMutationQueue = createKeyedSerialQueue();
  private readonly protectedSessionMutationCounts = new Map<string, number>();
  private capacityMutationChain: Promise<void> = Promise.resolve();
  private audioUsageBytes = 0;

  constructor(deps: MeetingRecordingStorageServiceDeps = {}) {
    this.storageDir = path.resolve(deps.storageDir ?? env.MEETING_RECORDING_STORAGE_DIR);
    this.trashDir = path.join(this.storageDir, ".trash");
    this.maxTotalBytes = deps.maxTotalBytes ?? env.MEETING_RECORDING_MAX_TOTAL_BYTES;
    this.maxSessionBytes = deps.maxSessionBytes ?? env.MEETING_RECORDING_MAX_SESSION_BYTES;
    this.maxChunkBytes = deps.maxChunkBytes ?? env.MEETING_RECORDING_MAX_CHUNK_BYTES;
    this.staleSessionMs = deps.staleSessionMs ?? env.MEETING_RECORDING_STALE_SESSION_MS;
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? randomUUID;
    this.readChunkFile = deps.readChunkFile ?? readFile;
  }

  initialize(): Promise<void> {
    if (!this.initializedPromise) {
      this.initializedPromise = this.initializeInternal().catch((error) => {
        this.initializedPromise = null;
        throw error;
      });
    }
    return this.initializedPromise;
  }

  async createSession(input: {
    ownerId: string;
    title?: string;
    sourceIds: string[];
    recorderGrantId?: string;
    sessionCapability?: string;
    recorderLibraryAccessVersion?: number;
    sessionCapabilityExpiresAt?: string;
  }): Promise<MeetingRecordingSession> {
    await this.initialize();
    this.assertOwnerId(input.ownerId);
    const sourceIds = [...new Set(input.sourceIds.map((value) => value.trim()))];
    if (sourceIds.length === 0 || sourceIds.some((value) => !isMeetingAudioSourceId(value))) {
      throw new ValidationError(
        "請至少指定一個有效錄音來源。",
        "MEETING_RECORDING_SOURCE_REQUIRED"
      );
    }
    const normalizedSourceIds = sourceIds as MeetingAudioSourceId[];
    const recorderGrantId = input.recorderGrantId ?? null;
    const sessionCapability = input.sessionCapability ?? null;
    const recorderLibraryAccessVersion = input.recorderLibraryAccessVersion ?? null;
    const sessionCapabilityExpiresAt = input.sessionCapabilityExpiresAt ?? null;
    const capabilityParts = [
      recorderGrantId,
      sessionCapability,
      recorderLibraryAccessVersion,
      sessionCapabilityExpiresAt,
    ];
    const populatedCapabilityPartCount = capabilityParts.filter(
      (value) => value !== null
    ).length;
    if (
      populatedCapabilityPartCount !== 0 &&
      populatedCapabilityPartCount !== capabilityParts.length
    ) {
      throw new ValidationError(
        "錄音 session 權限資料不完整。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    if (recorderGrantId !== null && !OWNER_ID_PATTERN.test(recorderGrantId)) {
      throw new ValidationError(
        "錄音 recorder grant 不合法。",
        "MEETING_RECORDING_RECORDER_GRANT_INVALID"
      );
    }
    if (sessionCapability !== null && !SESSION_CAPABILITY_PATTERN.test(sessionCapability)) {
      throw new ValidationError(
        "錄音 session 權限不合法。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    if (
      recorderLibraryAccessVersion !== null &&
      (!Number.isInteger(recorderLibraryAccessVersion) ||
        recorderLibraryAccessVersion <= 0)
    ) {
      throw new ValidationError(
        "錄音庫權限版本不合法。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    const sessionCapabilityExpiresAtMs =
      sessionCapabilityExpiresAt === null
        ? null
        : Date.parse(sessionCapabilityExpiresAt);
    if (
      sessionCapabilityExpiresAt !== null &&
      (!Number.isFinite(sessionCapabilityExpiresAtMs) ||
        new Date(sessionCapabilityExpiresAtMs!).toISOString() !==
          sessionCapabilityExpiresAt ||
        sessionCapabilityExpiresAtMs! <= this.now().getTime())
    ) {
      throw new ValidationError(
        "錄音 session 權限到期時間不合法。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    const title = input.title?.trim() || "未命名會議";
    if (title.length > 120) {
      throw new ValidationError("會議名稱不可超過 120 字。", "MEETING_RECORDING_TITLE_TOO_LONG");
    }

    return this.runCapacityExclusive(async () => {
      const sessionId = this.idFactory();
      this.assertSessionId(sessionId);
      const timestamp = this.now().toISOString();
      const manifest: MeetingRecordingManifest = {
        schemaVersion: 4,
        sessionId,
        ownerId: input.ownerId,
        recorderGrantId,
        sessionCapabilityDigest: sessionCapability
          ? createHash("sha256").update(sessionCapability, "utf8").digest("hex")
          : null,
        recorderLibraryAccessVersion,
        sessionCapabilityExpiresAt,
        title,
        status: "recording",
        createdAt: timestamp,
        updatedAt: timestamp,
        finalizedAt: null,
        durationMs: null,
        totalSizeBytes: 0,
        tracks: normalizedSourceIds.map((sourceId) => ({
          sourceId,
          mimeType: "",
          chunks: [],
          chunkCount: 0,
          sizeBytes: 0,
          outputFile: null,
        })),
      };
      await mkdir(this.sessionDir(sessionId), { recursive: false });
      try {
        await this.writeManifest(manifest);
      } catch (error) {
        await rm(this.sessionDir(sessionId), { recursive: true, force: true });
        throw error;
      }
      return toPublicSession(manifest);
    });
  }

  async uploadChunk(input: {
    ownerId: string;
    sessionId: string;
    sourceId: string;
    sequence: number;
    mimeType: string;
    body: Buffer;
  }): Promise<{ sequence: number; sizeBytes: number; duplicate: boolean }> {
    await this.initialize();
    this.assertOwnerId(input.ownerId);
    this.assertSessionId(input.sessionId);
    if (!isMeetingAudioSourceId(input.sourceId)) {
      throw new ValidationError("錄音來源不合法。", "MEETING_RECORDING_SOURCE_INVALID");
    }
    const sourceId = input.sourceId;
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > MAX_SEQUENCE) {
      throw new ValidationError("錄音分段序號不合法。", "MEETING_RECORDING_SEQUENCE_INVALID");
    }
    if (input.body.length === 0) {
      throw new ValidationError("錄音分段不可為空。", "MEETING_RECORDING_CHUNK_EMPTY");
    }
    if (input.body.length > this.maxChunkBytes) {
      throw new HttpError(
        413,
        "錄音分段超過允許大小。",
        "MEETING_RECORDING_CHUNK_TOO_LARGE"
      );
    }
    const mimeType = normalizeMimeType(input.mimeType);
    const sha256 = createHash("sha256").update(input.body).digest("hex");

    return this.runSessionExclusive(input.sessionId, async () => {
      const manifest = await this.readManifest(input.sessionId);
      this.assertOwner(manifest, input.ownerId);
      if (manifest.status !== "recording") {
        throw new HttpError(409, "錄音已完成，不能再上傳分段。", "MEETING_RECORDING_FINALIZED");
      }
      const track = manifest.tracks.find((item) => item.sourceId === sourceId);
      if (!track) {
        throw new HttpError(409, "這個來源不屬於目前錄音。", "MEETING_RECORDING_SOURCE_MISMATCH");
      }
      if (track.mimeType && track.mimeType !== mimeType) {
        throw new HttpError(409, "同一音軌的錄音格式不可變更。", "MEETING_RECORDING_MIME_TYPE_CHANGED");
      }
      const existing = track.chunks.find((item) => item.sequence === input.sequence);
      if (existing) {
        if (existing.sha256 !== sha256 || existing.sizeBytes !== input.body.length) {
          throw new HttpError(
            409,
            "相同序號已存在不同內容。",
            "MEETING_RECORDING_CHUNK_CONFLICT"
          );
        }
        try {
          await access(this.chunkPath(input.sessionId, sourceId, input.sequence));
          return { sequence: input.sequence, sizeBytes: existing.sizeBytes, duplicate: true };
        } catch {
          // manifest 已存在但 chunk 遺失時，沿用同一序號補回原內容。
        }
      }

      const chunkPath = this.chunkPath(input.sessionId, sourceId, input.sequence);
      let previousChunkFileBytes = 0;
      try {
        previousChunkFileBytes = (await stat(chunkPath)).size;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      const additionalStorageBytes = Math.max(0, input.body.length - previousChunkFileBytes);
      const projectedSessionBytes = manifest.totalSizeBytes + (existing ? 0 : input.body.length);
      if (projectedSessionBytes > this.maxSessionBytes) {
        throw new HttpError(
          413,
          "單次會議錄音已達容量上限。",
          "MEETING_RECORDING_SESSION_SIZE_LIMIT"
        );
      }
      await this.runCapacityExclusive(async () => {
        if (this.audioUsageBytes + additionalStorageBytes > this.maxTotalBytes) {
          throw new HttpError(
            507,
            "錄音儲存空間已滿；系統不會自動刪除已完成錄音。",
            "MEETING_RECORDING_STORAGE_LIMIT"
          );
        }
        this.audioUsageBytes += additionalStorageBytes;
      });

      try {
        await mkdir(path.dirname(chunkPath), { recursive: true });
        await this.writeAtomicFile(chunkPath, input.body);
        if (!existing) {
          track.chunks.push({ sequence: input.sequence, sizeBytes: input.body.length, sha256 });
          track.chunks.sort((left, right) => left.sequence - right.sequence);
          track.chunkCount = track.chunks.length;
          track.sizeBytes += input.body.length;
          manifest.totalSizeBytes += input.body.length;
        }
        track.mimeType = mimeType;
        manifest.updatedAt = this.now().toISOString();
        await this.writeManifest(manifest);
      } catch (error) {
        await rm(chunkPath, { force: true });
        await this.runCapacityExclusive(async () => {
          this.audioUsageBytes = Math.max(
            0,
            this.audioUsageBytes - additionalStorageBytes - previousChunkFileBytes
          );
        });
        throw error;
      }
      if (input.body.length < previousChunkFileBytes) {
        await this.runCapacityExclusive(async () => {
          this.audioUsageBytes = Math.max(
            0,
            this.audioUsageBytes - (previousChunkFileBytes - input.body.length)
          );
        });
      }
      return { sequence: input.sequence, sizeBytes: input.body.length, duplicate: false };
    });
  }

  async finalizeSession(input: {
    ownerId: string;
    sessionId: string;
    durationMs: number;
    tracks: Array<{ sourceId: string; chunkCount: number }>;
  }): Promise<MeetingRecordingSession> {
    await this.initialize();
    this.assertOwnerId(input.ownerId);
    this.assertSessionId(input.sessionId);
    if (
      !Number.isFinite(input.durationMs) ||
      input.durationMs <= 0 ||
      input.durationMs > MAX_DURATION_MS
    ) {
      throw new ValidationError("錄音時間不合法。", "MEETING_RECORDING_DURATION_INVALID");
    }

    return this.runSessionExclusive(input.sessionId, async () => {
      const manifest = await this.readManifest(input.sessionId);
      this.assertOwner(manifest, input.ownerId);
      if (manifest.status === "finalized") {
        return toPublicSession(manifest);
      }
      if (input.tracks.length !== manifest.tracks.length) {
        throw new HttpError(409, "音軌數量與建立時不一致。", "MEETING_RECORDING_TRACK_COUNT_MISMATCH");
      }

      for (const track of manifest.tracks) {
        const expected = input.tracks.find((item) => item.sourceId === track.sourceId);
        if (
          !expected ||
          !Number.isInteger(expected.chunkCount) ||
          expected.chunkCount <= 0 ||
          expected.chunkCount !== track.chunks.length
        ) {
          throw new HttpError(409, "錄音分段尚未完整上傳。", "MEETING_RECORDING_CHUNKS_INCOMPLETE");
        }
        for (let sequence = 0; sequence < track.chunks.length; sequence += 1) {
          if (track.chunks[sequence]?.sequence !== sequence) {
            throw new HttpError(409, "錄音分段序號不連續。", "MEETING_RECORDING_CHUNKS_INCOMPLETE");
          }
        }
      }

      const sourceChunkBytes = manifest.totalSizeBytes;
      await this.runCapacityExclusive(async () => {
        if (this.audioUsageBytes + sourceChunkBytes > this.maxTotalBytes) {
          throw new HttpError(
            507,
            "錄音收尾需要暫存空間，但目前容量不足。",
            "MEETING_RECORDING_FINALIZE_STORAGE_LIMIT"
          );
        }
        this.audioUsageBytes += sourceChunkBytes;
      });

      const tempPaths = new Set<string>();
      const outputPaths = new Set<string>();
      let finalizedManifestWritten = false;
      try {
        for (const track of manifest.tracks) {
          const outputFile = `${track.sourceId}.${extensionForMimeType(track.mimeType)}`;
          const outputPath = path.join(this.sessionDir(input.sessionId), outputFile);
          const tempPath = `${outputPath}.tmp-${randomUUID()}`;
          tempPaths.add(tempPath);
          const handle = await open(tempPath, "w");
          let position = 0;
          try {
            for (const chunk of track.chunks) {
              const body = await this.readChunkFile(
                this.chunkPath(input.sessionId, track.sourceId, chunk.sequence)
              );
              await handle.write(body, 0, body.length, position);
              position += body.length;
            }
          } finally {
            await handle.close();
          }
          await rename(tempPath, outputPath);
          tempPaths.delete(tempPath);
          outputPaths.add(outputPath);
          const outputStat = await stat(outputPath);
          track.outputFile = outputFile;
          track.chunkCount = track.chunks.length;
          track.sizeBytes = outputStat.size;
        }

        const timestamp = this.now().toISOString();
        manifest.status = "finalized";
        manifest.durationMs = Math.trunc(input.durationMs);
        manifest.finalizedAt = timestamp;
        manifest.updatedAt = timestamp;
        manifest.totalSizeBytes = manifest.tracks.reduce(
          (sum, track) => sum + track.sizeBytes,
          0
        );
        await this.writeManifest(manifest);
        finalizedManifestWritten = true;

        for (const track of manifest.tracks) {
          await rm(this.trackChunksDir(input.sessionId, track.sourceId), {
            recursive: true,
            force: true,
          });
          track.chunks = [];
        }
        await this.writeManifest(manifest);
        await this.runCapacityExclusive(async () => {
          this.audioUsageBytes = Math.max(0, this.audioUsageBytes - sourceChunkBytes);
        });
        return toPublicSession(manifest);
      } catch (error) {
        await Promise.all(
          [...tempPaths, ...(finalizedManifestWritten ? [] : outputPaths)].map((filePath) =>
            rm(filePath, { force: true }).catch(() => undefined)
          )
        );
        await this.runCapacityExclusive(async () => {
          if (finalizedManifestWritten) {
            await this.recalculateUsageLocked();
          } else {
            this.audioUsageBytes = Math.max(0, this.audioUsageBytes - sourceChunkBytes);
          }
        });
        throw error;
      }
    });
  }

  async abortSession(sessionId: string, ownerId: string): Promise<void> {
    await this.initialize();
    this.assertOwnerId(ownerId);
    this.assertSessionId(sessionId);
    await this.runSessionExclusive(sessionId, async () => {
      const manifest = await this.readManifest(sessionId);
      this.assertOwner(manifest, ownerId);
      if (manifest.status === "finalized") {
        throw new HttpError(409, "已完成錄音不可中止。", "MEETING_RECORDING_ALREADY_FINALIZED");
      }
      const removedBytes = await this.directoryAudioBytes(this.sessionDir(sessionId));
      await this.runCapacityExclusive(() =>
        this.removeSessionLocked(manifest, removedBytes, {
          allowCurrentSessionMutation: true,
        })
      );
    });
  }

  async getSession(sessionId: string, ownerId: string): Promise<MeetingRecordingSession> {
    await this.initialize();
    this.assertOwnerId(ownerId);
    this.assertSessionId(sessionId);
    const manifest = await this.readManifest(sessionId);
    this.assertOwner(manifest, ownerId);
    return toPublicSession(manifest);
  }

  async resolveSessionCapabilityOwner(
    sessionId: string,
    sessionCapability: string
  ): Promise<MeetingRecordingSessionCapabilityAccess> {
    await this.initialize();
    this.assertSessionId(sessionId);
    if (!SESSION_CAPABILITY_PATTERN.test(sessionCapability)) {
      throw new HttpError(
        401,
        "錄音 session 權限無效。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    const manifest = await this.readManifest(sessionId);
    if (
      !manifest.ownerId ||
      !manifest.sessionCapabilityDigest ||
      !manifest.recorderLibraryAccessVersion ||
      !manifest.sessionCapabilityExpiresAt
    ) {
      throw new HttpError(
        401,
        "這份錄音不接受 session 權限。",
        "MEETING_RECORDING_SESSION_CAPABILITY_INVALID"
      );
    }
    const expected = Buffer.from(manifest.sessionCapabilityDigest, "hex");
    const provided = Buffer.from(
      createHash("sha256").update(sessionCapability, "utf8").digest("hex"),
      "hex"
    );
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new HttpError(
        404,
        "找不到錄音 session。",
        "MEETING_RECORDING_NOT_FOUND"
      );
    }
    if (Date.parse(manifest.sessionCapabilityExpiresAt) <= this.now().getTime()) {
      throw new HttpError(
        401,
        "錄音 session 權限已過期。",
        "MEETING_RECORDING_SESSION_CAPABILITY_EXPIRED"
      );
    }
    return {
      ownerId: manifest.ownerId,
      libraryAccessVersion: manifest.recorderLibraryAccessVersion,
    };
  }

  async listSessions(ownerId: string, limit = 20): Promise<MeetingRecordingSession[]> {
    return (await this.listSessionsPage(ownerId, { limit })).items;
  }

  async listSessionsPage(
    ownerId: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<MeetingRecordingSessionPage> {
    await this.initialize();
    this.assertOwnerId(ownerId);
    const normalizedLimit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const cursor = decodeSessionCursor(options.cursor);
    const manifests = await this.readAllManifests();
    const ordered = manifests
      .filter((manifest) => manifest.ownerId === ownerId)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.sessionId.localeCompare(right.sessionId)
      )
      .filter(
        (manifest) =>
          !cursor ||
          manifest.createdAt.localeCompare(cursor.createdAt) < 0 ||
          (manifest.createdAt === cursor.createdAt &&
            manifest.sessionId.localeCompare(cursor.sessionId) > 0)
      );
    const page = ordered.slice(0, normalizedLimit + 1);
    const hasMore = page.length > normalizedLimit;
    const visible = page.slice(0, normalizedLimit);
    return {
      items: visible.map(toPublicSession),
      nextCursor:
        hasMore && visible.length > 0
          ? encodeSessionCursor(visible[visible.length - 1]!)
          : null,
      hasMore,
    };
  }

  async summarizeSessionsByOwner(): Promise<Map<string, MeetingRecordingOwnerSummary>> {
    await this.initialize();
    const manifests = await this.readAllManifests();
    const summaries = new Map<string, MeetingRecordingOwnerSummary>();
    for (const manifest of manifests) {
      if (!manifest.ownerId) continue;
      const current = summaries.get(manifest.ownerId) ?? {
        ownerId: manifest.ownerId,
        recordingCount: 0,
        latestRecording: null,
        recordingTitles: [],
      };
      const session = toPublicSession(manifest);
      current.recordingCount += 1;
      current.recordingTitles.push(session.title);
      if (
        !current.latestRecording ||
        session.createdAt.localeCompare(current.latestRecording.createdAt) > 0
      ) {
        current.latestRecording = session;
      }
      summaries.set(manifest.ownerId, current);
    }
    return summaries;
  }

  async resolveTrack(sessionId: string, sourceId: string, ownerId: string): Promise<{
    filePath: string;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }> {
    await this.initialize();
    this.assertOwnerId(ownerId);
    this.assertSessionId(sessionId);
    if (!isMeetingAudioSourceId(sourceId)) {
      throw new ValidationError("錄音來源不合法。", "MEETING_RECORDING_SOURCE_INVALID");
    }
    const manifest = await this.readManifest(sessionId);
    this.assertOwner(manifest, ownerId);
    const track = manifest.tracks.find((item) => item.sourceId === sourceId);
    if (manifest.status !== "finalized" || !track?.outputFile) {
      throw new HttpError(404, "錄音檔尚未完成。", "MEETING_RECORDING_TRACK_NOT_READY");
    }
    const filePath = path.join(this.sessionDir(sessionId), track.outputFile);
    try {
      await access(filePath);
    } catch {
      throw new HttpError(410, "錄音檔已不存在。", "MEETING_RECORDING_TRACK_MISSING");
    }
    return {
      filePath,
      mimeType: track.mimeType,
      filename: track.outputFile,
      sizeBytes: track.sizeBytes,
    };
  }

  async acquireProcessingLock(input: {
    sessionId: string;
    ownerId: string;
    jobId: string;
  }): Promise<MeetingRecordingProcessingInput> {
    await this.initialize();
    this.assertOwnerId(input.ownerId);
    this.assertSessionId(input.sessionId);
    this.assertSessionId(input.jobId);
    return this.runSessionExclusive(input.sessionId, async () => {
      const manifest = await this.readManifest(input.sessionId);
      this.assertOwner(manifest, input.ownerId);
      const processingInput = await this.resolveProcessingInputFromManifest(manifest);
      const lock: MeetingRecordingProcessingLock = {
        schemaVersion: 1,
        sessionId: input.sessionId,
        jobId: input.jobId,
        createdAt: this.now().toISOString(),
      };
      try {
        await writeFile(this.processingLockPath(input.sessionId), `${JSON.stringify(lock)}\n`, {
          flag: "wx",
        });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const existing = await this.readProcessingLock(input.sessionId);
        if (existing.jobId !== input.jobId) {
          throw new HttpError(
            409,
            "這份錄音已有後處理任務。",
            "MEETING_PROCESSING_ALREADY_LOCKED"
          );
        }
      }
      return processingInput;
    });
  }

  async resolveProcessingInput(
    sessionId: string,
    jobId: string
  ): Promise<MeetingRecordingProcessingInput> {
    await this.initialize();
    this.assertSessionId(sessionId);
    this.assertSessionId(jobId);
    const lock = await this.readProcessingLock(sessionId);
    if (lock.jobId !== jobId) {
      throw new HttpError(
        409,
        "錄音後處理鎖與任務不一致。",
        "MEETING_PROCESSING_LOCK_MISMATCH"
      );
    }
    return this.resolveProcessingInputFromManifest(await this.readManifest(sessionId));
  }

  async releaseProcessingLock(sessionId: string, jobId: string): Promise<boolean> {
    await this.initialize();
    this.assertSessionId(sessionId);
    this.assertSessionId(jobId);
    return this.runSessionExclusive(sessionId, async () => {
      let lock: MeetingRecordingProcessingLock;
      try {
        lock = await this.readProcessingLock(sessionId);
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
      if (lock.jobId !== jobId) return false;
      await rm(this.processingLockPath(sessionId), { force: true });
      return true;
    });
  }

  async getProcessingLockJobId(sessionId: string): Promise<string | null> {
    await this.initialize();
    this.assertSessionId(sessionId);
    try {
      return (await this.readProcessingLock(sessionId)).jobId;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  async cleanupStorage(): Promise<MeetingRecordingCleanupResult> {
    await this.initialize();
    const nowMs = this.now().getTime();
    const manifests = await this.readAllManifests();
    const stale = manifests
      .filter(
        (manifest) =>
          manifest.status === "recording" &&
          nowMs - Date.parse(manifest.updatedAt) >= this.staleSessionMs
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const deletedStaleSessionIds: string[] = [];
    for (const candidate of stale) {
      await this.runSessionExclusive(candidate.sessionId, async () => {
        let current: MeetingRecordingManifest;
        try {
          current = await this.readManifest(candidate.sessionId);
        } catch (error) {
          if (
            isErrno(error, "ENOENT") ||
            (error instanceof HttpError && error.code === "MEETING_RECORDING_NOT_FOUND")
          ) {
            return;
          }
          throw error;
        }
        if (
          current.status !== "recording" ||
          nowMs - Date.parse(current.updatedAt) < this.staleSessionMs
        ) {
          return;
        }
        const removedBytes = await this.directoryAudioBytes(
          this.sessionDir(current.sessionId)
        );
        await this.runCapacityExclusive(async () => {
          const removed = await this.removeSessionLocked(current, removedBytes, {
            allowCurrentSessionMutation: true,
          });
          if (removed) deletedStaleSessionIds.push(current.sessionId);
        });
      });
    }
    return this.runCapacityExclusive(async () => {
      return {
        deletedSessionIds: [],
        deletedStaleSessionIds,
        retainedBytes: this.audioUsageBytes,
        maxTotalBytes: this.maxTotalBytes,
      };
    });
  }

  private async initializeInternal(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await mkdir(this.trashDir, { recursive: true });
    const trashEntries = await readdir(this.trashDir, { withFileTypes: true });
    await Promise.all(
      trashEntries.map((entry) =>
        rm(path.join(this.trashDir, entry.name), { recursive: true, force: true })
      )
    );
    const manifests = await this.readAllManifests();
    for (const manifest of manifests) {
      if (manifest.status !== "finalized") continue;
      for (const track of manifest.tracks) {
        await rm(this.trackChunksDir(manifest.sessionId, track.sourceId), {
          recursive: true,
          force: true,
        });
      }
    }
    await this.recalculateUsageLocked();
    log.info({
      event: "initialized",
      storageDir: this.storageDir,
      audioUsageBytes: this.audioUsageBytes,
      maxTotalBytes: this.maxTotalBytes,
    });
  }

  private async runSessionExclusive<T>(
    sessionId: string,
    worker: () => Promise<T>
  ): Promise<T> {
    this.protectedSessionMutationCounts.set(
      sessionId,
      (this.protectedSessionMutationCounts.get(sessionId) ?? 0) + 1
    );
    let result!: T;
    try {
      await this.sessionMutationQueue.enqueue(sessionId, async () => {
        result = await worker();
      });
      return result;
    } finally {
      const remaining = (this.protectedSessionMutationCounts.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) {
        this.protectedSessionMutationCounts.delete(sessionId);
      } else {
        this.protectedSessionMutationCounts.set(sessionId, remaining);
      }
    }
  }

  private runCapacityExclusive<T>(worker: () => Promise<T>): Promise<T> {
    const run = this.capacityMutationChain.catch(() => undefined).then(worker);
    this.capacityMutationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async recalculateUsageLocked(): Promise<void> {
    this.audioUsageBytes = await this.directoryAudioBytes(this.storageDir, true);
  }

  private async removeSessionLocked(
    manifest: MeetingRecordingManifest,
    knownRemovedBytes?: number,
    options: { allowCurrentSessionMutation?: boolean } = {}
  ): Promise<boolean> {
    if (
      (!options.allowCurrentSessionMutation &&
        this.protectedSessionMutationCounts.has(manifest.sessionId)) ||
      (await this.hasProcessingLock(manifest.sessionId))
    ) {
      return false;
    }
    const sourcePath = this.sessionDir(manifest.sessionId);
    const trashPath = path.join(this.trashDir, `${manifest.sessionId}-${randomUUID()}`);
    const removedBytes =
      knownRemovedBytes ?? (await this.directoryAudioBytes(sourcePath));
    try {
      await rename(sourcePath, trashPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    this.audioUsageBytes = Math.max(0, this.audioUsageBytes - removedBytes);
    void rm(trashPath, { recursive: true, force: true }).catch((error) => {
      log.warn({
        event: "trash-remove-failed",
        sessionId: manifest.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  private async resolveProcessingInputFromManifest(
    manifest: MeetingRecordingManifest
  ): Promise<MeetingRecordingProcessingInput> {
    if (
      manifest.status !== "finalized" ||
      manifest.durationMs === null ||
      !manifest.ownerId ||
      manifest.tracks.length === 0
    ) {
      throw new HttpError(
        409,
        "錄音尚未完成，不能開始後處理。",
        "MEETING_RECORDING_NOT_FINALIZED"
      );
    }
    const tracks = await Promise.all(
      manifest.tracks.map(async (track) => {
        if (!track.outputFile) {
          throw new HttpError(
            410,
            "錄音音軌檔案已不存在。",
            "MEETING_RECORDING_TRACK_MISSING"
          );
        }
        const filePath = path.join(this.sessionDir(manifest.sessionId), track.outputFile);
        try {
          await access(filePath);
        } catch {
          throw new HttpError(
            410,
            "錄音音軌檔案已不存在。",
            "MEETING_RECORDING_TRACK_MISSING"
          );
        }
        return {
          sourceId: track.sourceId,
          mimeType: track.mimeType,
          filePath,
          sizeBytes: track.sizeBytes,
        };
      })
    );
    return {
      sessionId: manifest.sessionId,
      ownerId: manifest.ownerId,
      title: manifest.title,
      durationMs: manifest.durationMs,
      tracks,
    };
  }

  private async readProcessingLock(sessionId: string): Promise<MeetingRecordingProcessingLock> {
    const payload = JSON.parse(
      await readFile(this.processingLockPath(sessionId), "utf8")
    ) as MeetingRecordingProcessingLock;
    if (
      payload.schemaVersion !== 1 ||
      payload.sessionId !== sessionId ||
      !SESSION_ID_PATTERN.test(payload.jobId)
    ) {
      throw new Error("meeting recording processing lock schema mismatch");
    }
    return payload;
  }

  private async hasProcessingLock(sessionId: string): Promise<boolean> {
    try {
      await access(this.processingLockPath(sessionId));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async directoryAudioBytes(directory: string, skipTrash = false): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    }
    for (const entry of entries) {
      if (skipTrash && entry.name === ".trash") continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await this.directoryAudioBytes(child);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".part") ||
          entry.name.endsWith(".webm") ||
          entry.name.endsWith(".ogg"))
      ) {
        total += (await stat(child)).size;
      }
    }
    return total;
  }

  private async readAllManifests(): Promise<MeetingRecordingManifest[]> {
    const entries = await readdir(this.storageDir, { withFileTypes: true });
    const manifests: MeetingRecordingManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
      try {
        manifests.push(await this.readManifest(entry.name));
      } catch (error) {
        log.warn({
          event: "manifest-read-failed",
          sessionId: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return manifests;
  }

  private async readManifest(sessionId: string): Promise<MeetingRecordingManifest> {
    try {
      const payload = JSON.parse(await readFile(this.manifestPath(sessionId), "utf8")) as
        | MeetingRecordingManifest
        | (Omit<MeetingRecordingManifest, "ownerId" | "recorderGrantId" | "sessionCapabilityDigest" | "recorderLibraryAccessVersion" | "sessionCapabilityExpiresAt"> & {
            schemaVersion: 1;
          })
        | (Omit<MeetingRecordingManifest, "recorderGrantId" | "sessionCapabilityDigest" | "recorderLibraryAccessVersion" | "sessionCapabilityExpiresAt"> & {
            schemaVersion: 2;
          })
        | (Omit<MeetingRecordingManifest, "recorderLibraryAccessVersion" | "sessionCapabilityExpiresAt"> & {
            schemaVersion: 3;
          });
      if (
        (payload.schemaVersion !== 1 &&
          payload.schemaVersion !== 2 &&
          payload.schemaVersion !== 3 &&
          payload.schemaVersion !== 4) ||
        payload.sessionId !== sessionId
      ) {
        throw new Error("meeting recording manifest schema mismatch");
      }
      if (payload.schemaVersion === 1) {
        return {
          ...payload,
          ownerId: null,
          recorderGrantId: null,
          sessionCapabilityDigest: null,
          recorderLibraryAccessVersion: null,
          sessionCapabilityExpiresAt: null,
        };
      }
      if (!payload.ownerId || !OWNER_ID_PATTERN.test(payload.ownerId)) {
        throw new Error("meeting recording manifest owner mismatch");
      }
      if (payload.schemaVersion === 2) {
        return {
          ...payload,
          recorderGrantId: null,
          sessionCapabilityDigest: null,
          recorderLibraryAccessVersion: null,
          sessionCapabilityExpiresAt: null,
        };
      }
      if (payload.schemaVersion === 3) {
        return {
          ...payload,
          recorderLibraryAccessVersion: null,
          sessionCapabilityExpiresAt: null,
        };
      }
      const capabilityFields = [
        payload.recorderGrantId,
        payload.sessionCapabilityDigest,
        payload.recorderLibraryAccessVersion,
        payload.sessionCapabilityExpiresAt,
      ];
      const populatedCapabilityFieldCount = capabilityFields.filter(
        (value) => value !== null
      ).length;
      if (
        (populatedCapabilityFieldCount !== 0 &&
          populatedCapabilityFieldCount !== capabilityFields.length) ||
        (payload.recorderGrantId !== null &&
          !OWNER_ID_PATTERN.test(payload.recorderGrantId)) ||
        (payload.sessionCapabilityDigest !== null &&
          !/^[0-9a-f]{64}$/.test(payload.sessionCapabilityDigest)) ||
        (payload.recorderLibraryAccessVersion !== null &&
          (!Number.isInteger(payload.recorderLibraryAccessVersion) ||
            payload.recorderLibraryAccessVersion <= 0)) ||
        (payload.sessionCapabilityExpiresAt !== null &&
          (!Number.isFinite(Date.parse(payload.sessionCapabilityExpiresAt)) ||
            new Date(Date.parse(payload.sessionCapabilityExpiresAt)).toISOString() !==
              payload.sessionCapabilityExpiresAt))
      ) {
        throw new Error("meeting recording manifest capability mismatch");
      }
      return payload as MeetingRecordingManifest;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
      }
      throw error;
    }
  }

  private writeManifest(manifest: MeetingRecordingManifest): Promise<void> {
    return this.writeAtomicFile(
      this.manifestPath(manifest.sessionId),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    );
  }

  private async writeAtomicFile(filePath: string, body: Buffer): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tempPath, body, { flag: "wx" });
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ValidationError("錄音 session ID 不合法。", "MEETING_RECORDING_SESSION_ID_INVALID");
    }
  }

  private assertOwnerId(ownerId: string): void {
    if (!OWNER_ID_PATTERN.test(ownerId)) {
      throw new ValidationError(
        "錄音 owner ID 不合法。",
        "MEETING_RECORDING_OWNER_ID_INVALID"
      );
    }
  }

  private assertOwner(manifest: MeetingRecordingManifest, ownerId: string): void {
    if (manifest.ownerId !== ownerId) {
      throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
    }
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.storageDir, sessionId);
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "manifest.json");
  }

  private processingLockPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), PROCESSING_LOCK_FILE);
  }

  private trackChunksDir(sessionId: string, sourceId: MeetingAudioSourceId): string {
    return path.join(this.sessionDir(sessionId), "chunks", sourceId);
  }

  private chunkPath(sessionId: string, sourceId: MeetingAudioSourceId, sequence: number): string {
    return path.join(
      this.trackChunksDir(sessionId, sourceId),
      `${String(sequence).padStart(8, "0")}.part`
    );
  }
}

export const meetingRecordingStorageService = new MeetingRecordingStorageService();
