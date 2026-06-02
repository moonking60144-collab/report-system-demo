import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  readCachedSystemNoticeAvailabilitySnapshot,
  sanitizeWorkReportAvailabilityReturnToPath,
  type WorkReportSystemUnavailableReason,
} from "../systemAvailability";

function resolveUnavailableReason(
  rawReason: string
): WorkReportSystemUnavailableReason {
  return rawReason === "maintenance" ? "maintenance" : "backend-unavailable";
}

export function WorkReportSystemUnavailablePage() {
  const { t } = useTranslation(["workReport", "common"]);
  const [searchParams] = useSearchParams();
  const cachedAvailability = useMemo(
    () => readCachedSystemNoticeAvailabilitySnapshot(),
    []
  );
  const returnTo = useMemo(
    () =>
      sanitizeWorkReportAvailabilityReturnToPath(searchParams.get("returnTo")),
    [searchParams]
  );
  const reason = resolveUnavailableReason(
    String(searchParams.get("reason") ?? "").trim()
  );
  const maintenanceMessage =
    String(searchParams.get("message") ?? "").trim() || null;
  const maintenanceRangeLabel = useMemo(() => {
    const formatDisplayDateTime = (raw: string | null): string => {
      if (!raw) {
        return "--";
      }
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return "--";
      }
      return parsed.toLocaleString("zh-TW", { hour12: false });
    };

    if (reason !== "maintenance") {
      return null;
    }
    if (cachedAvailability.startAt && cachedAvailability.endAt) {
      return t("workReport:systemUnavailable.range", {
        start: formatDisplayDateTime(cachedAvailability.startAt),
        end: formatDisplayDateTime(cachedAvailability.endAt),
      });
    }
    if (cachedAvailability.startAt) {
      return t("workReport:systemUnavailable.startAt", {
        start: formatDisplayDateTime(cachedAvailability.startAt),
      });
    }
    if (cachedAvailability.endAt) {
      return t("workReport:systemUnavailable.endAt", {
        end: formatDisplayDateTime(cachedAvailability.endAt),
      });
    }
    return null;
  }, [cachedAvailability.endAt, cachedAvailability.startAt, reason, t]);

  const handleRetry = () => {
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
          "radial-gradient(circle at top, rgba(180,83,9,0.16), transparent 52%), #111827",
      }}
    >
      <section
        style={{
          width: "min(620px, 100%)",
          display: "grid",
          gap: "1rem",
          padding: "1.4rem 1.5rem",
          borderRadius: "18px",
          border: "1px solid rgba(251,191,36,0.22)",
          background: "#111827",
          boxShadow: "0 24px 60px rgba(0,0,0,0.36)",
          color: "#e5e7eb",
        }}
      >
        <div style={{ display: "grid", gap: "0.45rem" }}>
          <span
            style={{
              color: "#fbbf24",
              fontFamily:
                '"Cascadia Code", "Consolas", "JetBrains Mono", monospace',
              fontSize: "0.86rem",
              textTransform: "uppercase",
            }}
          >
            system unavailable
          </span>
          <h1 style={{ margin: 0, fontSize: "1.55rem", color: "#f9fafb" }}>
            {reason === "maintenance"
              ? t("workReport:systemUnavailable.maintenanceTitle")
              : t("workReport:systemUnavailable.unavailableTitle")}
          </h1>
          <p style={{ margin: 0, lineHeight: 1.7, color: "#cbd5e1" }}>
            {reason === "maintenance"
              ? t("workReport:systemUnavailable.maintenanceDetail")
              : t("workReport:systemUnavailable.unavailableDetail")}
          </p>
        </div>

        {maintenanceMessage ? (
          <div
            style={{
              padding: "0.95rem 1rem",
              borderRadius: "14px",
              border: "1px solid rgba(251,191,36,0.25)",
              background: "rgba(15,23,42,0.78)",
              color: "#fde68a",
              lineHeight: 1.65,
            }}
          >
            {maintenanceMessage}
          </div>
        ) : null}

        {maintenanceRangeLabel ? (
          <div
            style={{
              padding: "0.95rem 1rem",
              borderRadius: "14px",
              border: "1px solid rgba(250,204,21,0.18)",
              background: "rgba(120,53,15,0.14)",
              color: "#fde68a",
              lineHeight: 1.65,
            }}
          >
            {maintenanceRangeLabel}
          </div>
        ) : null}

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
          {t("workReport:systemUnavailable.hint")}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={handleRetry}
            style={{
              minHeight: "2.6rem",
              padding: "0.55rem 1rem",
              borderRadius: "12px",
              border: "1px solid #d97706",
              background: "#b45309",
              color: "#fffbeb",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            {t("workReport:systemUnavailable.retry")}
          </button>
        </div>
      </section>
    </main>
  );
}
