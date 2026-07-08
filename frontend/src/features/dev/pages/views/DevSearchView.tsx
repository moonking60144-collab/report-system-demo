import { useState } from "react";
import { RagicFieldInlineSearch } from "../../components/RagicFieldInlineSearch";
import { RagicFormDetailModal } from "../../components/RagicFormDetailModal";
import { RagicRefreshProgress } from "../../components/RagicRefreshProgress";
import { DevSyncStatus } from "../../components/DevSyncStatus";
import { useLingering } from "../../hooks/useLingering";
import { useDevContext } from "../../layout/devContext";

export function DevSearchView() {
  const { token, ragic, onAuthFailure } = useDevContext();
  const [selectedForm, setSelectedForm] = useState<{ path: string; name: string } | null>(null);
  const fail = () => onAuthFailure("session expired, please login again");
  const refreshing = ragic.state?.status === "refreshing";
  const showProgress = useLingering(refreshing, 500);
  return (
    <>
      <div className="dev-search-head">
        <DevSyncStatus state={ragic.state} onRefresh={ragic.refresh} />
      </div>
      {showProgress ? (
        <RagicRefreshProgress
          key={ragic.state?.progress?.startedAt ?? "init"}
          progress={ragic.state?.progress ?? null}
          variant="inline"
          complete={!refreshing}
        />
      ) : null}
      {ragic.refreshError ? <p className="dev-mode-error">{ragic.refreshError}</p> : null}
      <RagicFieldInlineSearch
        token={token}
        state={ragic.state}
        onAuthFailure={fail}
        onSelectForm={(path, name) => setSelectedForm({ path, name })}
      />
      <RagicFormDetailModal
        open={selectedForm !== null}
        token={token}
        formPath={selectedForm?.path ?? null}
        formName={selectedForm?.name ?? null}
        state={ragic.state}
        onRefresh={ragic.refresh}
        refreshError={ragic.refreshError}
        onClose={() => setSelectedForm(null)}
        onAuthFailure={fail}
      />
    </>
  );
}
