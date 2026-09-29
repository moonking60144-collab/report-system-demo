import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMeetingSttPython } from "./meeting-stt-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.join(root, "backend");
const frontendDir = path.join(root, "frontend");
const meetingSttDir = path.join(root, "services", "meeting-stt");
const mode = process.argv[2];

if (mode !== "demo" && mode !== "dev") {
  console.error("Usage: node scripts/run-local.mjs <demo|dev>");
  process.exit(1);
}

function readPort(name, fallback) {
  const value = process.env[name] ?? fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535`);
  }
  return String(port);
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

const backendPort = readPort("PORT", "3300");
const frontendPort = readPort("FRONTEND_PORT", "5174");
if (backendPort === frontendPort) {
  throw new Error("PORT and FRONTEND_PORT must be different");
}

const children = new Set();
let stopping = false;

function run(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.pid && child.exitCode === null) child.kill("SIGINT");
  }

  const fallback = setTimeout(() => {
    for (const child of children) {
      if (!child.pid || child.exitCode !== null) continue;
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => {});
      } else {
        child.kill("SIGKILL");
      }
    }
  }, 3000);
  fallback.unref();
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

async function installIfNeeded(directory, label) {
  if (existsSync(path.join(directory, "node_modules"))) return;
  console.log(`[${label}] Installing dependencies with npm ci...`);
  const child = process.platform === "win32"
    ? run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm ci"], { cwd: directory })
    : run("npm", ["ci"], { cwd: directory });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) throw new Error(`[${label}] npm ci failed (${code ?? "signal"})`);
}

function startServer(label, command, args, directory, env) {
  const child = run(command, args, { cwd: directory, env });
  child.once("error", (error) => {
    if (!stopping) {
      console.error(`[${label}] ${error.message}`);
      stop(1);
    }
  });
  child.once("close", (code, signal) => {
    if (!stopping) {
      console.error(`[${label}] exited (${code ?? signal ?? "unknown"})`);
      stop(code || 1);
    }
  });
}

async function main() {
  await installIfNeeded(backendDir, "backend");
  if (stopping) return;
  await installIfNeeded(frontendDir, "frontend");
  if (stopping) return;

  const parseEnv = createRequire(path.join(backendDir, "package.json"))("dotenv").parse;
  const backendEnvFile = path.join(backendDir, ".env");
  const backendSettings = {
    ...(existsSync(backendEnvFile) ? parseEnv(readFileSync(backendEnvFile)) : {}),
    ...process.env,
  };

  const backendEnv = {
    ...process.env,
    PORT: backendPort,
    CORS_ORIGIN: process.env.CORS_ORIGIN
      ?? `http://localhost:${frontendPort},http://127.0.0.1:${frontendPort}`,
    NODE_ENV: "development",
    SERVE_FRONTEND_FROM_BACKEND: "false",
  };
  if (mode === "demo") {
    backendEnv.DEMO_MODE = "true";
    backendEnv.DEMO_FAULT_INJECTION_ENABLED =
      process.env.DEMO_FAULT_INJECTION_ENABLED ?? "true";
    backendEnv.RAGIC_WRITE_TARGET = "test";
  }

  const frontendEnv = {
    ...process.env,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL
      ?? `http://127.0.0.1:${backendPort}/api`,
  };

  if (mode === "demo") {
    console.log("[demo] Building backend without file watching...");
    const build = run(process.execPath, [
      path.join(backendDir, "node_modules", "typescript", "bin", "tsc"),
      "-p", "tsconfig.build.json",
    ], { cwd: backendDir, env: backendEnv });
    const code = await new Promise((resolve, reject) => {
      build.once("error", reject);
      build.once("close", (exitCode) => resolve(exitCode));
    });
    if (code !== 0) throw new Error(`[demo] Backend build failed (${code ?? "signal"})`);
    if (stopping) return;

    const transcriptionUrl = String(backendSettings.MEETING_TRANSCRIPTION_LOCAL_URL ?? "").trim();
    const endpoint = transcriptionUrl ? new URL(transcriptionUrl) : null;
    if (
      isEnabled(backendSettings.MEETING_WORKER_ENABLED) &&
      backendSettings.MEETING_TRANSCRIPTION_PROVIDER === "local-whisper" &&
      endpoint && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    ) {
      const sttEnvFile = path.join(meetingSttDir, ".env");
      const sttSettings = {
        ...(existsSync(sttEnvFile) ? parseEnv(readFileSync(sttEnvFile)) : {}),
        ...process.env,
      };
      const model = sttSettings.MEETING_STT_MODEL || "large-v3";
      const beamSize = Number(sttSettings.MEETING_STT_BEAM_SIZE || 1);
      const expectedModel = backendSettings.MEETING_TRANSCRIPTION_LOCAL_MODEL || "large-v3";
      const expectedBeamSize = Number(backendSettings.MEETING_TRANSCRIPTION_BEAM_SIZE || 1);
      const sttPort = Number(sttSettings.MEETING_STT_PORT || 8010);
      if (model !== expectedModel || beamSize !== expectedBeamSize || sttPort !== Number(endpoint.port || 80)) {
        throw new Error("[demo] Meeting STT model, beam size, or port does not match backend settings");
      }
      const python = await ensureMeetingSttPython(meetingSttDir, {
        run,
        env: process.env,
        diarizationEnabled: isEnabled(sttSettings.MEETING_STT_DIARIZATION_ENABLED),
        isStopping: () => stopping,
      });
      if (stopping) return;
      startServer("meeting-stt", python, ["-m", "app"], meetingSttDir, process.env);
      const healthUrl = new URL("/health", endpoint);
      const token = String(backendSettings.MEETING_TRANSCRIPTION_LOCAL_TOKEN ?? "").trim();
      const deadline = Date.now() + 300_000;
      let ready = false;
      while (!stopping && Date.now() < deadline) {
        try {
          const response = await fetch(healthUrl, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(2_000),
          });
          if (response.ok) {
            const status = await response.json();
            if (status.status !== "ok" || status.model !== model || status.beamSize !== beamSize) {
              throw new Error("[demo] Meeting STT health profile does not match backend settings");
            }
            ready = true;
            break;
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error("[demo] Meeting STT health authentication failed");
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("[demo]")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (stopping) return;
      if (!ready) throw new Error("[demo] Meeting STT did not become ready within five minutes");
      console.log(`[demo] Meeting STT ready: ${healthUrl.origin}`);
    }
  }

  console.log(`[${mode}] Frontend: http://127.0.0.1:${frontendPort}`);
  console.log(`[${mode}] Backend: http://127.0.0.1:${backendPort}`);

  startServer(
    "backend",
    process.execPath,
    [path.join(backendDir, "scripts", "start-backend.js"), mode === "demo" ? "prod" : "dev"],
    backendDir,
    backendEnv,
  );
  startServer(
    "frontend",
    process.execPath,
    [path.join(frontendDir, "node_modules", "vite", "bin", "vite.js"),
      "--host", "127.0.0.1", "--port", frontendPort, "--strictPort"],
    frontendDir,
    frontendEnv,
  );
}

main().catch((error) => {
  if (!stopping) {
    console.error(error.message);
    stop(1);
  }
});
