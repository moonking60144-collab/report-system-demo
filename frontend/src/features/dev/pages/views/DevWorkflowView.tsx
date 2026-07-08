import { RagicWorkflowExplorer } from "../../components/RagicWorkflowExplorer";
import { useDevContext } from "../../layout/devContext";

export function DevWorkflowView() {
  const { token, onAuthFailure } = useDevContext();
  return (
    <RagicWorkflowExplorer
      token={token}
      onAuthFailure={() => onAuthFailure("session expired, please login again")}
    />
  );
}
