import { resolveRequestClientIdentity } from "../infra/requestClientIdentity";

export interface TaskActorContext {
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  actorLabel: string | null;
  workOrderNo: string | null;
}

/**
 * 從 request 收集 actor context：IP、client/tab id、device label、工令號
 * 給 audit log、task registry 等記載使用。
 *
 * 跟 form / feature 無關，故獨立 module；避免 form16 / workReport route 互相依賴。
 */
export function readTaskActorContext(req: {
  ip?: string;
  header(name: string): string | undefined;
}): TaskActorContext {
  const identity = resolveRequestClientIdentity(req);
  const actorClientId = String(req.header("x-debug-client-id") ?? "").trim() || null;
  const actorTabId = String(req.header("x-debug-tab-id") ?? "").trim() || null;
  const actorLabel = String(req.header("x-debug-device-label") ?? "").trim() || null;
  const workOrderNo = String(req.header("x-debug-work-order-no") ?? "").trim() || null;
  return {
    actorClientId,
    actorTabId,
    actorIp: identity.effectiveIp,
    actorLabel,
    workOrderNo,
  };
}
