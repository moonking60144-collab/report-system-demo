import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { UI_LANGUAGE_STORAGE_KEY } from "../features/work-report/constants";
import { DEFAULT_I18N_NAMESPACE, I18N_NAMESPACES } from "./namespaces";
import { i18nResources } from "./resources";

function resolveInitialLanguage(): "zh-TW" | "en" {
  if (typeof window === "undefined") {
    return "zh-TW";
  }

  try {
    const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (stored === "en") {
      return "en";
    }
    if (stored === "zh") {
      return "zh-TW";
    }
  } catch {
    // NOTE: 忽略 localStorage 例外，避免影響主流程。
  }

  const browserLanguage = window.navigator.language?.toLowerCase() ?? "";
  return browserLanguage.startsWith("en") ? "en" : "zh-TW";
}

if (!i18n.isInitialized) {
  void i18n
    .use(initReactI18next)
    .init({
      resources: i18nResources,
      lng: resolveInitialLanguage(),
      fallbackLng: "zh-TW",
      supportedLngs: ["zh-TW", "en"],
      ns: [...I18N_NAMESPACES],
      defaultNS: DEFAULT_I18N_NAMESPACE,
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
    });

  i18n.on("languageChanged", (language) => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(
        UI_LANGUAGE_STORAGE_KEY,
        language.toLowerCase().startsWith("en") ? "en" : "zh"
      );
    } catch {
      // NOTE: 忽略 localStorage 例外，避免影響主流程。
    }
  });
}

export { i18n };
export default i18n;
