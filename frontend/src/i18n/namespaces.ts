// NOTE: 新頁面請優先新增自己的 namespace（例如 page105、dashboard），避免把字串都塞進 common/workReport。
export const I18N_NAMESPACES = ["common", "workReport", "itDuty"] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const DEFAULT_I18N_NAMESPACE: I18nNamespace = "common";

