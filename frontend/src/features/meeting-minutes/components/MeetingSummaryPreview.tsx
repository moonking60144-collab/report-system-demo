import { MeetingPrintButton } from "./MeetingPrintButton";
import { ExpandOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { meetingOneShotHtmlUrl } from "../api/meetingRecordingApi";

export function MeetingSummaryPreview({ sessionId, versionId }: { sessionId: string; versionId?: string }) {
  const { t } = useTranslation("meetingMinutes");
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const previewUrl = `${meetingOneShotHtmlUrl(sessionId)}${versionId ? `?version=${encodeURIComponent(versionId)}` : ""}`;
  return <>
    <div className="meeting-preview-toolbar"><h3>{t("minutes.previewTitle")}</h3><div className="meeting-preview-actions"><MeetingPrintButton key={versionId} sessionId={sessionId} /><button onClick={() => { setExpanded(true); dialog.current?.showModal(); }}><ExpandOutlined aria-hidden="true" /> {t("oneShot.expandPreview")}</button></div></div>
    <iframe className="meeting-minutes-preview" title={t("minutes.previewTitle")} sandbox="" src={previewUrl} />
    <dialog ref={dialog} className="meeting-reading-dialog" aria-labelledby="meeting-reading-title" onClose={() => setExpanded(false)}>
      <div className="meeting-reading-dialog__heading"><h2 id="meeting-reading-title">{t("minutes.previewTitle")}</h2><div className="meeting-preview-actions">{expanded && <MeetingPrintButton key={versionId} sessionId={sessionId} />}<button autoFocus onClick={() => dialog.current?.close()}>{t("oneShot.closePreview")}</button></div></div>
      {expanded && <iframe title={t("oneShot.expandedPreviewTitle")} sandbox="" src={previewUrl} />}
    </dialog>
  </>;
}
