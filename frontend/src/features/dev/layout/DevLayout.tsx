import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";
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
import { isUnauthorized } from "../../../api/apiErrors";
import { useRagicFieldIndexState } from "../hooks/useRagicFieldIndexState";
import { DevSidebar } from "../components/DevSidebar";
import type { DevContextValue } from "./devContext";

const FALLBACK_CONFIG: SystemNoticeAdminConfig = {
  maxUsers: 5,
  minPasswordLength: 6,
};
const DEV_SIDEBAR_COLLAPSED_STORAGE_KEY = "devModeSidebarCollapsed";

function readDevSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(DEV_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDevSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      DEV_SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0"
    );
  } catch {
    // localStorage 不可用時只保留本次畫面狀態。
  }
}

/**
 * 開發者面板的外殼：持有 auth token、單一份 Ragic state（避免 dual polling）、admin config，
 * 登入牆也在這層。已登入時渲染常駐切換列（非 hub 頁）+ <Outlet>，把共用 state 透過
 * Outlet context 傳給各工具 view。各工具拆成獨立路由 view → 一次畫面只有一個工具，捲動互不打架。
 */
export function DevLayout() {
  const { t } = useTranslation(["workReport", "common"]);
  const [token, setToken] = useState(() => readSystemNoticeAdminToken());
  const [tokenVerified, setTokenVerified] = useState(false);
  const [tokenChecking, setTokenChecking] = useState(true);
  const [username, setUsername] = useState<string>("");
  const [loginDraft, setLoginDraft] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submittingLogin, setSubmittingLogin] = useState(false);
  const [adminConfig, setAdminConfig] = useState<SystemNoticeAdminConfig>(FALLBACK_CONFIG);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootRetryNonce, setBootRetryNonce] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readDevSidebarCollapsed);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  const handleAuthFailure = useCallback((reason: string) => {
    setTokenVerified(false);
    setUsername("");
    writeSystemNoticeAdminToken("");
    setToken("");
    setLoginError(reason ? reason : null);
  }, []);

  const ragic = useRagicFieldIndexState(
    token,
    () => handleAuthFailure("登入已過期，請重新登入"),
    tokenVerified
  );

  // 進 /dev 把分頁標題改成「開發者模式」，離開還原
  useEffect(() => {
    const prev = document.title;
    document.title = "開發者模式";
    return () => {
      document.title = prev;
    };
  }, []);

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

  // Boot: 若 localStorage 已有 token → 驗證 + 取 username。
  // 只有 401（token 真失效）才清 token；timeout / backend 暫時沒回應保留
  // token，顯示重試，不逼使用者重新登入。
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
          setBootError(null);
        }
      } catch (error) {
        if (!cancelled) {
          if (isUnauthorized(error)) {
            handleAuthFailure("開發者登入已過期，請重新登入");
          } else {
            setBootError(
              error instanceof Error && /timeout/i.test(error.message)
                ? "後端回應逾時，請稍後重試"
                : "無法連線後端，請稍後重試"
            );
          }
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
  }, [token, handleAuthFailure, bootRetryNonce]);

  function handleBootRetry() {
    setBootError(null);
    setTokenChecking(true);
    setBootRetryNonce((nonce) => nonce + 1);
  }

  async function handleDeveloperLogin() {
    if (submittingLogin) return;
    const usernameInput = loginDraft.username.trim();
    const password = loginDraft.password;
    if (!usernameInput || !password) {
      setLoginError("請輸入帳號與密碼");
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
      setLoginError(error instanceof Error ? error.message : "開發者登入失敗");
    } finally {
      setSubmittingLogin(false);
    }
  }

  function handleLogout() {
    handleAuthFailure("");
  }

  function handleToggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeDevSidebarCollapsed(next);
      return next;
    });
  }

  function handleAuthKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !submittingLogin) {
      event.preventDefault();
      void handleDeveloperLogin();
    }
  }

  const contextValue: DevContextValue = {
    token,
    username,
    adminConfig,
    ragic,
    onAuthFailure: handleAuthFailure,
  };

  return (
    <section className="dev-mode-shell" aria-label="開發者模式">
      {!tokenVerified ? (
        <header className="dev-mode-header">
          <div className="dev-mode-header__brand">
            <h2 id="dev-mode-title" className="dev-mode-title">
              {t("workReport:technicalInfo.title")}
            </h2>
            <p className="dev-mode-subtitle">{t("workReport:technicalInfo.subtitle")}</p>
          </div>
        </header>
      ) : null}

      {!tokenVerified ? (
        tokenChecking ? (
          <div className="dev-mode-empty">驗證登入狀態中…</div>
        ) : bootError ? (
          <div className="dev-mode-empty">
            <p className="dev-mode-error">{bootError}</p>
            <button
              type="button"
              className="dev-mode-btn dev-mode-btn--primary"
              onClick={handleBootRetry}
            >
              重試
            </button>
            <button
              type="button"
              className="dev-mode-btn"
              onClick={() => handleAuthFailure("")}
            >
              改用帳密登入
            </button>
          </div>
        ) : (
          <section className="dev-mode-auth">
            <strong className="dev-mode-section-title">開發者登入</strong>
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
                placeholder="帳號"
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
                placeholder="密碼"
                autoComplete="current-password"
              />
              <button
                type="submit"
                className="dev-mode-btn dev-mode-btn--primary"
                disabled={submittingLogin}
              >
                {submittingLogin ? "登入中…" : "登入"}
              </button>
            </form>
            {loginError ? <p className="dev-mode-error">{loginError}</p> : null}
            <p className="dev-mode-auth-note">登入會保留一年（裝置層級）。</p>
          </section>
        )
      ) : (
        <div className={`dev-app${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
          <DevSidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={handleToggleSidebarCollapsed}
            username={username}
            onLogout={handleLogout}
          />
          <main className="dev-main">
            <Suspense fallback={<div className="dev-mode-empty">載入中…</div>}>
              <Outlet context={contextValue} />
            </Suspense>
          </main>
        </div>
      )}
    </section>
  );
}
