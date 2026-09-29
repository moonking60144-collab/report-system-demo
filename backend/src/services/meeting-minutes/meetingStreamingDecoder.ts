import { spawn } from "node:child_process";
import path from "node:path";
import type { MeetingLiveTranscriptionRepository } from "../../storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { LIVE_CONTEXT_MS, LIVE_WINDOW_MS, PCM_BYTES_PER_MS, liveWindow, pcmHash, pcmWave } from "./meetingLiveAudio";
import type { MeetingLiveAudioQuota } from "./meetingLiveAudioQuota";

export class MeetingStreamingDecoder {
  private readonly child;
  private buffers: Buffer[] = [];
  private bufferStart = 0;
  private received = 0;
  private index = 0;
  private ended = false;
  private stopped = false;
  complete = false;
  error: Error | null = null;
  readonly completion: Promise<void>;
  offset = 0;

  constructor(private readonly input: {
    sessionId: string; sourceId: "room-mic" | "remote-tab"; profile: string;
    processingDir: string; ffmpegPath: string; repository: MeetingLiveTranscriptionRepository; quota: MeetingLiveAudioQuota;
    decoderLeaseId?: string;
  }) {
    this.child = spawn(input.ffmpegPath, ["-v", "error", "-probesize", "32768", "-analyzeduration", "0",
      "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], { windowsHide: true });
    const child = this.child;
    let stderr = "";
    this.child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
    const closed = new Promise<void>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", code => code === 0 ? resolve() : reject(new Error(`Live decoder exited ${code}: ${stderr}`)));
    });
    void closed.catch(() => undefined);
    this.child.stdin.on("error", error => { if (!this.stopped) this.error = error; });
    this.completion = (async () => {
      for await (const chunk of child.stdout) {
        if (this.stopped) break;
        const body: Buffer = chunk;
        this.received += body.length;
        this.buffers.push(body);
        await this.flush(false);
      }
      await closed;
      if (this.stopped) return;
      if (!this.ended) throw new Error("Live decoder stopped before recording EOF");
      await this.flush(true);
      if (this.stopped) return;
      await input.repository.source(input.sessionId, input.sourceId, input.profile, this.received / PCM_BYTES_PER_MS, true);
      this.complete = true;
    })().catch(error => {
      if (!this.stopped) this.error = error instanceof Error ? error : new Error(String(error));
      this.child.kill();
    });
  }

  async feed(body: Buffer, eof: boolean): Promise<void> {
    if (this.error) throw this.error;
    if (this.ended || this.stopped) return;
    if (body.length) {
      try { await new Promise<void>((resolve, reject) => this.child.stdin.write(body, error => error ? reject(error) : resolve())); }
      catch (error) { if (!this.stopped) throw error; return; }
      this.offset += body.length;
    }
    if (eof) { this.ended = true; this.child.stdin.end(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child.stdin.destroy();
    this.child.kill();
    await this.completion;
  }

  private async flush(final: boolean): Promise<void> {
    while (!this.stopped) {
      const coreStart = this.index * LIVE_WINDOW_MS * PCM_BYTES_PER_MS;
      if (coreStart >= this.received) return;
      const needed = coreStart + (LIVE_WINDOW_MS + LIVE_CONTEXT_MS) * PCM_BYTES_PER_MS;
      if (!final && this.received < needed) return;
      const window = liveWindow(this.index, this.received / PCM_BYTES_PER_MS);
      const from = window.windowStartMs * PCM_BYTES_PER_MS;
      const until = window.windowEndMs * PCM_BYTES_PER_MS;
      const parts: Buffer[] = [];
      let offset = this.bufferStart;
      for (const body of this.buffers) {
        if (offset >= until) break;
        if (offset + body.length > from) parts.push(body.subarray(Math.max(0, from - offset), Math.min(body.length, until - offset)));
        offset += body.length;
      }
      const pcm = Buffer.concat(parts, until - from);
      const directory = path.join(this.input.processingDir, this.input.sessionId, "live-transcript", this.input.sourceId);
      const audioPath = path.join(directory, `${this.index}-${this.input.profile}.wav`);
      const chunk = { ...window, sessionId: this.input.sessionId,
        sourceId: this.input.sourceId, profile: this.input.profile, chunkIndex: this.index,
        audioPath, audioHash: pcmHash(pcm) };
      if (await this.input.repository.cached(chunk) === null) {
        if (!await this.input.quota.write(audioPath, pcmWave(pcm))) {
          await this.input.repository.deferSource(this.input.sessionId, this.input.sourceId, this.input.profile);
          this.complete = true;
          this.stopped = true;
          this.buffers = [];
          this.child.stdin.destroy();
          this.child.kill();
          return;
        }
        await this.input.repository.register(chunk, this.input.decoderLeaseId);
      }
      await this.input.repository.source(this.input.sessionId, this.input.sourceId, this.input.profile, window.endMs, false);
      this.index++;
      const retainFrom = Math.max(0, this.index * LIVE_WINDOW_MS - LIVE_CONTEXT_MS) * PCM_BYTES_PER_MS;
      let discard = retainFrom - this.bufferStart;
      while (discard > 0 && this.buffers.length) {
        const head = this.buffers[0];
        if (discard < head.length) { this.buffers[0] = head.subarray(discard); break; }
        discard -= head.length; this.buffers.shift();
      }
      this.bufferStart = retainFrom;
    }
  }
}
