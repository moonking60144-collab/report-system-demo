import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./index.css";
import "./i18n";
import { AppWithLocale } from "./AppWithLocale";
import { AppErrorBoundary } from "./components/AppErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppWithLocale />
    </AppErrorBoundary>
  </StrictMode>
);
