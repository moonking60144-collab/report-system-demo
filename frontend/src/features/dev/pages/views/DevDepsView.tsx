import { RagicDependencyExplorer } from "../../components/RagicDependencyExplorer";
import { useDevContext } from "../../layout/devContext";

export function DevDepsView() {
  const { token, onAuthFailure } = useDevContext();
  return (
    <RagicDependencyExplorer
      token={token}
      onAuthFailure={() => onAuthFailure("session expired, please login again")}
    />
  );
}
