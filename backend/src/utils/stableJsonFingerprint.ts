import { createHash } from "crypto";

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJsonValue(item)])
  );
}

export function createStableJsonFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeJsonValue(value)))
    .digest("hex");
}
