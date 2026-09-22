/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import {
  BackgroundLoadingIndicator,
  PageLoadingBoundary,
  type PageLoadingState,
} from "../../src/components/PageLoadingBoundary";

function PageLoadingBoundaryFixture() {
  const [state, setState] = useState<PageLoadingState>({
    kind: "pending",
    message: "資料讀取中...",
  });
  const [backgroundLoading, setBackgroundLoading] = useState(false);

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "#f1f5f9" }}>
      <nav aria-label="載入狀態測試" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => {
            setBackgroundLoading(false);
            setState({ kind: "pending", message: "資料讀取中..." });
          }}
        >
          初次載入
        </button>
        <button
          type="button"
          onClick={() => {
            setBackgroundLoading(false);
            setState({
              kind: "error",
              title: "資料載入失敗",
              message: "測試錯誤",
            });
          }}
        >
          載入失敗
        </button>
        <button
          type="button"
          onClick={() => {
            setBackgroundLoading(false);
            setState({ kind: "ready" });
          }}
        >
          資料完成
        </button>
        <button
          type="button"
          onClick={() => {
            setState({ kind: "ready" });
            setBackgroundLoading(true);
          }}
        >
          背景更新
        </button>
      </nav>

      <PageLoadingBoundary state={state} variant="section">
        <section
          data-testid="existing-content"
          style={{ minHeight: 280, padding: 24, borderRadius: 10, background: "#ffffff" }}
        >
          {backgroundLoading ? (
            <BackgroundLoadingIndicator label="背景更新中..." />
          ) : null}
          <h1>已載入資料</h1>
          <p>這段內容在背景更新時必須保留。</p>
        </section>
      </PageLoadingBoundary>
    </main>
  );
}

export function mountPageLoadingBoundaryFixture(container: HTMLElement) {
  createRoot(container).render(<PageLoadingBoundaryFixture />);
}
