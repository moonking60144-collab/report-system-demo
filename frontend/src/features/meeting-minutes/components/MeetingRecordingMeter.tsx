import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingAudioSourceId } from "../audio/useMeetingAudioCheck";

export function MeetingRecordingMeter({ getConnectedStreams }: {
  getConnectedStreams: () => Array<{ sourceId: MeetingAudioSourceId; stream: MediaStream }>;
}) {
  const { t } = useTranslation("meetingMinutes");
  const [levels, setLevels] = useState<Array<{ sourceId: MeetingAudioSourceId; level: number; connected: boolean }> | null>(null);
  useEffect(() => {
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const nodes: MediaStreamAudioSourceNode[] = [];
    try {
      context = new AudioContext();
      const meters = getConnectedStreams().map(({ sourceId, stream }) => {
        const source = context!.createMediaStreamSource(stream);
        const analyser = context!.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        nodes.push(source);
        return { sourceId, stream, analyser, samples: new Uint8Array(256) };
      });
      void context.resume().catch(() => undefined);
      timer = setInterval(() => {
        if (context?.state !== "running") { setLevels(null); return; }
        setLevels(meters.map(({ sourceId, stream, analyser, samples }) => {
          analyser.getByteTimeDomainData(samples);
          const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
          const connected = stream.getAudioTracks().some(track => track.readyState === "live" && !track.muted && track.enabled);
          return { sourceId, level: connected ? Math.min(1, rms * 4) : 0, connected };
        }));
      }, 150);
    } catch { /* Meter availability does not change recording ownership. */ }
    return () => {
      clearInterval(timer);
      nodes.forEach(node => node.disconnect());
      void context?.close().catch(() => undefined);
    };
  }, [getConnectedStreams]);
  return <div className="meeting-recording-meter">
    {levels?.length ? levels.map(({ sourceId, level, connected }) => <div key={sourceId}>
      <div className="meeting-recording-meter__label"><span>{t(sourceId === "room-mic" ? "oneShot.microphoneLevel" : "oneShot.remoteLevel")}</span><small>{t(!connected ? "oneShot.sourceDisconnected" : level > 0.02 ? "oneShot.soundDetected" : "oneShot.quietNow")}</small></div>
      <meter min={0} max={1} value={level} aria-label={t(sourceId === "room-mic" ? "oneShot.microphoneLevel" : "oneShot.remoteLevel")} />
    </div>) : <p>{t("oneShot.meterUnavailable")}</p>}
    <p>{t("oneShot.levelHint")}</p>
  </div>;
}
