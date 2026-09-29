import { LoadingOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { adoptMeetingSummaryRevision, discardMeetingSummaryRevision, meetingRevisionHtmlUrl, requestMeetingSummaryRevision,
  resolveMeetingRecordingApiError, type MeetingMinutesJob, type MeetingMinutesVersion } from "../api/meetingRecordingApi";

export function MeetingSummaryRevision({ sessionId, version, revision, refresh, queued }: {
  sessionId: string;
  version: MeetingMinutesVersion;
  revision: MeetingMinutesJob | null;
  refresh: () => void;
  queued: (job: MeetingMinutesJob) => void;
}) {
  const { t } = useTranslation("meetingMinutes");
  const [draft, setDraft] = useState("");
  const [confirmedFacts, setConfirmedFacts] = useState("");
  const [acknowledgedToken, setAcknowledgedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const panel = useRef<HTMLDetailsElement>(null);
  const revisionId = revision?.jobId;
  const revisionStatus = revision?.status;
  useEffect(() => {
    if (revisionId && panel.current) panel.current.open = true;
  }, [revisionId, revisionStatus]);
  const request = useRef<{ text: string; key: string } | null>(null);
  const pending = revision && (revision.status === "pending" || revision.status === "running" || (revision.status === "failed" && revision.attemptCount < revision.maxAttempts));
  const comparison = revision?.revisionChanges;
  const canAdopt = comparison && (!comparison.requiresAcknowledgement || acknowledgedToken === comparison.acknowledgementToken);
  const act = async (action: "generate" | "adopt" | "discard") => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (action === "generate") {
        const text = draft.trim();
        const facts = confirmedFacts.trim();
        if ((!text && !facts) || revision) return;
        const payloadKey = JSON.stringify({ text, facts });
        if (request.current?.text !== payloadKey) request.current = { text: payloadKey, key: crypto.randomUUID() };
        queued(await requestMeetingSummaryRevision(sessionId, version.versionId, text, request.current.key, facts));
      } else if (revision) {
        if (action === "adopt") {
          if (!canAdopt) return;
          await adoptMeetingSummaryRevision(sessionId, revision.jobId, version.versionId, acknowledgedToken ?? undefined);
          setDraft("");
          setConfirmedFacts("");
        } else {
          await discardMeetingSummaryRevision(sessionId, revision.jobId);
          setDraft(revision.input.revisionRequest ?? "");
          setConfirmedFacts(revision.input.revisionConfirmedFacts ?? "");
        }
        request.current = null;
        setAcknowledgedToken(null);
      }
    } catch (cause) {
      setError(resolveMeetingRecordingApiError(cause) ?? t("oneShot.revisionFailed"));
    } finally {
      refresh(); inFlight.current = false; setBusy(false);
    }
  };
  return <details ref={panel} className="meeting-summary-revision">
    <summary>{t("oneShot.revisionTitle")}</summary>
    <div className="meeting-additional-sections">
      <label htmlFor="meeting-summary-revision-input">{t("oneShot.revisionLabel")}</label>
      <textarea id="meeting-summary-revision-input" rows={4} maxLength={2000} value={revision?.input.revisionRequest ?? draft}
        disabled={busy || Boolean(revision)} placeholder={t("oneShot.revisionPlaceholder")}
        aria-describedby="meeting-summary-revision-hint" onChange={event => setDraft(event.target.value)} />
      <p id="meeting-summary-revision-hint">{t("oneShot.revisionHint")}</p>
      <details className="meeting-revision-facts">
        <summary>{t("oneShot.revisionFactsTitle")}</summary>
        <label htmlFor="meeting-revision-confirmed-facts">{t("oneShot.revisionFactsLabel")}</label>
        <textarea id="meeting-revision-confirmed-facts" rows={3} maxLength={2000} value={revision?.input.revisionConfirmedFacts ?? confirmedFacts}
          disabled={busy || Boolean(revision)} placeholder={t("oneShot.revisionFactsPlaceholder")}
          aria-describedby="meeting-revision-facts-hint" onChange={event => setConfirmedFacts(event.target.value)} />
        <p id="meeting-revision-facts-hint">{t("oneShot.revisionFactsHint")}</p>
      </details>
      {error && <p role="alert">{error}</p>}
      {!revision && <div className="meeting-revision-actions"><button disabled={busy || (!draft.trim() && !confirmedFacts.trim())} onClick={() => void act("generate")}>
        {busy && <LoadingOutlined spin aria-hidden="true" />}{t("oneShot.revisionGenerate")}</button></div>}
      {pending && <p role="status"><LoadingOutlined spin aria-hidden="true" /> {t("oneShot.revisionProcessing")}</p>}
      {revision?.status === "failed" && !pending && <p role="alert">{revision.errorMessage ?? t("oneShot.revisionFailed")}</p>}
      {revision?.status === "ready" && <>
        {revision.revisionComparisonError && <p role="alert">{revision.revisionComparisonError}</p>}
        {comparison && <details className="meeting-revision-diff" open={comparison.requiresAcknowledgement || undefined}>
          <summary>{t("oneShot.revisionChangesTitle")}</summary>
          {!comparison.entries.length && <p>{t("oneShot.revisionNoChanges")}</p>}
          {comparison.entries.map(entry => <section key={entry.field}>
            <h4>{t(`oneShot.revisionFields.${entry.field}`)}</h4>
            {entry.removed.length > 0 && <><p>{t("oneShot.revisionPrevious")}</p><ul>{entry.removed.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
            {entry.added.length > 0 && <><p>{t("oneShot.revisionCandidate")}</p><ul>{entry.added.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
          </section>)}
        </details>}
        <h3>{t("oneShot.revisionPreview")}</h3>
        <iframe className="meeting-minutes-preview" title={t("oneShot.revisionPreview")} sandbox="" src={meetingRevisionHtmlUrl(sessionId, revision.jobId)} />
        <p>{t("oneShot.revisionConfirmHint")}</p>
        {comparison?.requiresAcknowledgement && <label className="meeting-revision-acknowledgement"><input type="checkbox"
          checked={acknowledgedToken === comparison.acknowledgementToken} disabled={busy}
          onChange={event => setAcknowledgedToken(event.target.checked ? comparison.acknowledgementToken : null)} />
          <span>{t("oneShot.revisionAcknowledge")}</span></label>}
      </>}
      {revision && !pending && <div className="meeting-revision-actions">
        {revision.status === "ready" && <button className="meeting-revision-primary" disabled={busy || !canAdopt} onClick={() => void act("adopt")}>{t("oneShot.revisionAdopt")}</button>}
        <button disabled={busy} onClick={() => void act("discard")}>{t("oneShot.revisionDiscard")}</button>
      </div>}
    </div>
  </details>;
}
