const { spawn } = require("node:child_process");
const dotenv = require("dotenv");
const { validateProviderEnv } = require("./validate-provider-env");

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function resolveChildArgs(mode) {
  return mode === "dev"
    ? {
        api: ["--watch", "--import", "tsx", "src/server.ts"],
        worker: ["--watch", "--import", "tsx", "src/workers/meetingWorker.ts"],
      }
    : {
        api: ["dist/server.js"],
        worker: ["dist/workers/meetingWorker.js"],
      };
}

function startBackendSupervisor(options = {}) {
  const processRef = options.processRef ?? process;
  const consoleRef = options.consoleRef ?? console;
  const spawnImpl = options.spawnImpl ?? spawn;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const mode = options.mode ?? (processRef.argv[2] === "dev" ? "dev" : "prod");
  const threadpoolSize = processRef.env.UV_THREADPOOL_SIZE || "16";
  const workerEnabled = isEnabled(processRef.env.MEETING_WORKER_ENABLED);
  const restartDelayMs = Math.max(
    1_000,
    Number(processRef.env.MEETING_WORKER_RESTART_DELAY_MS) || 5_000
  );
  const childArgs = resolveChildArgs(mode);
  const childOptions = {
    stdio: "inherit",
    env: { ...processRef.env, UV_THREADPOOL_SIZE: threadpoolSize },
  };
  let apiChild = null;
  let workerChild = null;
  let workerRestartTimer = null;
  let shuttingDown = false;
  let parentExitScheduled = false;

  consoleRef.log(
    `[start-backend] mode=${mode} UV_THREADPOOL_SIZE=${threadpoolSize} meetingWorker=${workerEnabled ? "enabled" : "disabled"}`
  );

  function scheduleParentExit(code) {
    if (parentExitScheduled) return;
    parentExitScheduled = true;
    if (workerRestartTimer) {
      clearTimer(workerRestartTimer);
      workerRestartTimer = null;
    }
    if (!workerChild) {
      processRef.exit(code);
      return;
    }
    const child = workerChild;
    const forceTimer = setTimer(() => {
      child.kill("SIGKILL");
      processRef.exit(code);
    }, 5_000);
    child.once("exit", () => {
      clearTimer(forceTimer);
      processRef.exit(code);
    });
    child.kill("SIGTERM");
  }

  function spawnWorker() {
    if (!workerEnabled || shuttingDown) return;
    const child = spawnImpl(processRef.execPath, childArgs.worker, childOptions);
    workerChild = child;

    function scheduleWorkerRestart(message) {
      if (workerChild !== child || workerRestartTimer) return;
      workerChild = null;
      if (shuttingDown) return;
      consoleRef.error(message);
      workerRestartTimer = setTimer(() => {
        workerRestartTimer = null;
        spawnWorker();
      }, restartDelayMs);
    }

    child.on("error", (error) => {
      scheduleWorkerRestart(
        `[start-backend] meeting worker start failed: ${error instanceof Error ? error.message : String(error)}; restart in ${restartDelayMs}ms`
      );
    });
    child.on("exit", (code, signal) => {
      scheduleWorkerRestart(
        `[start-backend] meeting worker exited code=${code ?? "null"} signal=${signal ?? "none"}; restart in ${restartDelayMs}ms`
      );
    });
  }

  apiChild = spawnImpl(processRef.execPath, childArgs.api, childOptions);
  apiChild.on("error", (error) => {
    consoleRef.error("[start-backend] failed to start backend:", error);
    shuttingDown = true;
    scheduleParentExit(1);
  });
  apiChild.on("exit", (code, signal) => {
    shuttingDown = true;
    const exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 0);
    scheduleParentExit(exitCode);
  });
  spawnWorker();

  function forwardSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (workerRestartTimer) {
      clearTimer(workerRestartTimer);
      workerRestartTimer = null;
    }
    apiChild?.kill(signal);
    workerChild?.kill(signal);
  }

  processRef.on("SIGINT", () => forwardSignal("SIGINT"));
  processRef.on("SIGTERM", () => forwardSignal("SIGTERM"));

  return {
    getApiChild: () => apiChild,
    getWorkerChild: () => workerChild,
    forwardSignal,
  };
}

if (require.main === module) {
  dotenv.config();
  const providerErrors = validateProviderEnv(process.env);
  if (providerErrors.length > 0) {
    for (const error of providerErrors) console.error(`[provider-env-invalid] ${error}`);
    process.exitCode = 1;
  } else {
    startBackendSupervisor();
  }
}

module.exports = { isEnabled, resolveChildArgs, startBackendSupervisor };
