import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { meetingOneShotRepository, type MeetingOneShotRepository } from "../../storage/meeting-minutes/meetingOneShotRepository";
import { meetingLiveTranscriptionRepository, type MeetingLiveTranscriptionRepository } from "../../storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { meetingRecordingStorageService, type MeetingRecordingStorageService } from "./meetingRecordingStorageService";
import { meetingTranscriptionProvider } from "./meetingTranscriptionProviderFactory";
import type { MeetingTranscriptionProviderLike } from "./meetingTranscriptionProvider";
import { MeetingStreamingDecoder } from "./meetingStreamingDecoder";
import { scheduleMeetingTranscription } from "./meetingTranscriptionScheduler";
import { MeetingLiveAudioQuota } from "./meetingLiveAudioQuota";
import { pcmHash } from "./meetingLiveAudio";
import { meetingTranscriptionJobRepository, type MeetingTranscriptionJobRepository } from "../../storage/meeting-minutes/meetingTranscriptionJobRepository";

export function liveTranscriptionProfile(provider: MeetingTranscriptionProviderLike, language = env.MEETING_TRANSCRIPTION_LANGUAGE): string {
  return pcmHash(Buffer.from(JSON.stringify(["live-v2",provider.name,provider.model,provider.inferenceProfile,language,env.MEETING_TRANSCRIPTION_PHRASES]))).slice(0, 24);
}
const log = createLogger("meeting-live-transcription");
export class MeetingLiveTranscriptionService {
  private readonly repository;
  private readonly sessions;
  private readonly recordings;
  private readonly provider;
  private readonly transcriptionJobs;
  readonly profile: string;
  private readonly processingDir;
  private readonly ffmpegPath;
  private readonly quota;
  private readonly decoders = new Map<string, MeetingStreamingDecoder>();
  private readonly decoderLeaseId = randomUUID();
  private readonly decoderHeartbeats = new Map<string, NodeJS.Timeout>();
  private readonly retryAt = new Map<string, number>();
  private readonly sealed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private inferenceTimer: NodeJS.Timeout | null = null;
  private inference: Promise<boolean> | null = null;
  private pumping: Promise<void> | null = null;
  private stopping = false;
  private current: AbortController | null = null;
  private currentSessionId: string | null = null;
  constructor(deps: { repository?: MeetingLiveTranscriptionRepository; sessions?: MeetingOneShotRepository;
    recordings?: MeetingRecordingStorageService; provider?: MeetingTranscriptionProviderLike; processingDir?: string; ffmpegPath?: string;
    transcriptionJobs?: MeetingTranscriptionJobRepository; maxLiveAudioBytes?: number; minFreeBytes?: number } = {}) {
    this.repository = deps.repository ?? meetingLiveTranscriptionRepository;
    this.sessions = deps.sessions ?? meetingOneShotRepository;
    this.recordings = deps.recordings ?? meetingRecordingStorageService;
    this.provider = scheduleMeetingTranscription(deps.provider ?? meetingTranscriptionProvider);
    this.transcriptionJobs = deps.transcriptionJobs ?? meetingTranscriptionJobRepository;
    this.processingDir = deps.processingDir ?? env.MEETING_PROCESSING_DIR;
    this.ffmpegPath = deps.ffmpegPath ?? env.MEETING_FFMPEG_PATH;
    this.quota = new MeetingLiveAudioQuota(this.processingDir, deps.maxLiveAudioBytes ?? env.MEETING_LIVE_MAX_AUDIO_BYTES,
      deps.minFreeBytes ?? env.MEETING_LIVE_MIN_FREE_BYTES);
    this.profile = liveTranscriptionProfile(this.provider);
  }
  start() {
    void this.repository.retireOtherProfiles(this.provider.enabled ? this.profile : null, Date.now())
      .catch(error => log.warn({ event: "profile-reconciliation-failed", error: String(error) }));
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pump().catch(error => log.warn({ event: "decode-pump-failed", error: String(error) })); }, 1000);
    this.timer.unref();
    if (this.provider.enabled) this.scheduleInference(0);
  }
  private scheduleInference(delay: number) {
    if (this.stopping) return;
    this.inferenceTimer = setTimeout(() => {
      this.inferenceTimer = null;
      void this.runOnce().then(worked => this.scheduleInference(worked ? 0 : 1000))
        .catch(error => { log.warn({ event: "live-inference-failed", error: String(error) }); this.scheduleInference(1000); });
    }, delay);
    this.inferenceTimer.unref();
  }
  pump(): Promise<void> {
    this.pumping ??= this.pumpInternal().finally(() => { this.pumping = null; });
    return this.pumping;
  }
  private async pumpInternal() {
    if (this.stopping) return;
    await this.repository.retireOtherProfiles(this.provider.enabled ? this.profile : null, Date.now());
    if (!this.provider.enabled) return;
    await this.sessions.expireRecorderLeases(new Date().toISOString());
    const active = new Set<string>();
    for (const sessionId of await this.sessions.protectedSessionIds()) {
      const entry = await this.sessions.get(sessionId);
      if (!entry || entry.expiresAt || entry.cleanupStartedAt || entry.pipelineReleasedAt) continue;
      if (entry.cancelRequestedAt) { await this.seal(sessionId); continue; }
      if (await this.transcriptionJobs.getJobBySessionForOwner(sessionId,entry.ownerId)) { await this.seal(sessionId); continue; }
      if (!entry.recordingFinalizedAt && !(entry.recorderLeaseUntil && entry.recorderLeaseUntil > new Date().toISOString())) continue;
      try {
        const session = await this.recordings.getSession(sessionId, entry.ownerId);
        for (const track of session.tracks) {
          if (this.stopping) return;
          if (this.sealed.has(sessionId)) break;
          const key = `${sessionId}:${track.sourceId}`;
          if ((this.retryAt.get(key) ?? 0) > Date.now()) continue;
          if (await this.repository.sourceComplete(sessionId, track.sourceId, this.profile)) continue;
          if (this.stopping) return;
          let decoder = this.decoders.get(key);
          if (!decoder && (this.decoders.size >= 8 || track.chunkCount === 0)) continue;
          if (!await this.repository.renewDecoderLease(sessionId, track.sourceId, this.profile, this.decoderLeaseId, Date.now(), 120_000)) continue;
          if (this.stopping || this.sealed.has(sessionId)) {
            await this.repository.releaseDecoderLease(this.decoderLeaseId, sessionId, track.sourceId);
            continue;
          }
          active.add(key);
          if (!decoder) {
            await this.repository.source(sessionId, track.sourceId, this.profile, 0, false);
            if (this.stopping || this.sealed.has(sessionId)) {
              await this.repository.releaseDecoderLease(this.decoderLeaseId, sessionId, track.sourceId);
              continue;
            }
            decoder = new MeetingStreamingDecoder({ sessionId, sourceId: track.sourceId, profile: this.profile,
              repository: this.repository, processingDir: this.processingDir, ffmpegPath: this.ffmpegPath, quota: this.quota,
              decoderLeaseId: this.decoderLeaseId });
            this.decoders.set(key, decoder);
            const heartbeat = setInterval(() => {
              void this.repository.heartbeatDecoderLease(sessionId, track.sourceId, this.profile, this.decoderLeaseId, Date.now() + 120_000)
                .then(owned => { if (!owned) return this.stopDecoder(key, decoder!); })
                .catch(error => log.warn({ event: "decoder-lease-renewal-failed", sessionId, error: String(error) }));
            }, 30_000);
            heartbeat.unref();
            this.decoderHeartbeats.set(key, heartbeat);
          }
          try {
            for (let reads = 0; reads < 16; reads++) {
              const slice = await this.recordings.readStreamingAudio(sessionId, entry.ownerId, track.sourceId, decoder.offset);
              await decoder.feed(slice.body, slice.eof);
              if (!slice.body.length || slice.eof) break;
            }
            if (decoder.error) throw decoder.error;
          } catch (error) {
            await this.stopDecoder(key, decoder); this.retryAt.set(key, Date.now() + 30_000);
            log.warn({ event: "decode-retry", sessionId, sourceId: track.sourceId, error: String(error) });
          }
        }
      } catch (error) { log.warn({ event: "session-read-failed", sessionId, error: String(error) }); }
    }
    for (const [key, decoder] of this.decoders) {
      if (!active.has(key) || decoder.complete) await this.stopDecoder(key, decoder);
    }
  }
  runOnce(): Promise<boolean> {
    this.inference ??= this.runOnceInternal().finally(() => { this.inference = null; });
    return this.inference;
  }
  private async runOnceInternal(): Promise<boolean> {
    if (this.stopping || !this.provider.enabled) return false;
    await this.repository.retireOtherProfiles(this.profile, Date.now());
    const lease = randomUUID();
    const chunk = await this.repository.claim(this.profile, lease, Date.now(), 120_000);
    if (!chunk) return false;
    if (this.sealed.has(chunk.sessionId)) { await this.repository.seal(chunk.sessionId); return true; }
    if (this.stopping) { await this.repository.fail(lease,"Worker stopping",Date.now(),true); return false; }
    const controller = new AbortController(); this.current = controller;
    this.currentSessionId = chunk.sessionId;
    const heartbeat = setInterval(() => { void this.repository.heartbeat(lease,Date.now()+120_000)
      .then(owned => { if (!owned) controller.abort(); }).catch(() => controller.abort()); },30_000);
    try {
      const session = await this.sessions.get(chunk.sessionId);
      if (!session || session.expiresAt || session.cleanupStartedAt || session.pipelineReleasedAt) {
        await this.repository.forget(chunk.sessionId);
        return true;
      }
      if (session.cancelRequestedAt) { await this.repository.seal(chunk.sessionId); return true; }
      await this.recordings.getSession(chunk.sessionId, session.ownerId);
      const segments = await this.provider.transcribe({ audioPath: chunk.audioPath, mimeType: "audio/wav",
        sourceId: chunk.sourceId, language: env.MEETING_TRANSCRIPTION_LANGUAGE,
        durationMs: chunk.windowEndMs - chunk.windowStartMs, signal: controller.signal });
      if (!controller.signal.aborted) {
        if (await this.repository.finish(lease, segments)) await rm(chunk.audioPath,{force:true}).catch(error=>log.warn({event:"chunk-cleanup-failed",error:String(error)}));
      }
      else await this.repository.fail(lease,"Aborted",Date.now(),true);
    } catch (error) { await this.repository.fail(lease,String(error),Date.now(),controller.signal.aborted); }
    finally { clearInterval(heartbeat); if (this.current === controller) { this.current = null; this.currentSessionId = null; } }
    return true;
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inferenceTimer) clearTimeout(this.inferenceTimer);
    this.current?.abort();
    await Promise.all([...this.decoders].map(([key, decoder]) => this.stopDecoder(key, decoder)));
    await this.pumping;
    await this.inference;
    await Promise.all([...this.decoders].map(([key, decoder]) => this.stopDecoder(key, decoder)));
    this.decoders.clear();
    await this.repository.releaseDecoderLease(this.decoderLeaseId);
  }
  close() { return this.repository.close(); }
  async seal(sessionId: string) {
    this.sealed.add(sessionId);
    // Cancelling HTTP does not stop Python inference. Preserve its checkpoint
    // before the final processor starts another request on the same STT slot.
    if (this.currentSessionId === sessionId) await this.inference;
    for (const [key,decoder] of this.decoders) {
      if (key.startsWith(`${sessionId}:`)) await this.stopDecoder(key, decoder);
    }
    await this.repository.seal(sessionId);
  }
  async cleanupSession(sessionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Invalid live cleanup identity");
    await this.seal(sessionId);
    await this.pumping;
    await this.seal(sessionId);
    await rm(path.join(this.processingDir,sessionId,"live-transcript"),{ recursive:true,force:true });
    await this.repository.forget(sessionId);
    await this.releaseSessionState(sessionId);
  }
  async releaseSessionState(sessionId: string) {
    for (const [key, decoder] of [...this.decoders]) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      await this.stopDecoder(key, decoder);
    }
    for (const key of [...this.retryAt.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.retryAt.delete(key);
    }
    this.sealed.delete(sessionId);
  }
  private async stopDecoder(key: string, decoder: MeetingStreamingDecoder): Promise<void> {
    await decoder.stop();
    const heartbeat = this.decoderHeartbeats.get(key);
    if (heartbeat) clearInterval(heartbeat);
    this.decoderHeartbeats.delete(key);
    this.decoders.delete(key);
    const separator = key.indexOf(":");
    await this.repository.releaseDecoderLease(this.decoderLeaseId, key.slice(0, separator), key.slice(separator + 1));
  }
}
export const meetingLiveTranscriptionService = new MeetingLiveTranscriptionService();
