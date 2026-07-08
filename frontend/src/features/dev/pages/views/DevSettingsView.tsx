import { useState } from "react";
import { ChangePasswordModal } from "../../components/ChangePasswordModal";
import { ManageUsersModal } from "../../components/ManageUsersModal";
import { useDevContext } from "../../layout/devContext";

export function DevSettingsView() {
  const { token, username, adminConfig, onAuthFailure } = useDevContext();
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [manageUsersOpen, setManageUsersOpen] = useState(false);
  return (
    <section className="dev-mode-account">
      <strong className="dev-mode-section-title">account</strong>
      <div className="dev-mode-account-row">
        <span className="dev-mode-account-label">logged in as</span>
        <code className="dev-mode-account-username">{username}</code>
        <button type="button" className="dev-mode-btn" onClick={() => setChangePwdOpen(true)}>
          修改帳密
        </button>
        <button type="button" className="dev-mode-btn" onClick={() => setManageUsersOpen(true)}>
          帳號管理
        </button>
      </div>

      <ChangePasswordModal
        open={changePwdOpen}
        token={token}
        currentUsername={username}
        config={adminConfig}
        onClose={() => setChangePwdOpen(false)}
        onChanged={() => {
          // 改完帳密後伺服器會清掉所有 token → 強制重新登入
          onAuthFailure("帳密已更新，請重新登入");
        }}
      />

      <ManageUsersModal
        open={manageUsersOpen}
        token={token}
        currentUsername={username}
        config={adminConfig}
        onClose={() => setManageUsersOpen(false)}
        onAuthFailure={() => onAuthFailure("session expired, please login again")}
      />
    </section>
  );
}
