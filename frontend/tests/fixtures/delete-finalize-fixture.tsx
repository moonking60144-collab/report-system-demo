import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../../src/i18n";
import { WorkReportTaskQueueDrawer } from "../../src/features/work-report/components/WorkReportTaskQueueDrawer";
import { getOrCreateClientId } from "../../src/utils/clientIdentity";

export function mountDeleteFinalizeFixture(element: HTMLElement) {
  Object.defineProperty(window, "EventSource", { value: undefined, configurable: true });
  Object.assign(window, { fixtureClientId: getOrCreateClientId() });
  createRoot(element).render(<MemoryRouter>
    <WorkReportTaskQueueDrawer open context="entry" formId="901" entryId="1" onClose={() => {}} />
  </MemoryRouter>);
}
