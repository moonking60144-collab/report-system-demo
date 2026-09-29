import { EventEmitter } from "node:events";

export const MEETING_STATE_CHANGED = "meeting-state-changed";
const events = new EventEmitter();
events.setMaxListeners(0);

// Only an invalidation signal crosses process/browser boundaries; snapshots remain authorized reads.
export function notifyMeetingStateChanged(): void {
  for (const listener of events.listeners(MEETING_STATE_CHANGED)) {
    try { listener(); } catch { /* Delivery failures must never fail a committed mutation. */ }
  }
}

export function subscribeMeetingStateChanges(listener: () => void): () => void {
  events.on(MEETING_STATE_CHANGED, listener);
  return () => { events.off(MEETING_STATE_CHANGED, listener); };
}
