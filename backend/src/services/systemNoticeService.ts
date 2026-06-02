import { randomBytes } from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { HttpError } from "../utils/httpError";
import { noticeAdminUsersRepository } from "../storage/sqlite/noticeAdminUsersRepository";
import { hashPassword, verifyPassword } from "./auth/passwordCrypto";

const MAX_ADMIN_USERS = 5;
const MIN_PASSWORD_LENGTH = 6;

export interface SystemNoticeAdminConfig {
  maxUsers: number;
  minPasswordLength: number;
}

export interface NoticeAdminUserView {
  id: number;
  username: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export type SystemNoticeLevel = "info" | "warn" | "error";

export interface SystemNoticeRecord {
  enabled: boolean;
  level: SystemNoticeLevel;
  title: string;
  message: string;
  maintenanceMode: boolean;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  maintenanceSuggested: boolean;
  maintenanceSuggestedReasons: string[];
  startAt: string | null;
  endAt: string | null;
  linkText: string | null;
  linkUrl: string | null;
  updatedAt: string;
  updatedBy: string;
  revision: number;
  forceRefreshToken: string | null;
}

export interface SystemNoticeLoginResult {
  token: string;
  username: string;
  expiresAt: string;
}

export interface SystemNoticeSessionInfo {
  username: string;
  expiresAt: string;
}

export interface SystemNoticeVersionInfo {
  revision: number;
  updatedAt: string;
  forceRefreshToken: string | null;
}

interface TokenSession {
  username: string;
  expiresAtMs: number;
}

type SystemNoticeUpdateInput = Partial<
  Pick<
    SystemNoticeRecord,
    | "enabled"
    | "level"
    | "title"
    | "message"
    | "maintenanceDecision"
    | "startAt"
    | "endAt"
    | "linkText"
    | "linkUrl"
  >
>;

const NOTICE_STORE_VERSION = "v1";
const SYSTEM_NOTICE_LEVELS: ReadonlySet<SystemNoticeLevel> = new Set(["info", "warn", "error"]);

interface SystemNoticeStorePayload {
  version: string;
  savedAt: string;
  notice: SystemNoticeRecord;
}

const DEFAULT_NOTICE: SystemNoticeRecord = {
  enabled: false,
  level: "info",
  title: "系統通知",
  message: "",
  maintenanceMode: false,
  maintenanceDecision: "auto",
  maintenanceSuggested: false,
  maintenanceSuggestedReasons: [],
  startAt: null,
  endAt: null,
  linkText: null,
  linkUrl: null,
  updatedAt: new Date(0).toISOString(),
  updatedBy: "system",
  revision: 0,
  forceRefreshToken: null,
};

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function detectMaintenanceSuggestion(input: {
  title: string;
  message: string;
  linkText: string | null;
}): { suggested: boolean; reasons: string[] } {
  const normalizedText = [input.title, input.message, input.linkText ?? ""]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const compactText = normalizedText
    .replace(/[\s,.:;!?，。：；！？()（）{}\-_/\\]+/g, "")
    .replaceAll("[", "")
    .replaceAll("]", "");
  const reasons = new Set<string>();

  if (compactText.includes("系統維護")) {
    reasons.add("系統維護");
  }
  if (compactText.includes("停機維護")) {
    reasons.add("停機維護");
  }
  if (compactText.includes("systemmaintenance")) {
    reasons.add("system maintenance");
  }
  if (compactText.includes("scheduledmaintenance")) {
    reasons.add("scheduled maintenance");
  }
  if (compactText.includes("plannedmaintenance")) {
    reasons.add("planned maintenance");
  }
  if (compactText.includes("系統升級")) {
    reasons.add("系統升級");
  }
  if (compactText.includes("系統更新")) {
    reasons.add("系統更新");
  }
  if (compactText.includes("systemupgrade")) {
    reasons.add("system upgrade");
  }
  if (compactText.includes("systemupdate")) {
    reasons.add("system update");
  }

  const hasSystemKeyword =
    compactText.includes("系統") ||
    compactText.includes("伺服器") ||
    compactText.includes("後端") ||
    compactText.includes("服務") ||
    normalizedText.includes("system") ||
    normalizedText.includes("server") ||
    normalizedText.includes("backend") ||
    normalizedText.includes("service");
  const hasMaintenanceKeyword =
    compactText.includes("維護") ||
    compactText.includes("升級") ||
    compactText.includes("更新") ||
    compactText.includes("停機") ||
    compactText.includes("重啟") ||
    compactText.includes("修復") ||
    normalizedText.includes("maintenance") ||
    normalizedText.includes("upgrade") ||
    normalizedText.includes("updating") ||
    normalizedText.includes("deploy") ||
    normalizedText.includes("deployment") ||
    normalizedText.includes("restart") ||
    normalizedText.includes("downtime") ||
    normalizedText.includes("unavailable");

  if (hasSystemKeyword && hasMaintenanceKeyword) {
    reasons.add("system+maintenance");
  }

  return {
    suggested: reasons.size > 0,
    reasons: Array.from(reasons),
  };
}

class SystemNoticeService {
  private notice: SystemNoticeRecord = { ...DEFAULT_NOTICE };
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly tokenSessions = new Map<string, TokenSession>();

  async getNotice(): Promise<SystemNoticeRecord> {
    await this.ensureLoaded();
    return { ...this.notice };
  }

  async getNoticeVersion(): Promise<SystemNoticeVersionInfo> {
    await this.ensureLoaded();
    return {
      revision: this.notice.revision,
      updatedAt: this.notice.updatedAt,
      forceRefreshToken: this.notice.forceRefreshToken,
    };
  }

  async login(
    usernameInput: unknown,
    passwordInput: unknown
  ): Promise<SystemNoticeLoginResult> {
    await this.assertAuthConfigured();
    this.cleanupExpiredSessions();

    const username = String(usernameInput ?? "").trim();
    const password = typeof passwordInput === "string" ? passwordInput : "";
    const credentials = await this.resolveCredentialsByUsername(username);

    if (!credentials) {
      throw new HttpError(401, "帳號或密碼錯誤", "NOTICE_LOGIN_INVALID");
    }
    const verified = await verifyPassword(password, credentials.passwordHash);
    if (!verified.ok) {
      throw new HttpError(401, "帳號或密碼錯誤", "NOTICE_LOGIN_INVALID");
    }

    // Lazy migration: SQLite 裡的舊 SHA-256 hash 在登入成功時自動升級為 scrypt
    if (verified.legacy && !credentials.isEnvFallback) {
      try {
        const upgraded = await hashPassword(password);
        await noticeAdminUsersRepository.updatePassword({
          username: credentials.username,
          passwordHash: upgraded,
        });
      } catch (error) {
        console.warn("[system-notice][password-upgrade-failed]", {
          username: credentials.username,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const expiresAtMs = Date.now() + env.NOTICE_TOKEN_TTL_MINUTES * 60 * 1000;
    const token = randomBytes(32).toString("hex");
    this.tokenSessions.set(token, {
      username: credentials.username,
      expiresAtMs,
    });

    return {
      token,
      username: credentials.username,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * 自己改自己的帳密。需先驗證 currentPassword 正確。
   * 改完後該使用者的所有 token 失效（重登）。
   */
  async changePassword(input: {
    currentPassword: string;
    newPassword: string;
    nextUsername?: string;
    actor: string;
  }): Promise<{ username: string; updatedAt: string }> {
    await this.assertAuthConfigured();
    const credentials = await this.resolveCredentialsByUsername(input.actor);
    if (!credentials) {
      throw new HttpError(401, "目前密碼錯誤", "NOTICE_PASSWORD_INVALID");
    }
    const currentVerified = await verifyPassword(
      input.currentPassword,
      credentials.passwordHash
    );
    if (!currentVerified.ok) {
      throw new HttpError(401, "目前密碼錯誤", "NOTICE_PASSWORD_INVALID");
    }
    if (typeof input.newPassword !== "string" || input.newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(
        400,
        `新密碼長度至少 ${MIN_PASSWORD_LENGTH} 字`,
        "NOTICE_PASSWORD_TOO_SHORT"
      );
    }
    const nextUsername = (input.nextUsername ?? credentials.username).trim();
    if (!nextUsername) {
      throw new HttpError(400, "username 不可為空", "NOTICE_USERNAME_REQUIRED");
    }
    const newHash = await hashPassword(input.newPassword);

    if (credentials.isEnvFallback) {
      // env-only mode：改密碼 = 把 env 那位「複製」進 users 表（之後 env fallback 就不再生效）
      // 換 username 也允許
      await noticeAdminUsersRepository.create({
        username: nextUsername,
        passwordHash: newHash,
        createdBy: "self-change-from-env",
      });
    } else {
      // SQLite-backed user：直接 update
      // 若改了 username 要避免撞到別的 user
      if (nextUsername !== credentials.username) {
        const conflict = await noticeAdminUsersRepository.findByUsername(nextUsername);
        if (conflict) {
          throw new HttpError(
            409,
            `使用者名稱 ${nextUsername} 已存在`,
            "NOTICE_USERNAME_EXISTS"
          );
        }
      }
      await noticeAdminUsersRepository.updateProfile({
        currentUsername: credentials.username,
        nextUsername,
        passwordHash: newHash,
      });
    }

    // 把該使用者所有 session 清掉，強制重登
    for (const [token, session] of this.tokenSessions.entries()) {
      if (session.username === credentials.username || session.username === nextUsername) {
        this.tokenSessions.delete(token);
      }
    }
    return { username: nextUsername, updatedAt: new Date().toISOString() };
  }

  // === 多使用者管理（admin 操作）===

  getAdminConfig(): SystemNoticeAdminConfig {
    return {
      maxUsers: MAX_ADMIN_USERS,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  }

  async listUsers(): Promise<NoticeAdminUserView[]> {
    const users = await noticeAdminUsersRepository.list();
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      createdBy: u.createdBy,
    }));
  }

  async createUser(input: {
    username: string;
    password: string;
    actor: string;
  }): Promise<NoticeAdminUserView> {
    const username = input.username.trim();
    if (!username) {
      throw new HttpError(400, "username 不可為空", "NOTICE_USERNAME_REQUIRED");
    }
    if (
      typeof input.password !== "string" ||
      input.password.length < MIN_PASSWORD_LENGTH
    ) {
      throw new HttpError(
        400,
        `密碼長度至少 ${MIN_PASSWORD_LENGTH} 字`,
        "NOTICE_PASSWORD_TOO_SHORT"
      );
    }
    // 若 actor 是 env-fallback 身分（SQLite 還沒任何 user），先把 actor 自己
    // 持久化進 users 表 — 否則新 user 一寫進去就讓 count > 0，env-fallback 死掉
    // → 原本能登入的 admin 帳號突然無法登入。
    await this.persistEnvFallbackActorIfNeeded(input.actor);

    const count = await noticeAdminUsersRepository.count();
    // 上限要把剛剛 persist 的 actor 也算進去
    if (count >= MAX_ADMIN_USERS) {
      throw new HttpError(
        409,
        `管理員上限 ${MAX_ADMIN_USERS} 位`,
        "NOTICE_USER_LIMIT_REACHED"
      );
    }
    const existing = await noticeAdminUsersRepository.findByUsername(username);
    if (existing) {
      throw new HttpError(
        409,
        `使用者名稱 ${username} 已存在`,
        "NOTICE_USERNAME_EXISTS"
      );
    }
    const passwordHash = await hashPassword(input.password);
    const created = await noticeAdminUsersRepository.create({
      username,
      passwordHash,
      createdBy: input.actor,
    });
    return {
      id: created.id,
      username: created.username,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      createdBy: created.createdBy,
    };
  }

  async deleteUser(input: { username: string; actor: string }): Promise<void> {
    const username = input.username.trim();
    if (!username) {
      throw new HttpError(400, "username 不可為空", "NOTICE_USERNAME_REQUIRED");
    }
    if (username === input.actor) {
      throw new HttpError(400, "不能刪除自己", "NOTICE_CANNOT_DELETE_SELF");
    }
    const count = await noticeAdminUsersRepository.count();
    if (count <= 1) {
      throw new HttpError(
        400,
        "至少要保留一位管理員",
        "NOTICE_LAST_USER_PROTECTED"
      );
    }
    const ok = await noticeAdminUsersRepository.delete(username);
    if (!ok) {
      throw new HttpError(404, `找不到使用者 ${username}`, "NOTICE_USER_NOT_FOUND");
    }
    // 把該使用者的所有 session 清掉
    for (const [token, session] of this.tokenSessions.entries()) {
      if (session.username === username) {
        this.tokenSessions.delete(token);
      }
    }
  }

  /**
   * env-fallback 身分（admin 透過 env 登入）在第一次新增其他帳號時，
   * 必須把 actor 自己也持久化進 SQLite。否則只要 users 表 count > 0，
   * env-fallback 就被關閉、原本的 admin 就消失了。
   *
   * 條件全中才執行：actor 不是空的、users 表沒這個 user、env 設定齊全、
   * actor 名稱跟 env 設的相符。其他情境 no-op。
   */
  private async persistEnvFallbackActorIfNeeded(actor: string): Promise<void> {
    const trimmed = actor?.trim();
    if (!trimmed) return;
    const existing = await noticeAdminUsersRepository.findByUsername(trimmed);
    if (existing) return;
    const envUsername = env.NOTICE_ADMIN_USERNAME.trim();
    const envHash = env.NOTICE_ADMIN_PASSWORD_HASH.trim().toLowerCase();
    if (!envUsername || !envHash) return;
    if (trimmed !== envUsername) return;
    // 用 env 的 SHA-256 hash 直接寫進去；下次 actor 登入時會走 lazy-migrate
    // 升級為 scrypt
    await noticeAdminUsersRepository.create({
      username: envUsername,
      passwordHash: envHash,
      createdBy: "auto-persisted-from-env",
    });
  }

  /**
   * 用 username 找對應的密碼 hash：
   *   1. 先查 notice_admin_users 表
   *   2. 沒命中且 username 跟 env.NOTICE_ADMIN_USERNAME 一致 → fallback env
   *   3. 否則 null（找不到使用者）
   */
  private async resolveCredentialsByUsername(username: string): Promise<{
    username: string;
    passwordHash: string;
    isEnvFallback: boolean;
  } | null> {
    const trimmed = username.trim();
    if (!trimmed) return null;
    const user = await noticeAdminUsersRepository.findByUsername(trimmed);
    if (user) {
      return {
        username: user.username,
        passwordHash: user.passwordHash,
        isEnvFallback: false,
      };
    }
    const envUsername = env.NOTICE_ADMIN_USERNAME.trim();
    if (envUsername && trimmed === envUsername) {
      // 沒任何 SQLite user 才允許 env fallback；有 user 但密碼錯不該 fallback
      const usersCount = await noticeAdminUsersRepository.count();
      if (usersCount === 0) {
        return {
          username: envUsername,
          passwordHash: env.NOTICE_ADMIN_PASSWORD_HASH.trim().toLowerCase(),
          isEnvFallback: true,
        };
      }
    }
    return null;
  }

  verifyToken(tokenInput: unknown): SystemNoticeSessionInfo {
    // 只驗 token 本身，不再 call assertAuthConfigured（已改 async；
    // 沒設定 admin 帳密的環境下，sessions map 必然空，verifyToken 自己就會 throw）
    this.cleanupExpiredSessions();

    const token = String(tokenInput ?? "").trim();
    if (!token) {
      throw new HttpError(401, "缺少通知管理授權 token", "NOTICE_TOKEN_MISSING");
    }

    const session = this.tokenSessions.get(token);
    if (!session) {
      throw new HttpError(401, "通知管理授權已失效，請重新登入", "NOTICE_TOKEN_INVALID");
    }

    return {
      username: session.username,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
  }

  async updateNotice(
    payloadInput: unknown,
    updatedBy: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<SystemNoticeRecord> {
    await this.ensureLoaded();
    const payload = this.normalizePayload(payloadInput);
    const nextNotice = this.buildNextNotice(payload, updatedBy, options);
    this.notice = nextNotice;
    this.schedulePersist();
    return { ...nextNotice };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as SystemNoticeStorePayload;
      if (this.isValidStorePayload(parsed)) {
        this.notice = this.normalizeLoadedNotice(parsed.notice);
      } else {
        console.warn("[system-notice][invalid-payload]", { filePath });
      }
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code !== "ENOENT") {
        console.warn("[system-notice][load-failed]", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.loaded = true;
      if (!this.notice.updatedAt) {
        this.notice.updatedAt = new Date().toISOString();
      }
    }
  }

  private normalizePayload(payloadInput: unknown): SystemNoticeUpdateInput {
    if (!payloadInput || typeof payloadInput !== "object" || Array.isArray(payloadInput)) {
      throw new HttpError(400, "通知更新資料格式錯誤", "NOTICE_PAYLOAD_INVALID");
    }
    return payloadInput as SystemNoticeUpdateInput;
  }

  private buildNextNotice(
    payload: SystemNoticeUpdateInput,
    updatedBy: string,
    options: { forceRefresh?: boolean }
  ): SystemNoticeRecord {
    const nextEnabled =
      payload.enabled === undefined ? this.notice.enabled : this.parseBoolean(payload.enabled, "enabled");
    const nextLevel =
      payload.level === undefined ? this.notice.level : this.parseLevel(payload.level);
    const nextTitle =
      payload.title === undefined ? this.notice.title : this.parseRequiredString(payload.title, "title");
    const nextMessage =
      payload.message === undefined
        ? this.notice.message
        : this.parseOptionalString(payload.message, "message", false) ?? "";
    const nextMaintenanceDecision =
      payload.maintenanceDecision === undefined
        ? this.notice.maintenanceDecision
        : this.parseMaintenanceDecision(payload.maintenanceDecision);
    const nextStartAt =
      payload.startAt === undefined ? this.notice.startAt : this.parseDateTime(payload.startAt, "startAt");
    const nextEndAt =
      payload.endAt === undefined ? this.notice.endAt : this.parseDateTime(payload.endAt, "endAt");
    const nextLinkText =
      payload.linkText === undefined
        ? this.notice.linkText
        : this.parseOptionalString(payload.linkText, "linkText", true);
    const nextLinkUrl =
      payload.linkUrl === undefined ? this.notice.linkUrl : this.parseLinkUrl(payload.linkUrl);

    if (nextStartAt && nextEndAt && Date.parse(nextEndAt) < Date.parse(nextStartAt)) {
      throw new HttpError(400, "通知結束時間不得早於開始時間", "NOTICE_RANGE_INVALID");
    }

    if (nextEnabled && !nextMessage) {
      throw new HttpError(400, "啟用通知時，message 不可為空", "NOTICE_MESSAGE_REQUIRED");
    }

    const maintenanceSuggestion = detectMaintenanceSuggestion({
      title: nextTitle,
      message: nextMessage,
      linkText: nextLinkText,
    });
    const nextMaintenanceMode =
      nextMaintenanceDecision === "manual-on"
        ? true
        : nextMaintenanceDecision === "manual-off"
          ? false
          : maintenanceSuggestion.suggested;

    const normalizedUpdatedBy = updatedBy.trim() || "admin";
    const shouldForceRefresh = options.forceRefresh === true;
    return {
      enabled: nextEnabled,
      level: nextLevel,
      title: nextTitle,
      message: nextMessage,
      maintenanceMode: nextMaintenanceMode,
      maintenanceDecision: nextMaintenanceDecision,
      maintenanceSuggested: maintenanceSuggestion.suggested,
      maintenanceSuggestedReasons: maintenanceSuggestion.reasons,
      startAt: nextStartAt,
      endAt: nextEndAt,
      linkText: nextLinkText,
      linkUrl: nextLinkUrl,
      updatedAt: new Date().toISOString(),
      updatedBy: normalizedUpdatedBy,
      revision: this.notice.revision + 1,
      forceRefreshToken: shouldForceRefresh
        ? `fr-${Date.now()}-${randomBytes(8).toString("hex")}`
        : this.notice.forceRefreshToken,
    };
  }

  private normalizeLoadedNotice(rawNotice: Partial<SystemNoticeRecord>): SystemNoticeRecord {
    const revisionCandidate = Number(rawNotice.revision);
    const normalizedRevision =
      Number.isFinite(revisionCandidate) && revisionCandidate >= 0
        ? Math.trunc(revisionCandidate)
        : 0;
    const forceRefreshTokenCandidate =
      typeof rawNotice.forceRefreshToken === "string"
        ? rawNotice.forceRefreshToken.trim()
        : "";
    const normalizedMaintenanceDecision =
      rawNotice.maintenanceDecision === "manual-on" ||
      rawNotice.maintenanceDecision === "manual-off" ||
      rawNotice.maintenanceDecision === "auto"
        ? rawNotice.maintenanceDecision
        : "auto";
    const normalizedMaintenanceSuggestedReasons = Array.isArray(
      rawNotice.maintenanceSuggestedReasons
    )
      ? rawNotice.maintenanceSuggestedReasons
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const derivedSuggestion = detectMaintenanceSuggestion({
      title: typeof rawNotice.title === "string" ? rawNotice.title : DEFAULT_NOTICE.title,
      message: typeof rawNotice.message === "string" ? rawNotice.message : DEFAULT_NOTICE.message,
      linkText: typeof rawNotice.linkText === "string" ? rawNotice.linkText : null,
    });
    const normalizedMaintenanceSuggested =
      rawNotice.maintenanceSuggested === true ||
      (rawNotice.maintenanceSuggested !== false && derivedSuggestion.suggested);
    const nextMaintenanceMode =
      normalizedMaintenanceDecision === "manual-on"
        ? true
        : normalizedMaintenanceDecision === "manual-off"
          ? false
          : normalizedMaintenanceSuggested;

    return {
      ...DEFAULT_NOTICE,
      ...rawNotice,
      maintenanceMode: nextMaintenanceMode,
      maintenanceDecision: normalizedMaintenanceDecision,
      maintenanceSuggested: normalizedMaintenanceSuggested,
      maintenanceSuggestedReasons:
        normalizedMaintenanceSuggestedReasons.length > 0
          ? normalizedMaintenanceSuggestedReasons
          : derivedSuggestion.reasons,
      revision: normalizedRevision,
      forceRefreshToken: forceRefreshTokenCandidate || null,
    };
  }

  private parseBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    throw new HttpError(400, `欄位 ${fieldName} 必須為 boolean`, "NOTICE_FIELD_INVALID");
  }

  private parseLevel(value: unknown): SystemNoticeLevel {
    const normalized = String(value ?? "").trim() as SystemNoticeLevel;
    if (!SYSTEM_NOTICE_LEVELS.has(normalized)) {
      throw new HttpError(
        400,
        "欄位 level 必須為 info / warn / error",
        "NOTICE_LEVEL_INVALID"
      );
    }
    return normalized;
  }

  private parseRequiredString(value: unknown, fieldName: string): string {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      throw new HttpError(400, `欄位 ${fieldName} 不可為空`, "NOTICE_FIELD_REQUIRED");
    }
    return normalized;
  }

  private parseOptionalString(value: unknown, fieldName: string, allowNull: boolean): string | null {
    if (value === null && allowNull) {
      return null;
    }
    const normalized = String(value ?? "").trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseMaintenanceDecision(
    value: unknown
  ): "auto" | "manual-on" | "manual-off" {
    const normalized = String(value ?? "").trim();
    if (
      normalized !== "auto" &&
      normalized !== "manual-on" &&
      normalized !== "manual-off"
    ) {
      throw new HttpError(
        400,
        "欄位 maintenanceDecision 必須為 auto / manual-on / manual-off",
        "NOTICE_MAINTENANCE_DECISION_INVALID"
      );
    }
    return normalized;
  }

  private parseDateTime(value: unknown, fieldName: string): string | null {
    if (value === null) {
      return null;
    }
    const raw = String(value ?? "").trim();
    if (!raw) {
      return null;
    }
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) {
      throw new HttpError(400, `欄位 ${fieldName} 時間格式錯誤`, "NOTICE_DATETIME_INVALID");
    }
    return new Date(timestamp).toISOString();
  }

  private parseLinkUrl(value: unknown): string | null {
    if (value === null) {
      return null;
    }
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      return null;
    }
    if (!isSafeHttpUrl(normalized)) {
      throw new HttpError(
        400,
        "欄位 linkUrl 必須為 http/https 網址",
        "NOTICE_LINK_URL_INVALID"
      );
    }
    return normalized;
  }

  private async assertAuthConfigured(): Promise<void> {
    // 多 user 表有資料 → OK；否則 fallback env vars
    const userCount = await noticeAdminUsersRepository.count();
    if (userCount > 0) return;

    // env.ts 在 DEMO_MODE=true 時會自動把 NOTICE_ADMIN_USERNAME/HASH 填成 demo / sha256("demo")，
    // 走到這裡兩個 env 已經有值，不會 throw。這層額外 fallback 是兜底：
    // 萬一 env.ts 注入順序未來變動或 dotenv 載入失敗，仍能保證 DEMO_MODE 可登入。
    if (env.DEMO_MODE) {
      if (!env.NOTICE_ADMIN_USERNAME.trim() || !env.NOTICE_ADMIN_PASSWORD_HASH.trim()) {
        // 直接覆蓋 process.env 已晚了（env 物件是 frozen 結構），這裡記 warn 提醒
        console.warn(
          "[system-notice][demo-mode] NOTICE_ADMIN_USERNAME/HASH 在 DEMO_MODE 下竟為空，" +
            "請檢查 config/env.ts 注入順序"
        );
      }
      return;
    }

    if (!env.NOTICE_ADMIN_USERNAME.trim() || !env.NOTICE_ADMIN_PASSWORD_HASH.trim()) {
      throw new HttpError(
        503,
        "系統通知管理尚未設定管理帳密（NOTICE_ADMIN_USERNAME / NOTICE_ADMIN_PASSWORD_HASH）",
        "NOTICE_AUTH_NOT_CONFIGURED"
      );
    }
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.tokenSessions.entries()) {
      if (session.expiresAtMs <= now) {
        this.tokenSessions.delete(token);
      }
    }
  }

  private isValidStorePayload(payload: unknown): payload is SystemNoticeStorePayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const parsed = payload as SystemNoticeStorePayload;
    if (parsed.version !== NOTICE_STORE_VERSION) {
      return false;
    }
    const notice = parsed.notice as Partial<SystemNoticeRecord> | undefined;
    if (!notice || typeof notice !== "object") {
      return false;
    }
    return (
      typeof notice.enabled === "boolean" &&
      typeof notice.level === "string" &&
      SYSTEM_NOTICE_LEVELS.has(notice.level as SystemNoticeLevel) &&
      typeof notice.title === "string" &&
      typeof notice.message === "string" &&
      typeof notice.maintenanceMode === "boolean" &&
      (notice.maintenanceDecision === "auto" ||
        notice.maintenanceDecision === "manual-on" ||
        notice.maintenanceDecision === "manual-off") &&
      typeof notice.maintenanceSuggested === "boolean" &&
      Array.isArray(notice.maintenanceSuggestedReasons) &&
      notice.maintenanceSuggestedReasons.every((value) => typeof value === "string") &&
      (notice.startAt === null || typeof notice.startAt === "string") &&
      (notice.endAt === null || typeof notice.endAt === "string") &&
      (notice.linkText === null || typeof notice.linkText === "string") &&
      (notice.linkUrl === null || typeof notice.linkUrl === "string") &&
      typeof notice.updatedAt === "string" &&
      typeof notice.updatedBy === "string" &&
      (notice.revision === undefined || typeof notice.revision === "number") &&
      (notice.forceRefreshToken === undefined ||
        notice.forceRefreshToken === null ||
        typeof notice.forceRefreshToken === "string")
    );
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .catch(() => {
        // NOTE: keep chain alive
      })
      .then(async () => {
        await this.persistToDisk();
      })
      .catch((error) => {
        console.warn("[system-notice][save-failed]", {
          filePath: this.resolveStoreFilePath(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async persistToDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: SystemNoticeStorePayload = {
      version: NOTICE_STORE_VERSION,
      savedAt: new Date().toISOString(),
      notice: this.notice,
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  }

  private resolveStoreFilePath(): string {
    return path.resolve(env.SYSTEM_NOTICE_FILE);
  }
}

export const systemNoticeService = new SystemNoticeService();
