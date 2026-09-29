import { CheckOutlined, LoadingOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingOneShotStatus } from "../api/meetingRecordingApi";
import { getMeetingOneShotActiveJob } from "../pages/meetingOneShotPresentation";

const stages = ["recording", "processing", "transcribing", "summarizing"] as const;

export function MeetingProcessingProgress({ state }: { state: MeetingOneShotStatus | null }) {
  const { t } = useTranslation("meetingMinutes");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const current = state?.phase === "finalizing" ? 0 : stages.findIndex(stage => stage === state?.phase);
  const job = getMeetingOneShotActiveJob(state);
  const waitingRetry = job?.status === "failed" && job.attemptCount < job.maxAttempts;
  const queued = job?.status === "pending";
  const waiting = waitingRetry || queued;
  const since = Date.parse(job?.createdAt ?? "");
  const seconds = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 1_000)) : null;
  const elapsed = seconds === null ? null : `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return <div className="meeting-progress">
    <ol aria-label={t("oneShot.progressTitle")}>
      {stages.map((stage, index) => <li key={stage} className={index < current ? "is-complete" : index === current ? "is-current" : ""} aria-current={index === current ? "step" : undefined}>
        <span className="meeting-progress__marker" aria-hidden="true">{index < current ? <CheckOutlined /> : index === current && !waiting ? <LoadingOutlined spin /> : index + 1}</span>
        <span>{t(`oneShot.steps.${stage}`)}<small>{t(index < current ? "oneShot.stepComplete" : index === current ? waitingRetry ? "oneShot.waitingRetry" : queued ? "oneShot.stepQueued" : "oneShot.stepCurrent" : "oneShot.stepPending")}</small></span>
      </li>)}
    </ol>
    <div className="meeting-progress__detail">
      <p>{waitingRetry ? t("oneShot.retryWaitingHint", { attempts: job.attemptCount, maxAttempts: job.maxAttempts }) : t(queued ? "oneShot.queuedHint" : "oneShot.processingHint")}</p>
      {elapsed && <p className="meeting-progress__elapsed">{t("oneShot.stageElapsed")} <strong>{elapsed}</strong></p>}
    </div>
  </div>;
}
