import fs from "fs";
import path from "path";
import { env } from "../config/env";

export function createFrontendBuildReader(directory: string, now = Date.now) {
  let cachedUntil = 0;
  let buildId: string | null = null;
  return (): string | null => {
    if (now() < cachedUntil) return buildId;
    cachedUntil = now() + 1_000;
    buildId = null;
    if (!directory.trim()) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(directory, "version.json"), "utf8")) as { buildId?: unknown };
      if (typeof payload.buildId === "string" && payload.buildId.trim()) buildId = payload.buildId.trim();
    } catch {
      // Older releases and the brief publication window have no usable build marker.
    }
    return buildId;
  };
}

export const readFrontendBuildId = createFrontendBuildReader(env.FRONTEND_STATIC_DIR);
