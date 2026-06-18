import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/dev-panel.css";
import {
  fetchSystemNoticeAdminConfig,
  fetchSystemNoticeSession,
  loginSystemNotice,
  type SystemNoticeAdminConfig,
} from "../../../api/systemNotice";
import {
  readSystemNoticeAdminToken,
  writeSystemNoticeAdminToken,
} from "../auth/systemNoticeAdminSession";
import { useRagicFieldIndexState } from "../hooks/useRagicFieldIndexState";
import { ChangePasswordModal } from "./ChangePasswordModal";
import { ManageUsersModal } from "./ManageUsersModal";
import { RagicFieldInlineSearch } from "./RagicFieldInlineSearch";
import { RagicFormDetailModal } from "./RagicFormDetailModal";

const FALLBACK_CONFIG: SystemNoticeAdminConfig = {
  maxUsers: 5,
  minPasswordLength: 6,
};

/**
 * 開發者模式 panel — 滿版深色（GitHub Dark Pro palette）
 *
 * 結構（已登入）：
 *   [標題列] 開發者模式 + 副標 + sign out
 *   [account]  username + 修改帳密 / 帳號管理 / IT 值班表 ↗
 *   [Ragic 欄位索引] inline 搜尋 + 表單列表（點擊 → 開 detail modal）
 *
 * 共用狀態：
 *   - useRagicFieldIndexState 持有單一份 Ragic state，inline + form-detail modal
 *     都透過 props 讀同一份，避免 dual polling。
 *   - SystemNoticeAdminConfig（max users / min password length）由 panel 啟動時抓一次，
 *     傳給兩個 modal，不再硬寫常數。
 *
 * Session 使用 localStorage（survive 關 tab）；後端 TTL 預設一週，
 * 後端重啟仍會清空 in-memory token map（看 panel 副標提示）。
 */
export function WorkReportTechnicalInfoPanel() {
  const { t } = useTranslation(["workReport", "common"]);
  const [token, setToken] = useState(() => readSystemNoticeAdminToken());
  const [tokenVerified, setTokenVerified] = useState(false);
  const [tokenChecking, setTokenChecking] = useState(true);
  const [username, setUsername] = useState<string>("");
  const [loginDraft, setLoginDraft] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submittingLogin, setSubmittingLogin] = useState(false);
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [manageUsersOpen, setManageUsersOpen] = useState(false);
  const [adminConfig, setAdminConfig] = useState<SystemNoticeAdminConfig>(
    FALLBACK_CONFIG
  );
  const [selectedForm, setSelectedForm] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  const handleAuthFailure = useCallback((reason: string) => {
    setTokenVerified(false);
    setUsername("");
    writeSystemNoticeAdminToken("");
    setToken("");
    setChangePwdOpen(false);
    setManageUsersOpen(false);
    setSelectedForm(null);
    setLoginError(reason ? reason : null);
  }, []);

  const ragic = useRagicFieldIndexState(token, () =>
    handleAuthFailure("session expired, please login again")
  );

  // 啟動拉一次 admin config（公開 endpoint，不需 token）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchSystemNoticeAdminConfig();
        if (!cancelled) setAdminConfig(cfg);
      } catch {
        // 抓不到就用 fallback；UI 仍可用
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Boot: 若 localStorage 已有 token → 驗證 + 取 username
  useEffect(() => {
    if (!token) {
      setTokenChecking(false);
      setTokenVerified(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const session = await fetchSystemNoticeSession(token);
        if (!cancelled) {
          setTokenVerified(true);
          setUsername(session.username);
          setLoginError(null);
        }
      } catch (error) {
        if (!cancelled) {
          handleAuthFailure(
            error instanceof Error ? error.message : "developer token expired"
          );
        }
      } finally {
        if (!cancelled) {
          setTokenChecking(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, handleAuthFailure]);

  async function handleDeveloperLogin() {
    if (submittingLogin) return;
    const usernameInput = loginDraft.username.trim();
    const password = loginDraft.password;
    if (!usernameInput || !password) {
      setLoginError("username/password required");
      return;
    }
    setSubmittingLogin(true);
    setLoginError(null);
    try {
      const result = await loginSystemNotice(usernameInput, password);
      writeSystemNoticeAdminToken(result.token);
      setToken(result.token);
      setUsername(result.username);
      setTokenVerified(true);
      setLoginDraft({ username: "", password: "" });
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : "developer login failed"
      );
    } finally {
      setSubmittingLogin(false);
    }
  }

  function handleLogout() {
    handleAuthFailure("");
  }

  function handleAuthKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !submittingLogin) {
      event.preventDefault();
      void handleDeveloperLogin();
    }
  }

  return (
    <section
      className="dev-mode-shell"
      aria-labelledby="dev-mode-title"
    >
      <header className="dev-mode-header">
        <div>
          <h2 id="dev-mode-title" className="dev-mode-title">
            {t("workReport:technicalInfo.title")}
          </h2>
          <p className="dev-mode-subtitle">
            {t("workReport:technicalInfo.subtitle")}
          </p>
        </div>
        {tokenVerified ? (
          <button
            type="button"
            className="dev-mode-btn"
            onClick={handleLogout}
          >
            sign out
          </button>
        ) : null}
      </header>

      {!tokenVerified ? (
        tokenChecking ? (
          <div className="dev-mode-empty">verifying token…</div>
        ) : (
          <section className="dev-mode-auth">
            <strong className="dev-mode-section-title">developer access</strong>
            <form
              className="dev-mode-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (submittingLogin) return;
                void handleDeveloperLogin();
              }}
            >
              <input
                className="dev-mode-input"
                value={loginDraft.username}
                onChange={(event) =>
                  setLoginDraft((p) => ({ ...p, username: event.target.value }))
                }
                onKeyDown={handleAuthKeyDown}
                placeholder="username"
                autoComplete="username"
              />
              <input
                ref={passwordInputRef}
                className="dev-mode-input"
                type="password"
                value={loginDraft.password}
                onChange={(event) =>
                  setLoginDraft((p) => ({ ...p, password: event.target.value }))
                }
                onKeyDown={handleAuthKeyDown}
                placeholder="password"
                autoComplete="current-password"
              />
              <button
                type="submit"
                className="dev-mode-btn dev-mode-btn--primary"
                disabled={submittingLogin}
              >
                {submittingLogin ? "logging in..." : "login"}
              </button>
            </form>
            {loginError ? (
              <p className="dev-mode-error">{loginError}</p>
            ) : null}
            <p className="dev-mode-auth-note">
              登入會保留一週（裝置層級）；後端重啟時所有登入都會被清空，需重登。
            </p>
          </section>
        )
      ) : (
        <>
          <section className="dev-mode-account">
            <strong className="dev-mode-section-title">account</strong>
            <div className="dev-mode-account-row">
              <span className="dev-mode-account-label">logged in as</span>
              <code className="dev-mode-account-username">{username}</code>
              <button
                type="button"
                className="dev-mode-btn"
                onClick={() => setChangePwdOpen(true)}
              >
                修改帳密
              </button>
              <button
                type="button"
                className="dev-mode-btn"
                onClick={() => setManageUsersOpen(true)}
              >
                帳號管理
              </button>
              <button
                type="button"
                className="dev-mode-btn"
                onClick={() =>
                  window.open("/it/duty", "_blank", "noopener,noreferrer")
                }
              >
                IT 值班表 ↗
              </button>
            </div>
          </section>

          <section className="dev-mode-dataflow">
            <strong className="dev-mode-section-title">Demo 資料流</strong>
            <div className="dev-mode-dataflow-grid">
              <div className="dev-mode-dataflow-card">
                <span className="dev-mode-dataflow-step">1</span>
                <h3>上游替身</h3>
                <p>
                  <code>DEMO_MODE=true</code> 時改用 in-memory mock fixture，不連真實上游、不帶正式資料。
                </p>
              </div>
              <div className="dev-mode-dataflow-card">
                <span className="dev-mode-dataflow-step">2</span>
                <h3>啟動同步</h3>
                <p>
                  後端啟動後自動同步 104 / 105，建立 SQLite read-model 的新 generation。
                </p>
              </div>
              <div className="dev-mode-dataflow-card">
                <span className="dev-mode-dataflow-step">3</span>
                <h3>原子切換</h3>
                <p>
                  寫完新 generation 並 replay 期間變更後，才切換 active pointer，前景讀取不會看到半套資料。
                </p>
              </div>
              <div className="dev-mode-dataflow-card">
                <span className="dev-mode-dataflow-step">4</span>
                <h3>前景讀取</h3>
                <p>
                  列表、詳情與分面統計優先讀 active generation；缺 snapshot 時才 fallback live read。
                </p>
              </div>
            </div>
          </section>

          <section className="dev-mode-ragic">
            <strong className="dev-mode-section-title">Ragic 欄位索引</strong>
            <RagicFieldInlineSearch
              token={token}
              state={ragic.state}
              onRefresh={ragic.refresh}
              refreshError={ragic.refreshError}
              onAuthFailure={() =>
                handleAuthFailure("session expired, please login again")
              }
              onSelectForm={(path, name) =>
                setSelectedForm({ path, name })
              }
            />
          </section>

          <ChangePasswordModal
            open={changePwdOpen}
            token={token}
            currentUsername={username}
            config={adminConfig}
            onClose={() => setChangePwdOpen(false)}
            onChanged={() => {
              // 改完帳密後伺服器會清掉所有 token → 強制重新登入
              handleAuthFailure("帳密已更新，請重新登入");
            }}
          />

          <ManageUsersModal
            open={manageUsersOpen}
            token={token}
            currentUsername={username}
            config={adminConfig}
            onClose={() => setManageUsersOpen(false)}
            onAuthFailure={() =>
              handleAuthFailure("session expired, please login again")
            }
          />

          <RagicFormDetailModal
            open={selectedForm !== null}
            token={token}
            formPath={selectedForm?.path ?? null}
            formName={selectedForm?.name ?? null}
            state={ragic.state}
            onRefresh={ragic.refresh}
            refreshError={ragic.refreshError}
            onClose={() => setSelectedForm(null)}
            onAuthFailure={() =>
              handleAuthFailure("session expired, please login again")
            }
          />
        </>
      )}
    </section>
  );
}
