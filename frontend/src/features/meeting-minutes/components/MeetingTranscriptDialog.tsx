import {
  AudioOutlined,
  DownloadOutlined,
  LoadingOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Modal } from "antd";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  resolveMeetingRecordingApiError,
  type MeetingMergedTranscriptDocument,
} from "../api/meetingRecordingApi";
import { useMeetingTranscriptSearch } from "../useMeetingTranscriptSearch";

function formatTranscriptTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

interface MeetingTranscriptDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  transcriptKey: string;
  document: MeetingMergedTranscriptDocument | null;
  loading: boolean;
  errorMessage: string | null;
  onRetry?: () => void;
  onDownloadText?: () => Promise<void>;
  onDownloadJson?: () => Promise<void>;
  onActionError?: (error: unknown) => void;
  onSegmentSelect?: (startMs: number) => void;
}

export function MeetingTranscriptDialog({
  open,
  onClose,
  title,
  transcriptKey,
  document,
  loading,
  errorMessage,
  onRetry,
  onDownloadText,
  onDownloadJson,
  onActionError,
  onSegmentSelect,
}: MeetingTranscriptDialogProps) {
  const { t } = useTranslation("meetingMinutes");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const segments = document?.segments ?? [];
  const search = useMeetingTranscriptSearch(segments, transcriptKey);
  const [downloadState, setDownloadState] = useState<{
    transcriptKey: string;
    kind: "text" | "json" | null;
    error: string | null;
  }>({ transcriptKey: "", kind: null, error: null });
  const activeDownloadState =
    downloadState.transcriptKey === transcriptKey
      ? downloadState
      : { transcriptKey, kind: null, error: null };

  const download = async (
    kind: "text" | "json",
    action: (() => Promise<void>) | undefined
  ) => {
    if (!action || activeDownloadState.kind) return;
    setDownloadState({ transcriptKey, kind, error: null });
    try {
      await action();
      setDownloadState({ transcriptKey, kind: null, error: null });
    } catch (error) {
      setDownloadState({
        transcriptKey,
        kind: null,
        error:
          resolveMeetingRecordingApiError(error) ??
          t("transcription.reader.downloadFailed"),
      });
      onActionError?.(error);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="calc(100vw - 32px)"
      rootClassName="meeting-transcript-modal-root"
      className="meeting-transcript-modal"
      maskClosable={false}
      destroyOnHidden
      title={
        <div className="meeting-transcript-modal__heading">
          <div>
            <span>{t("transcription.reader.eyebrow")}</span>
            <h2>{title}</h2>
          </div>
          {document ? (
            <p>
              {t("transcription.segmentCount", {
                count: document.segments.length,
              })}
              <span aria-hidden="true">·</span>
              {document.provider} · {document.model}
            </p>
          ) : null}
        </div>
      }
      afterOpenChange={(nextOpen) => {
        if (nextOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
      }}
    >
      <div className="meeting-transcript-dialog">
        <div className="meeting-transcript-dialog__toolbar">
          <label>
            <SearchOutlined aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label={t("transcription.searchLabel")}
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              placeholder={t("transcription.searchPlaceholder")}
              disabled={!document}
            />
          </label>
          <div className="meeting-transcript-dialog__count" aria-live="polite">
            {document
              ? t("transcription.reader.resultCount", {
                  visible: search.visibleSegments.length,
                  matching: search.matchingCount,
                  total: document.segments.length,
                })
              : t("transcription.reader.waitingForDocument")}
          </div>
          <div className="meeting-transcript-dialog__downloads">
            {onDownloadText ? (
              <button
                type="button"
                onClick={() => void download("text", onDownloadText)}
                disabled={activeDownloadState.kind !== null}
              >
                {activeDownloadState.kind === "text" ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : (
                  <DownloadOutlined aria-hidden="true" />
                )}
                {t("transcription.actions.downloadText")}
              </button>
            ) : null}
            {onDownloadJson ? (
              <button
                type="button"
                onClick={() => void download("json", onDownloadJson)}
                disabled={activeDownloadState.kind !== null}
              >
                {activeDownloadState.kind === "json" ? (
                  <LoadingOutlined spin aria-hidden="true" />
                ) : (
                  <DownloadOutlined aria-hidden="true" />
                )}
                {t("transcription.actions.downloadJson")}
              </button>
            ) : null}
          </div>
        </div>

        {activeDownloadState.error ? (
          <p className="meeting-transcript-dialog__action-error" role="alert">
            {activeDownloadState.error}
          </p>
        ) : null}

        <div className="meeting-transcript-dialog__viewport">
          {loading ? (
            <div className="meeting-transcript-dialog__state" role="status">
              <LoadingOutlined spin aria-hidden="true" />
              <strong>{t("transcription.reader.loading")}</strong>
              <span>{t("transcription.reader.loadingDescription")}</span>
            </div>
          ) : errorMessage !== null ? (
            <div className="meeting-transcript-dialog__state is-error" role="alert">
              <strong>{t("transcription.previewUnavailable")}</strong>
              {errorMessage ? <span>{errorMessage}</span> : null}
              {onRetry ? (
                <button type="button" onClick={onRetry}>
                  {t("transcription.actions.retryPreview")}
                </button>
              ) : null}
            </div>
          ) : document && search.visibleSegments.length > 0 ? (
            <ol className="meeting-transcript-dialog__segments">
              {search.visibleSegments.map((segment) => (
                <li key={segment.segmentId} data-testid="transcript-segment">
                  {onSegmentSelect ? (
                    <button
                      type="button"
                      className="meeting-transcript-dialog__time"
                      onClick={() => onSegmentSelect(segment.startMs)}
                      aria-label={t("transcription.jumpToTime", {
                        time: formatTranscriptTimestamp(segment.startMs),
                      })}
                    >
                      <AudioOutlined aria-hidden="true" />
                      {formatTranscriptTimestamp(segment.startMs)}
                    </button>
                  ) : (
                    <time className="meeting-transcript-dialog__time">
                      {formatTranscriptTimestamp(segment.startMs)}
                    </time>
                  )}
                  <div>
                    <p>{segment.text}</p>
                    <div className="meeting-transcript-dialog__meta">
                      <span className={`is-${segment.primarySourceId}`}>
                        {t(`transcription.sources.${segment.primarySourceId}`)}
                      </span>
                      {segment.speakerLabel ? <span>{segment.speakerLabel}</span> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="meeting-transcript-dialog__state">
              <SearchOutlined aria-hidden="true" />
              <strong>
                {search.query.trim()
                  ? t("transcription.noSearchResults")
                  : t("transcription.noSegments")}
              </strong>
            </div>
          )}
        </div>

        <footer className="meeting-transcript-dialog__footer">
          <span>
            {search.deferred
              ? t("transcription.reader.searching")
              : t("transcription.reader.renderedCount", {
                  visible: search.visibleSegments.length,
                  matching: search.matchingCount,
                })}
          </span>
          {search.canLoadMore ? (
            <button type="button" onClick={search.loadMore}>
              {t("transcription.reader.loadMore")}
            </button>
          ) : search.renderLimitReached ? (
            <strong>{t("transcription.reader.renderLimitReached")}</strong>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
}
