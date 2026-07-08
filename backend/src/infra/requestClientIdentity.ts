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
  const realIp = String(req.header("x-real-ip") ?? "").trim() || null;
  const userAgent = String(req.header("user-agent") ?? "").trim() || null;
  const ip = String(req.ip ?? "").trim() || realIp || null;
  return {
    effectiveIp: ip || realIp || null,
    ip,
    forwardedFor,
    realIp,
    userAgent,
  };
}
