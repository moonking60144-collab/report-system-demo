import { useTranslation } from "react-i18next";
import type { ItDutyThemeMode } from "../hooks/useItDutyTheme";

interface Props {
  mode: ItDutyThemeMode;
  onChange: (mode: ItDutyThemeMode) => void;
}

const OPTIONS: ItDutyThemeMode[] = ["light", "dark", "system"];

export function ItDutyThemeToggle({ mode, onChange }: Props) {
  const { t } = useTranslation("itDuty");
  return (
    <div
      className="itduty-theme-toggle"
      role="radiogroup"
      aria-label={t("theme.label")}
    >
      {OPTIONS.map((option) => {
        const isActive = mode === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={[
              "itduty-theme-toggle__btn",
              isActive ? "itduty-theme-toggle__btn--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onChange(option)}
          >
            {t(`theme.${option}`)}
          </button>
        );
      })}
    </div>
  );
}
