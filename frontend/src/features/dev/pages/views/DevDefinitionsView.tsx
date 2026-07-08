import { RagicDefinitionsExplorer } from "../../components/RagicDefinitionsExplorer";
import { useDevContext } from "../../layout/devContext";

export function DevDefinitionsView() {
  const { token, username, onAuthFailure } = useDevContext();
  return (
    <RagicDefinitionsExplorer
      token={token}
      username={username}
      onAuthFailure={() => onAuthFailure("登入已過期，請重新登入")}
    />
  );
}
