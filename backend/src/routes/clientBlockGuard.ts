import type { Request } from "express";
import { resolveRequestClientIdentity } from "../infra/requestClientIdentity";
import { workReportClientPresenceStore } from "../observability/workReportClientPresenceStore";
import { HttpError } from "../utils/httpError";

function readHeaderValue(req: Request, name: string): string | null {
  const value = String(req.header(name) ?? "").trim();
  return value || null;
}

export function assertClientNotBlocked(req: Request): void {
  const identity = resolveRequestClientIdentity(req);
  const status = workReportClientPresenceStore.getBlockedStatus({
    clientId: readHeaderValue(req, "x-debug-client-id"),
    tabId: readHeaderValue(req, "x-debug-tab-id"),
    effectiveIp: identity.effectiveIp,
  });

  if (!status.blocked) {
    return;
  }

  throw new HttpError(
    423,
    status.reason
      ? `此裝置已被管理端暫停操作：${status.reason}`
      : "此裝置已被管理端暫停操作",
    "CLIENT_BLOCKED"
  );
}
