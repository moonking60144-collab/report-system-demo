import type { Page } from "@playwright/test";

export async function mockTaskEvents(page: Page) {
  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    class Source extends EventTarget {
      readyState = 0;
      constructor() { super(); sources.push(this); }
      close() { this.readyState = 2; }
    }
    window.EventSource = Source as unknown as typeof EventSource;
    Object.assign(window, {
      taskEventsOpen: () => sources.forEach((source) => {
        (source as Source).readyState = 1; source.dispatchEvent(new Event("open"));
      }),
      taskEventsSend: (id: string, formId = "901", taskId = "task-other-device") => sources.forEach((source) => source.dispatchEvent(new MessageEvent("work-report-event", {
        data: JSON.stringify({ id, type: "work-report-task-updated", formId, workReportTask: {
          taskId, taskType: formId === "903" ? "create-downtime" : "create-report", status: "success", updatedAt: id,
        } }),
      }))),
    });
  });
}
