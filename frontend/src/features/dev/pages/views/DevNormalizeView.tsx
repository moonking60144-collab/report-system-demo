import { RagicNormalizeAudit } from "../../components/RagicNormalizeAudit";
import { useDevContext } from "../../layout/devContext";

export function DevNormalizeView() {
  const { token, onAuthFailure } = useDevContext();
  return (
    <RagicNormalizeAudit
      token={token}
      onAuthFailure={() => onAuthFailure("session expired, please login again")}
    />
  );
}
