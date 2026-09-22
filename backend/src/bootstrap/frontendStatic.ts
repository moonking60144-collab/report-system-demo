import express, { Express } from "express";
import fs from "fs";
import path from "path";
import { env } from "../config/env";

export interface FrontendStaticSetupResult {
  shouldServeFrontend: boolean;
  frontendStaticDir: string;
}

export function setupFrontendStaticServing(app: Express): FrontendStaticSetupResult {
  const frontendStaticDir = env.FRONTEND_STATIC_DIR.trim();
  const shouldServeFrontend =
    env.SERVE_FRONTEND_FROM_BACKEND &&
    frontendStaticDir.length > 0 &&
    fs.existsSync(frontendStaticDir);

  if (!env.SERVE_FRONTEND_FROM_BACKEND) {
    return { shouldServeFrontend, frontendStaticDir };
  }

  if (!shouldServeFrontend) {
    console.warn("[frontend-static-disabled]", {
      reason: frontendStaticDir ? "directory-not-found" : "missing-frontend-static-dir",
      frontendStaticDir,
    });
    return { shouldServeFrontend, frontendStaticDir };
  }

  app.use(
    express.static(frontendStaticDir, {
      index: "index.html",
    })
  );

  // Temporary rescue mode: serve SPA routes from backend while keeping /api untouched.
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(frontendStaticDir, "index.html"));
  });

  return { shouldServeFrontend, frontendStaticDir };
}
