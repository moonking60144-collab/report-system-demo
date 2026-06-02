import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";

/**
 * Password hashing — scrypt（async，避免阻塞 event loop）+ legacy SHA-256 兼容驗證。
 *
 * 儲存格式：
 *   scrypt$N=<N>,r=<r>,p=<p>$<saltHex>$<keyHex>
 *
 * 驗證時可同時接受：
 *   - 上述 scrypt 格式（新版）
 *   - 64 字 hex（舊版 SHA-256）— legacy=true，呼叫端可順手升級
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

const SCRYPT_PARAMS = {
  N: 131072, // 2^17, OWASP 2024 建議下限
  r: 8,
  p: 1,
  keyLen: 64,
  saltBytes: 16,
} as const;

// Bounds：避免 stored hash 被竄改後 verify 時把 server OOM 或卡死
const MAX_N = 1 << 20; // 2^20
const MAX_R = 32;
const MAX_P = 16;
const MAX_KEY_LEN = 256;
// scrypt N=2^20, r=32, p=16 約需 8GB；用 maxmem 強制 cap 在 256MB
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const SCRYPT_PREFIX = "scrypt$";
const LEGACY_HASH_RE = /^[a-f0-9]{64}$/;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("hashPassword: plain must be a non-empty string");
  }
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const key = await scryptAsync(plain, salt, SCRYPT_PARAMS.keyLen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
  const paramSegment = `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
  return `scrypt$${paramSegment}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export interface VerifyResult {
  ok: boolean;
  /** stored hash 是舊格式（SHA-256 hex），呼叫端可在驗證通過後 lazy migrate 升級 */
  legacy: boolean;
}

export async function verifyPassword(
  plain: string,
  stored: string
): Promise<VerifyResult> {
  if (typeof plain !== "string" || typeof stored !== "string") {
    return { ok: false, legacy: false };
  }
  const trimmed = stored.trim();
  if (trimmed.startsWith(SCRYPT_PREFIX)) {
    const ok = await verifyScrypt(plain, trimmed);
    return { ok, legacy: false };
  }
  const lower = trimmed.toLowerCase();
  if (LEGACY_HASH_RE.test(lower)) {
    return { ok: verifyLegacySha256(plain, lower), legacy: true };
  }
  return { ok: false, legacy: false };
}

async function verifyScrypt(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  // ["scrypt", "N=...,r=...,p=...", "<saltHex>", "<keyHex>"]
  if (parts.length !== 4) return false;
  const params = parseParams(parts[1]);
  if (!params) return false;
  const saltHex = parts[2];
  const keyHex = parts[3];
  if (!saltHex || !keyHex) return false;
  let salt: Buffer;
  let expectedKey: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expectedKey = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expectedKey.length === 0) return false;
  if (expectedKey.length > MAX_KEY_LEN) return false;
  let actualKey: Buffer;
  try {
    actualKey = await scryptAsync(plain, salt, expectedKey.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  if (actualKey.length !== expectedKey.length) return false;
  return timingSafeEqual(actualKey, expectedKey);
}

function verifyLegacySha256(plain: string, expectedHashHex: string): boolean {
  const actualHashHex = createHash("sha256").update(plain, "utf8").digest("hex");
  const expected = Buffer.from(expectedHashHex, "hex");
  const actual = Buffer.from(actualHashHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function parseParams(
  segment: string | undefined
): { N: number; r: number; p: number } | null {
  if (!segment) return null;
  const out: Partial<{ N: number; r: number; p: number }> = {};
  for (const piece of segment.split(",")) {
    const [k, v] = piece.split("=");
    if (!k || !v) return null;
    const num = Number.parseInt(v, 10);
    if (!Number.isFinite(num) || num <= 0) return null;
    if (k === "N") {
      // N 必須是 2 的次方
      if (num > MAX_N || (num & (num - 1)) !== 0) return null;
      out.N = num;
    } else if (k === "r") {
      if (num > MAX_R) return null;
      out.r = num;
    } else if (k === "p") {
      if (num > MAX_P) return null;
      out.p = num;
    } else {
      return null;
    }
  }
  if (
    typeof out.N !== "number" ||
    typeof out.r !== "number" ||
    typeof out.p !== "number"
  ) {
    return null;
  }
  return out as { N: number; r: number; p: number };
}
