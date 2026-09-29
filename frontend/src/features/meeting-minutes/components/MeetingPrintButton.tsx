import { LoadingOutlined, PrinterOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchMeetingOneShotHtml } from "../api/meetingRecordingApi";

export function MeetingPrintButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("meetingMinutes");
  const frame = useRef<HTMLIFrameElement>(null);
  const request = useRef<AbortController | null>(null);
  const [document, setDocument] = useState<{ html: string; id: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => () => { request.current?.abort(); }, [sessionId]);
  const prepare = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(false);
    try {
      const html = await fetchMeetingOneShotHtml(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const policy = parsed.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
      parsed.head.prepend(policy);
      setDocument({ html: `<!DOCTYPE html>${parsed.documentElement.outerHTML}`, id: Date.now() });
    } catch {
      if (!controller.signal.aborted) { setError(true); setBusy(false); request.current = null; }
    }
  };
  const print = async () => {
    const target = frame.current;
    if (!target || !request.current || request.current.signal.aborted) return;
    try {
      await target.contentDocument?.fonts.ready;
      if (frame.current !== target || request.current?.signal.aborted) return;
      target.contentWindow?.focus();
      target.contentWindow?.print();
    } catch { setError(true); }
    finally { setBusy(false); request.current = null; }
  };
  return <div className="meeting-print-control">
    <button disabled={busy} onClick={() => void prepare()}>{busy ? <LoadingOutlined spin aria-hidden="true" /> : <PrinterOutlined aria-hidden="true" />} {t(busy ? "oneShot.preparingPrint" : "oneShot.print")}</button>
    {error && <p role="alert">{t("oneShot.printFailed")}</p>}
    {document && <iframe key={document.id} ref={frame} title={t("oneShot.printDocument")} className="meeting-print-frame" tabIndex={-1} aria-hidden="true" sandbox="allow-same-origin allow-modals" srcDoc={document.html} onLoad={() => void print()} />}
  </div>;
}
