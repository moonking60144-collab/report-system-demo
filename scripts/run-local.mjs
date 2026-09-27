import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.join(root, "backend");
const frontendDir = path.join(root, "frontend");
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
    backendEnv.RAGIC_WRITE_TARGET = "test";
  }

  const frontendEnv = {
    ...process.env,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL
      ?? `http://127.0.0.1:${backendPort}/api`,
  };

  console.log(`[${mode}] Frontend: http://127.0.0.1:${frontendPort}`);
  console.log(`[${mode}] Backend: http://127.0.0.1:${backendPort}`);

  startServer(
    "backend",
    process.execPath,
    [path.join(backendDir, "scripts", "start-backend.js"), "dev"],
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
