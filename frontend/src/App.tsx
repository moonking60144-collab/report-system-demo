import { DemoBadge } from "./components/DemoBadge";
import { FaultInjectionPanel } from "./components/FaultInjectionPanel";
import { WorkReportListPage } from "./features/work-report/pages/WorkReportListPage";

function App() {
  return (
    <>
      <DemoBadge />
      <FaultInjectionPanel />
      <WorkReportListPage />
    </>
  );
}

export default App;
