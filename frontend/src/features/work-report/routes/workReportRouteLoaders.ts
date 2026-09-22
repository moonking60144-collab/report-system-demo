let detailModulePromise: ReturnType<typeof importWorkReportDetailPage> | null = null;

function importWorkReportDetailPage() {
  return import("../pages/WorkReportDetailPage");
}

export function loadWorkReportDetailPage() {
  if (!detailModulePromise) {
    const request = importWorkReportDetailPage();
    detailModulePromise = request;
    void request.catch(() => {
      if (detailModulePromise === request) {
        detailModulePromise = null;
      }
    });
  }
  return detailModulePromise;
}

export function preloadWorkReportDetailPage(): void {
  void loadWorkReportDetailPage().catch(() => undefined);
}
