import { RagicGroupGraphExplorer } from "../../components/RagicGroupGraphExplorer";
import { useDevContext } from "../../layout/devContext";

export function DevMatrixView() {
  const { token, onAuthFailure } = useDevContext();
  return (
    <RagicGroupGraphExplorer
      token={token}
      onAuthFailure={() => onAuthFailure("session expired, please login again")}
    />
  );
}
