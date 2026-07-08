export function shouldApplyDevAiThreadDetailSnapshot(
  requestRevision: number,
  currentRevision: number
): boolean {
  return requestRevision === currentRevision;
}
