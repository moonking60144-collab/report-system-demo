import { createHmac, randomInt, randomUUID } from "node:crypto";
import { env } from "../../config/env";
import {
  meetingLibraryRepository,
  type MeetingAdminAuditAction,
  type MeetingLibraryRecord,
  type MeetingLibraryRepository,
} from "../../storage/meeting-minutes/meetingLibraryRepository";
import { HttpError, ValidationError } from "../../utils/httpError";

const LIBRARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 12;
const DISPLAY_NAME_MAX_LENGTH = 60;

export type MeetingLibrarySetupMissingField = "displayName" | "codeHint";

export interface MeetingLibraryPublicInfo {
  libraryId: string;
  displayName: string | null;
  codeHint: string | null;
  setupState: "incomplete" | "ready";
  missingFields: MeetingLibrarySetupMissingField[];
  accessVersion: number;
  createdAt: string;
  codeRotatedAt: string;
}

interface MeetingLibraryRotationResult {
  library: MeetingLibraryPublicInfo;
  code: string;
}

interface MeetingLibraryAccessServiceDeps {
  repository?: MeetingLibraryRepository;
  pepper?: string;
  now?: () => Date;
  codeFactory?: () => string;
  auditIdFactory?: () => string;
}

export function toMeetingLibraryPublicInfo(
  library: MeetingLibraryRecord
): MeetingLibraryPublicInfo {
  const missingFields: MeetingLibrarySetupMissingField[] = [];
  if (!library.displayNameConfirmedAt) missingFields.push("displayName");
  if (!library.codeHint) missingFields.push("codeHint");
  return {
    libraryId: library.libraryId,
    displayName: library.displayName,
    codeHint: library.codeHint,
    setupState: missingFields.length === 0 ? "ready" : "incomplete",
    missingFields,
    accessVersion: library.accessVersion,
    createdAt: library.createdAt,
    codeRotatedAt: library.codeRotatedAt,
  };
}

export function normalizeMeetingLibraryCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(
      "錄音庫存取碼格式不正確。",
      "MEETING_LIBRARY_CODE_INVALID"
    );
  }
  const normalized = value.toUpperCase().replace(/[\s-]+/g, "");
  if (
    normalized.length !== CODE_LENGTH ||
    [...normalized].some((character) => !CODE_ALPHABET.includes(character))
  ) {
    throw new ValidationError(
      "錄音庫存取碼格式不正確。",
      "MEETING_LIBRARY_CODE_INVALID"
    );
  }
  return normalized;
}

export function formatMeetingLibraryCode(normalizedCode: string): string {
  return `${normalizedCode.slice(0, 3)}-${normalizedCode.slice(3)}`;
}

export function formatMeetingLibraryCodeHint(normalizedCode: string): string {
  return `${normalizedCode.slice(0, 1)}**-**${normalizedCode.slice(-1)}`;
}

export function normalizeMeetingLibraryDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError(
      "錄音庫名稱為必填文字。",
      "MEETING_LIBRARY_NAME_REQUIRED"
    );
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) {
    throw new ValidationError(
      "錄音庫名稱為必填文字。",
      "MEETING_LIBRARY_NAME_REQUIRED"
    );
  }
  if (
    Array.from(normalized).length > DISPLAY_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ValidationError(
      `錄音庫名稱不可超過 ${DISPLAY_NAME_MAX_LENGTH} 個字元。`,
      "MEETING_LIBRARY_NAME_INVALID"
    );
  }
  return normalized;
}

export function generateMeetingLibraryCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export class MeetingLibraryAccessService {
  private readonly repository: MeetingLibraryRepository;
  private readonly pepper: string;
  private readonly now: () => Date;
  private readonly codeFactory: () => string;
  private readonly auditIdFactory: () => string;
  private readonly rotatingLibraries = new Set<string>();

  constructor(deps: MeetingLibraryAccessServiceDeps = {}) {
    this.repository = deps.repository ?? meetingLibraryRepository;
    this.pepper = deps.pepper ?? env.MEETING_LIBRARY_CODE_PEPPER;
    this.now = deps.now ?? (() => new Date());
    this.codeFactory = deps.codeFactory ?? generateMeetingLibraryCode;
    this.auditIdFactory = deps.auditIdFactory ?? randomUUID;
  }

  get enabled(): boolean {
    return Buffer.byteLength(this.pepper, "utf8") >= 32;
  }

  initialize(): Promise<void> {
    return this.repository.initialize();
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  async ensureLibrary(libraryId: string, displayNameInput?: unknown): Promise<{
    enabled: boolean;
    library: MeetingLibraryPublicInfo | null;
    code: string | null;
    created: boolean;
  }> {
    this.assertLibraryId(libraryId);
    if (!this.enabled) {
      return { enabled: false, library: null, code: null, created: false };
    }
    await this.repository.initialize();
    const existing = await this.repository.getLibrary(libraryId);
    if (existing) {
      return {
        enabled: true,
        library: toMeetingLibraryPublicInfo(existing),
        code: null,
        created: false,
      };
    }
    const displayName = normalizeMeetingLibraryDisplayName(displayNameInput);

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = normalizeMeetingLibraryCode(this.codeFactory());
      const result = await this.repository.createLibrary({
        libraryId,
        codeDigest: this.digest(code),
        displayName,
        codeHint: formatMeetingLibraryCodeHint(code),
        now: this.now().toISOString(),
      });
      if (!result) continue;
      return {
        enabled: true,
        library: toMeetingLibraryPublicInfo(result.library),
        code: result.created ? formatMeetingLibraryCode(code) : null,
        created: result.created,
      };
    }
    throw new HttpError(
      503,
      "暫時無法建立錄音庫存取碼，請稍後重試。",
      "MEETING_LIBRARY_CODE_GENERATION_FAILED"
    );
  }

  async getOwnerLibrary(libraryId: string): Promise<{
    enabled: boolean;
    library: MeetingLibraryPublicInfo | null;
  }> {
    this.assertLibraryId(libraryId);
    if (!this.enabled) return { enabled: false, library: null };
    const library = await this.repository.getLibrary(libraryId);
    return {
      enabled: true,
      library: library ? toMeetingLibraryPublicInfo(library) : null,
    };
  }

  async authorize(codeInput: unknown): Promise<MeetingLibraryRecord> {
    this.assertEnabled();
    let code: string;
    try {
      code = normalizeMeetingLibraryCode(codeInput);
    } catch {
      throw this.invalidCodeError();
    }
    let library = await this.repository.getLibraryByCodeDigest(this.digest(code));
    if (!library) {
      throw this.invalidCodeError();
    }
    if (!library.codeHint) {
      const backfilled = await this.repository.updateCodeHintIfMissing({
        libraryId: library.libraryId,
        codeDigest: library.codeDigest,
        accessVersion: library.accessVersion,
        codeHint: formatMeetingLibraryCodeHint(code),
      });
      if (!backfilled) throw this.invalidCodeError();
      library = backfilled;
    }
    return library;
  }

  async confirmOwnerCode(
    libraryId: string,
    codeInput: unknown
  ): Promise<MeetingLibraryPublicInfo> {
    this.assertLibraryId(libraryId);
    const library = await this.authorize(codeInput);
    if (library.libraryId !== libraryId) throw this.invalidCodeError();
    return toMeetingLibraryPublicInfo(library);
  }

  async renameLibrary(
    libraryId: string,
    displayNameInput: unknown
  ): Promise<MeetingLibraryPublicInfo> {
    this.assertEnabled();
    this.assertLibraryId(libraryId);
    const displayName = normalizeMeetingLibraryDisplayName(displayNameInput);
    const updated = await this.repository.updateDisplayName({
      libraryId,
      displayName,
      now: this.now().toISOString(),
    });
    if (!updated) {
      throw new HttpError(404, "找不到錄音庫。", "MEETING_LIBRARY_NOT_FOUND");
    }
    return toMeetingLibraryPublicInfo(updated);
  }

  async assertSessionCapabilityActive(
    libraryId: string,
    expectedAccessVersion: number
  ): Promise<void> {
    this.assertLibraryId(libraryId);
    if (
      !this.enabled ||
      !Number.isInteger(expectedAccessVersion) ||
      expectedAccessVersion <= 0
    ) {
      throw new HttpError(
        401,
        "錄音 session 權限已失效。",
        "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED"
      );
    }
    const library = await this.repository.getLibrary(libraryId);
    if (
      !library ||
      library.revokedAt ||
      library.accessVersion !== expectedAccessVersion
    ) {
      throw new HttpError(
        401,
        "錄音 session 權限已失效。",
        "MEETING_RECORDING_SESSION_CAPABILITY_REVOKED"
      );
    }
  }

  rotateCode(libraryId: string): Promise<MeetingLibraryRotationResult> {
    this.assertEnabled();
    this.assertLibraryId(libraryId);
    return this.runRotationExclusive(libraryId, () => this.rotateCodeInternal(libraryId));
  }

  rotateCodeForAdmin(
    libraryId: string,
    input: { adminUsername: string; clientIp: string }
  ): Promise<MeetingLibraryRotationResult> {
    this.assertEnabled();
    this.assertLibraryId(libraryId);
    return this.runRotationExclusive(libraryId, () =>
      this.rotateCodeInternal(libraryId, input)
    );
  }

  private async rotateCodeInternal(
    libraryId: string,
    adminAudit?: { adminUsername: string; clientIp: string }
  ): Promise<MeetingLibraryRotationResult> {
    const existing = await this.repository.getLibrary(libraryId);
    if (!existing) {
      throw new HttpError(404, "找不到錄音庫。", "MEETING_LIBRARY_NOT_FOUND");
    }
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = normalizeMeetingLibraryCode(this.codeFactory());
      const codeDigest = this.digest(code);
      const codeHint = formatMeetingLibraryCodeHint(code);
      if (codeDigest === existing.codeDigest) continue;
      const now = this.now().toISOString();
      const rotated = adminAudit
        ? await this.repository.rotateCodeWithAdminAudit({
              libraryId,
              codeDigest,
              codeHint,
              now,
            audit: {
              auditId: this.auditIdFactory(),
              adminUsername: adminAudit.adminUsername.trim() || "admin",
              action: "rotate-code",
              libraryId,
              sessionId: null,
              clientIp: adminAudit.clientIp.trim() || "unknown",
              createdAt: now,
            },
          })
        : await this.repository.rotateCode({ libraryId, codeDigest, codeHint, now });
      if (!rotated) continue;
      return {
        library: toMeetingLibraryPublicInfo(rotated),
        code: formatMeetingLibraryCode(code),
      };
    }
    throw new HttpError(
      503,
      "暫時無法重設錄音庫存取碼，請稍後重試。",
      "MEETING_LIBRARY_CODE_GENERATION_FAILED"
    );
  }

  async listLibraries(query: string, limit: number): Promise<MeetingLibraryPublicInfo[]> {
    this.assertEnabled();
    const libraries = await this.repository.listLibraries(query, limit);
    return libraries.map(toMeetingLibraryPublicInfo);
  }

  async listAllLibraries(): Promise<MeetingLibraryPublicInfo[]> {
    this.assertEnabled();
    const libraries = await this.repository.listAllLibraries();
    return libraries.map(toMeetingLibraryPublicInfo);
  }

  async getLibraryRecord(libraryId: string): Promise<MeetingLibraryRecord | null> {
    this.assertEnabled();
    this.assertLibraryId(libraryId);
    return this.repository.getLibrary(libraryId);
  }

  async recordAdminAudit(input: {
    adminUsername: string;
    action: MeetingAdminAuditAction;
    libraryId?: string | null;
    sessionId?: string | null;
    clientIp: string;
  }): Promise<void> {
    await this.repository.insertAdminAudit({
      auditId: this.auditIdFactory(),
      adminUsername: input.adminUsername.trim() || "admin",
      action: input.action,
      libraryId: input.libraryId ?? null,
      sessionId: input.sessionId ?? null,
      clientIp: input.clientIp.trim() || "unknown",
      createdAt: this.now().toISOString(),
    });
  }

  private digest(code: string): string {
    return createHmac("sha256", this.pepper)
      .update(`meeting-library-code-v1.${code}`)
      .digest("hex");
  }

  private async runRotationExclusive<T>(
    libraryId: string,
    worker: () => Promise<T>
  ): Promise<T> {
    if (this.rotatingLibraries.has(libraryId)) {
      throw new HttpError(
        409,
        "錄音庫存取碼正在重設，請稍後再試。",
        "MEETING_LIBRARY_CODE_ROTATION_IN_PROGRESS"
      );
    }
    this.rotatingLibraries.add(libraryId);
    try {
      return await worker();
    } finally {
      this.rotatingLibraries.delete(libraryId);
    }
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new HttpError(
        503,
        "錄音庫分享功能尚未啟用。",
        "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED"
      );
    }
  }

  private assertLibraryId(libraryId: string): void {
    if (!LIBRARY_ID_PATTERN.test(libraryId)) {
      throw new ValidationError("錄音庫識別碼不合法。", "MEETING_LIBRARY_ID_INVALID");
    }
  }

  private invalidCodeError(): HttpError {
    return new HttpError(
      401,
      "錄音庫存取碼無效或已失效。",
      "MEETING_LIBRARY_CODE_INVALID"
    );
  }
}

export const meetingLibraryAccessService = new MeetingLibraryAccessService();
