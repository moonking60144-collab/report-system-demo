import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkReportMainMachineController } from "../../src/features/work-report/hooks/detail/useWorkReportMainMachineController";

export function Fixture() {
  const formId = new URLSearchParams(location.search).get("form") === "902" ? "902" : "901";
  const [machine, setMachine] = useState("MB50");
  const [entryId, setEntryId] = useState("E1");
  const controller = useWorkReportMainMachineController({
    formId, safeEntryId: entryId,
    record: { id: entryId, workOrderNo: "WO1", status: "未結案", customerPartNo: null, erpPartNo: null, machineCode: formId === "901" ? machine : "UPSTREAM", filterMachineCode: machine, lastUpdatedAt: machine },
    editingRowId: null, hasActiveMutationTask: false, modalOpen: false, loading: false, refreshing: false, submitting: false,
    ensureOptionsLoaded: async () => undefined, registerAcceptedMutationTask: async () => undefined,
    setNotice: () => undefined, logDetailEvent: () => undefined, t: (key) => key,
  });
  return <>
    <button onClick={controller.openMainMachineModal}>open</button>
    <button onClick={() => setMachine("MA51")}>refresh</button>
    <button onClick={() => setEntryId("E2")}>navigate</button>
    <output id="machine">{machine}</output>
    {controller.mainMachineModalOpen && <>
      <input aria-label="machine draft" value={controller.mainMachineDraft} onChange={event => controller.setMainMachineDraft(event.target.value)} />
      <button disabled={controller.mainMachineSaving} onClick={() => void controller.submitMainMachineUpdate()}>save</button>
    </>}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
