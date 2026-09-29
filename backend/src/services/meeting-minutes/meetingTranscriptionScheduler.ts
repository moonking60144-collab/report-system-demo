import { MeetingTranscriptionError, type MeetingTranscriptionProviderLike } from "./meetingTranscriptionProvider";

const scheduled = new WeakMap<MeetingTranscriptionProviderLike, MeetingTranscriptionProviderLike>();

// Live and final processors share the provider, including their cancellation queue.
export function scheduleMeetingTranscription(provider: MeetingTranscriptionProviderLike): MeetingTranscriptionProviderLike {
  const existing = scheduled.get(provider);
  if (existing) return existing;
  let tail: Promise<void> = Promise.resolve();
  const wrapped: MeetingTranscriptionProviderLike = {
    get enabled() { return provider.enabled; },
    get name() { return provider.name; },
    get model() { return provider.model; },
    get inferenceProfile() { return provider.inferenceProfile; },
    async transcribe(input) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      const aborted = () => new MeetingTranscriptionError("逐字稿處理已中止。", "MEETING_TRANSCRIPTION_ABORTED");
      let onAbort!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        onAbort = () => reject(aborted());
        if (input.signal?.aborted) onAbort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      let started = false;
      try {
        await Promise.race([previous, cancellation]);
        input.signal?.removeEventListener("abort", onAbort);
        if (input.signal?.aborted) throw aborted();
        started = true;
        return await provider.transcribe(input);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        // An aborted waiter must not allow its successor to overtake the running call.
        if (started) release();
        else void previous.then(release);
      }
    },
  };
  scheduled.set(provider, wrapped);
  scheduled.set(wrapped, wrapped);
  return wrapped;
}
