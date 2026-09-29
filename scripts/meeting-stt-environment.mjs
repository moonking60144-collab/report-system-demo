import { spawnSync } from "node:child_process";
import path from "node:path";

export async function ensureMeetingSttPython(directory, { run, env = process.env, diarizationEnabled = false }) {
  const environment = path.join(directory, ".venv");
  const python = path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const ready = () => spawnSync(python, [
    "-c", "import sys; assert (3, 11) <= sys.version_info[:2] < (3, 13)",
  ], { cwd: directory, env, stdio: "ignore", timeout: 10_000, windowsHide: true }).status === 0;
  if (ready()) return python;

  console.log("[demo] Repairing Meeting STT Python environment with uv...");
  let code;
  try {
    const repair = run("uv", [
      "sync", "--locked", "--python", "3.12", "--inexact",
      ...(diarizationEnabled ? ["--extra", "diarization"] : []),
    ], { cwd: directory, env: { ...env, UV_PROJECT_ENVIRONMENT: environment } });
    code = await new Promise((resolve, reject) => {
      repair.once("error", reject);
      repair.once("close", resolve);
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("[demo] Meeting STT Python is unavailable and uv was not found; install uv and run npm run demo again");
    }
    throw error;
  }
  if (code !== 0) throw new Error(`[demo] Meeting STT environment repair failed (${code ?? "signal"})`);
  if (!ready()) throw new Error("[demo] Meeting STT Python is still unavailable after uv sync");
  return python;
}
