export interface RequestClientIdentity {
  effectiveIp: string | null;
  ip: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  userAgent: string | null;
}

export function resolveRequestClientIdentity(req: {
  ip?: string;
  header(name: string): string | undefined;
}): RequestClientIdentity {
  const forwardedForRaw = String(req.header("x-forwarded-for") ?? "").trim();
  const forwardedFor = forwardedForRaw || null;
  const forwardedClientIp =
    forwardedForRaw
      .split(",")
      .map((item) => item.trim())
      .find(Boolean) ?? null;
  const realIp = String(req.header("x-real-ip") ?? "").trim() || null;
  const userAgent = String(req.header("user-agent") ?? "").trim() || null;
  const ip = String(req.ip ?? "").trim() || realIp || forwardedClientIp || null;
  return {
    effectiveIp: forwardedClientIp || realIp || ip || null,
    ip,
    forwardedFor,
    realIp,
    userAgent,
  };
}
