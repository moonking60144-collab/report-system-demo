const { spawn } = require("node:child_process");

const mode = process.argv[2] === "dev" ? "dev" : "prod";
const threadpoolSize = process.env.UV_THREADPOOL_SIZE || "16";
const nodeArgs =
  mode === "dev"
    ? ["--watch", "--import", "tsx", "src/server.ts"]
    : ["dist/server.js"];

console.log(`[start-backend] mode=${mode} UV_THREADPOOL_SIZE=${threadpoolSize}`);

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    UV_THREADPOOL_SIZE: threadpoolSize,
  },
});

let forwardingSignal = false;

function forwardSignal(signal) {
  if (forwardingSignal) return;
  forwardingSignal = true;
  child.kill(signal);
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[start-backend] failed to start backend:", error);
  process.exit(1);
});
