import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  clearWorkReportSessionExpiryState,
  sanitizeWorkReportReturnToPath,
} from "../session/sessionExpiry";

function resolveExpiredMessageKey(
  reason: string
): "forced" | "idle" | "default" {
  if (reason === "forced-by-admin") {
    return "forced";
  }
  if (reason === "idle-timeout") {
    return "idle";
  }
  return "default";
}

export function WorkReportSessionExpiredPage() {
  const { t } = useTranslation(["workReport", "common"]);
  const [searchParams] = useSearchParams();
  const returnTo = useMemo(
    () => sanitizeWorkReportReturnToPath(searchParams.get("returnTo")),
    [searchParams]
  );
  const reasonKey = resolveExpiredMessageKey(
    String(searchParams.get("reason") ?? "").trim()
  );

  const handleReenter = () => {
    clearWorkReportSessionExpiryState();
    window.location.replace(returnTo);
  };

  return (
    <main
      className="page"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "1.5rem",
        background:
          "radial-gradient(circle at top, rgba(30,58,138,0.18), transparent 52%), #111827",
      }}
    >
      <section
        style={{
          width: "min(560px, 100%)",
          display: "grid",
          gap: "1rem",
          padding: "1.4rem 1.5rem",
          borderRadius: "18px",
          border: "1px solid rgba(148,163,184,0.22)",
          background: "#111827",
          boxShadow: "0 24px 60px rgba(0,0,0,0.36)",
          color: "#e5e7eb",
        }}
      >
        <div style={{ display: "grid", gap: "0.45rem" }}>
          <span
            style={{
              color: "#9cdcfe",
              fontFamily:
                '"Cascadia Code", "Consolas", "JetBrains Mono", monospace',
              fontSize: "0.86rem",
              textTransform: "uppercase",
            }}
          >
            session expired
          </span>
          <h1 style={{ margin: 0, fontSize: "1.55rem", color: "#f3f4f6" }}>
            {t("workReport:sessionExpired.title")}
          </h1>
          <p style={{ margin: 0, lineHeight: 1.7, color: "#cbd5e1" }}>
            {t(`workReport:sessionExpired.reasons.${reasonKey}`)}
          </p>
        </div>

        <div
          style={{
            padding: "0.95rem 1rem",
            borderRadius: "14px",
            border: "1px solid rgba(59,130,246,0.25)",
            background: "rgba(15,23,42,0.78)",
            color: "#cbd5e1",
            lineHeight: 1.65,
          }}
        >
          {t("workReport:sessionExpired.hint")}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleReenter}
            style={{
              minHeight: "2.6rem",
              padding: "0.55rem 1rem",
              borderRadius: "12px",
              border: "1px solid #2563eb",
              background: "#1d4ed8",
              color: "#eff6ff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {t("workReport:sessionExpired.reenter")}
          </button>
        </div>
      </section>
    </main>
  );
}
