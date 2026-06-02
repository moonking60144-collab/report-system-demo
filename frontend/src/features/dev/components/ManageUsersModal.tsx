import { useCallback, useEffect, useState } from "react";
import { Modal, ConfigProvider, theme as antdTheme, message } from "antd";
import {
  createSystemNoticeUser,
  deleteSystemNoticeUser,
  listSystemNoticeUsers,
  type SystemNoticeAdminConfig,
  type SystemNoticeAdminUser,
} from "../../../api/systemNotice";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";

interface Props {
  open: boolean;
  token: string;
  /** 目前登入的 username（不能刪自己） */
  currentUsername: string;
  /** 後端常數（max users / 密碼長度），由 panel 統一拉一次後傳下來 */
  config: SystemNoticeAdminConfig;
  onClose: () => void;
  /** 401 時通知 parent → re-login */
  onAuthFailure: () => void;
}

export function ManageUsersModal({
  open,
  token,
  currentUsername,
  config,
  onClose,
  onAuthFailure,
}: Props) {
  const MAX_USERS = config.maxUsers;
  const MIN_PASSWORD_LENGTH = config.minPasswordLength;
  const [users, setUsers] = useState<SystemNoticeAdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ username: "", password: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingUsername, setDeletingUsername] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await listSystemNoticeUsers(token);
      setUsers(data);
    } catch (error) {
      if (isUnauthorized(error)) {
        onAuthFailure();
        return;
      }
      setLoadError(extractErrorMessage(error, "讀取使用者列表失敗"));
    } finally {
      setLoading(false);
    }
  }, [token, onAuthFailure]);

  useEffect(() => {
    if (open) {
      void reload();
      setDraft({ username: "", password: "" });
      setCreateError(null);
    }
  }, [open, reload]);

  async function handleCreate() {
    if (creating) return;
    const username = draft.username.trim();
    const password = draft.password;
    if (!username) {
      setCreateError("username 不可為空");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setCreateError(`密碼至少 ${MIN_PASSWORD_LENGTH} 字`);
      return;
    }
    if (users.length >= MAX_USERS) {
      setCreateError(`已達上限 ${MAX_USERS} 個帳號`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createSystemNoticeUser(token, { username, password });
      void message.success(`已新增 ${username}`);
      setDraft({ username: "", password: "" });
      await reload();
    } catch (error) {
      if (isUnauthorized(error)) {
        onAuthFailure();
        return;
      }
      setCreateError(extractErrorMessage(error, "新增帳號失敗"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(username: string) {
    if (deletingUsername) return;
    if (username === currentUsername) {
      void message.warning("不能刪除自己");
      return;
    }
    if (users.length <= 1) {
      void message.warning("至少要保留一個管理者");
      return;
    }
    Modal.confirm({
      title: `刪除帳號 ${username}？`,
      content: "刪除後該帳號將無法登入開發者模式。此動作不可復原。",
      okText: "刪除",
      okType: "danger",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        setDeletingUsername(username);
        try {
          await deleteSystemNoticeUser(token, username);
          void message.success(`已刪除 ${username}`);
          await reload();
        } catch (error) {
          if (isUnauthorized(error)) {
            onAuthFailure();
            return;
          }
          void message.error(extractErrorMessage(error, "刪除失敗"));
        } finally {
          setDeletingUsername(null);
        }
      },
    });
  }

  return (
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}>
      <Modal
        open={open}
        onCancel={onClose}
        title="帳號管理"
        footer={null}
        width={560}
        destroyOnClose
        centered
      >
        <div className="manage-users">
          <div className="manage-users__summary">
            目前共 <strong>{users.length}</strong> / {MAX_USERS} 個管理者帳號
          </div>

          {loadError ? (
            <p className="manage-users__error">{loadError}</p>
          ) : null}

          <div className="manage-users__list">
            {loading && users.length === 0 ? (
              <p className="manage-users__hint">載入中…</p>
            ) : users.length === 0 ? (
              <p className="manage-users__hint">沒有帳號</p>
            ) : (
              <table className="manage-users__table">
                <thead>
                  <tr>
                    <th>username</th>
                    <th>建立時間</th>
                    <th>建立者</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const isSelf = u.username === currentUsername;
                    const last = users.length <= 1;
                    const disabled = isSelf || last || deletingUsername === u.username;
                    return (
                      <tr key={u.id}>
                        <td className="manage-users__td-name">
                          <span className="manage-users__td-name-inner">
                            {u.username}
                            {isSelf ? (
                              <span className="manage-users__badge">自己</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="manage-users__td-time">
                          {formatTime(u.createdAt)}
                        </td>
                        <td className="manage-users__td-actor">
                          {u.createdBy ?? "—"}
                        </td>
                        <td className="manage-users__td-action">
                          <button
                            type="button"
                            className="manage-users__delete-btn"
                            onClick={() => void handleDelete(u.username)}
                            disabled={disabled}
                            title={
                              isSelf
                                ? "不能刪除自己"
                                : last
                                  ? "至少保留一個帳號"
                                  : "刪除此帳號"
                            }
                          >
                            {deletingUsername === u.username ? "刪除中…" : "刪除"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="manage-users__create">
            <strong className="manage-users__create-title">新增帳號</strong>
            <form
              className="manage-users__create-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
            >
              <input
                type="text"
                className="manage-users__input"
                placeholder="username"
                value={draft.username}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, username: e.target.value }))
                }
                disabled={creating || users.length >= MAX_USERS}
                autoComplete="off"
              />
              <input
                type="password"
                className="manage-users__input"
                placeholder={`password (至少 ${MIN_PASSWORD_LENGTH} 字)`}
                value={draft.password}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, password: e.target.value }))
                }
                disabled={creating || users.length >= MAX_USERS}
                autoComplete="new-password"
              />
              <button
                type="submit"
                className="manage-users__create-btn"
                disabled={creating || users.length >= MAX_USERS}
              >
                {creating ? "新增中…" : "新增"}
              </button>
            </form>
            {createError ? (
              <p className="manage-users__error">{createError}</p>
            ) : null}
            {users.length >= MAX_USERS ? (
              <p className="manage-users__hint">
                已達上限，無法再新增。請先刪除其他帳號。
              </p>
            ) : null}
          </div>
        </div>
      </Modal>
    </ConfigProvider>
  );
}

function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
