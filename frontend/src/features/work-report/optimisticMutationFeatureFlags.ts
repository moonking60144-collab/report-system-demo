export function resolveOptimisticMutationFeatureEnabled(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export const WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED =
  resolveOptimisticMutationFeatureEnabled(
    import.meta.env.VITE_WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED
  );

export const FORM16_OPTIMISTIC_MUTATIONS_ENABLED =
  resolveOptimisticMutationFeatureEnabled(
    import.meta.env.VITE_FORM16_OPTIMISTIC_MUTATIONS_ENABLED
  );
