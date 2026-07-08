import { useOutletContext } from "react-router-dom";
import type { SystemNoticeAdminConfig } from "../../../api/systemNotice";
import { useRagicFieldIndexState } from "../hooks/useRagicFieldIndexState";

// DevLayout 持有 auth token 與單一份 Ragic state（避免 dual polling），
// 透過 react-router 的 Outlet context 往各 view 傳，view 用 useDevContext() 取。
export interface DevContextValue {
  token: string;
  username: string;
  adminConfig: SystemNoticeAdminConfig;
  ragic: ReturnType<typeof useRagicFieldIndexState>;
  onAuthFailure: (reason: string) => void;
}

export function useDevContext(): DevContextValue {
  return useOutletContext<DevContextValue>();
}
