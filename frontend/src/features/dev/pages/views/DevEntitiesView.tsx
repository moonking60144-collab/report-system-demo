import { RagicEntityBrowser } from "../../components/RagicEntityBrowser";
import { useDevContext } from "../../layout/devContext";

export function DevEntitiesView() {
  const { token, onAuthFailure } = useDevContext();
  return (
    <RagicEntityBrowser
      token={token}
      onAuthFailure={() => onAuthFailure("session expired, please login again")}
    />
  );
}
