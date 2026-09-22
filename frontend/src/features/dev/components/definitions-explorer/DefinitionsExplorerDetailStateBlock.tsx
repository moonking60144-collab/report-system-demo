import { memo } from "react";

interface Props {
  detailError: string | null;
  detailLoading: boolean;
  hasDetail: boolean;
}

export const DefinitionsExplorerDetailStateBlock = memo(function DefinitionsExplorerDetailStateBlock({
  detailError,
  detailLoading,
  hasDetail,
}: Props) {
  return (
    <>
      {detailError ? <p className="dev-mode-error">{detailError}</p> : null}
      {hasDetail ? null : detailLoading ? (
        <p className="ragic-inline__hint ragic-loading-inline">載入中…</p>
      ) : (
        <p className="ragic-inline__hint">請選擇一張表單。</p>
      )}
    </>
  );
});
