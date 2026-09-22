import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BackgroundLoadingIndicator,
  PageLoadingBoundary,
} from "./PageLoadingBoundary";

describe("PageLoadingBoundary", () => {
  it("initial loading 只顯示中央狀態，不先渲染頁面內容", () => {
    const html = renderToStaticMarkup(
      <PageLoadingBoundary state={{ kind: "pending", message: "資料讀取中" }}>
        <div>ready content</div>
      </PageLoadingBoundary>
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("資料讀取中");
    expect(html).not.toContain("ready content");
  });

  it("error state 提供錯誤訊息與可重試操作", () => {
    const html = renderToStaticMarkup(
      <PageLoadingBoundary
        state={{
          kind: "error",
          title: "資料載入失敗",
          message: "連線中斷",
          action: { label: "重新讀取", onClick: () => undefined },
        }}
      />
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("資料載入失敗");
    expect(html).toContain("連線中斷");
    expect(html).toContain("重新讀取");
  });

  it("ready state 只呈現既有內容，不混入 transport state", () => {
    const html = renderToStaticMarkup(
      <PageLoadingBoundary state={{ kind: "ready" }}>
        <div>existing data</div>
      </PageLoadingBoundary>
    );

    expect(html).toContain("existing data");
    expect(html).not.toContain("background-loading-indicator");
  });

  it("背景更新指示器可獨立顯示，不影響頁面內容", () => {
    const html = renderToStaticMarkup(
      <div>
        <div>existing data</div>
        <BackgroundLoadingIndicator label="背景更新中" />
      </div>
    );

    expect(html).toContain("existing data");
    expect(html).toContain("background-loading-indicator");
    expect(html).toContain('role="status"');
    expect(html).toContain("背景更新中");
  });
});
