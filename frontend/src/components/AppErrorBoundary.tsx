import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary]", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleHome = (): void => {
    window.location.href = "/";
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#f5f5f5",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 560,
            width: "100%",
            background: "#fff",
            padding: "32px",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ margin: "0 0 12px", fontSize: 22, color: "#d4380d" }}>
            頁面發生未預期錯誤
          </h1>
          <p style={{ margin: "0 0 16px", color: "#555", lineHeight: 1.6 }}>
            系統偵測到 render 階段的錯誤，頁面無法正常顯示。你可以重新整理，或回到首頁。
          </p>
          <details style={{ marginBottom: 20, fontSize: 12, color: "#888" }}>
            <summary style={{ cursor: "pointer", marginBottom: 4 }}>技術細節</summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "#fafafa",
                padding: 12,
                borderRadius: 4,
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
          </details>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                padding: "8px 20px",
                borderRadius: 4,
                border: "1px solid #1677ff",
                background: "#1677ff",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              重新整理
            </button>
            <button
              type="button"
              onClick={this.handleHome}
              style={{
                padding: "8px 20px",
                borderRadius: 4,
                border: "1px solid #d9d9d9",
                background: "#fff",
                color: "#333",
                cursor: "pointer",
              }}
            >
              回首頁
            </button>
          </div>
        </div>
      </div>
    );
  }
}
