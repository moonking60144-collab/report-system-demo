import { useEffect, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme, message } from "antd";
import {
  changeSystemNoticePassword,
  type SystemNoticeAdminConfig,
} from "../../../api/systemNotice";
import { extractErrorMessage } from "../../../api/apiErrors";

interface Props {
  open: boolean;
  token: string;
  currentUsername: string;
  config: SystemNoticeAdminConfig;
  onClose: () => void;
  /** 改完強制重登 — 改密碼會 clear server tokens，前端要把本地 token 清掉 */
  onChanged: () => void;
}

export function ChangePasswordModal({
  open,
  token,
  currentUsername,
  config,
  onClose,
  onChanged,
}: Props) {
  const [nextUsername, setNextUsername] = useState(currentUsername);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNextUsername(currentUsername);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError(null);
    }
  }, [open, currentUsername]);

  function validate(): string | null {
    if (!currentPassword) return "請輸入目前密碼";
    if (newPassword.length < config.minPasswordLength) {
      return `新密碼至少 ${config.minPasswordLength} 字`;
    }
    if (newPassword !== confirmPassword) return "兩次新密碼不一致";
    if (!nextUsername.trim()) return "username 不可為空";
    return null;
  }

  async function handleSubmit() {
    if (working) return;
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await changeSystemNoticePassword(token, {
        currentPassword,
        newPassword,
        nextUsername: nextUsername.trim(),
      });
      void message.success("帳密已更新，請重新登入");
      onChanged();
      onClose();
    } catch (e) {
      setError(extractErrorMessage(e, "change password failed"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <Modal
        open={open}
        title="修改帳密"
        onCancel={onClose}
        onOk={() => void handleSubmit()}
        okText="儲存"
        cancelText="取消"
        okButtonProps={{ disabled: working }}
        cancelButtonProps={{ disabled: working }}
        destroyOnClose
        centered
      >
        <div className="change-password">
          <label className="change-password__row">
            <span className="change-password__label">username</span>
            <input
              type="text"
              className="change-password__input"
              value={nextUsername}
              onChange={(e) => setNextUsername(e.target.value)}
              disabled={working}
              autoComplete="username"
            />
          </label>
          <label className="change-password__row">
            <span className="change-password__label">目前密碼</span>
            <input
              type="password"
              className="change-password__input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={working}
              autoComplete="current-password"
            />
          </label>
          <label className="change-password__row">
            <span className="change-password__label">
              新密碼（至少 {config.minPasswordLength} 字）
            </span>
            <input
              type="password"
              className="change-password__input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={working}
              autoComplete="new-password"
            />
          </label>
          <label className="change-password__row">
            <span className="change-password__label">確認新密碼</span>
            <input
              type="password"
              className="change-password__input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={working}
              autoComplete="new-password"
            />
          </label>
          {error ? (
            <p className="change-password__error">{error}</p>
          ) : null}
          <p className="change-password__hint">
            注意：儲存後所有現有登入會被中止，需要重新登入。
          </p>
        </div>
      </Modal>
    </ConfigProvider>
  );
}
