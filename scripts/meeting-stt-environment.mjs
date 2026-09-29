import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";

function describePythonFailure(result, python) {
  const reason = result.error
    ? `${result.error.code}: ${result.error.message}`
    : `exit=${result.status ?? "none"}, signal=${result.signal ?? "none"}`;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `${python}: ${reason}${output ? `\n${output}` : ""}`;
}

export async function ensureMeetingSttPython(directory, { run, env = process.env, diarizationEnabled = false, isStopping = () => false }) {
  const environment = path.join(directory, ".venv");
  const python = path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const probe = () => spawnSync(python, [
    "-c", "import sys; sys.exit('Meeting STT requires Python 3.11 or 3.12') if not (3, 11) <= sys.version_info[:2] < (3, 13) else None; import fastapi, faster_whisper, opencc, uvicorn; print(sys.version.split()[0])",
  ], { cwd: directory, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  let result = probe();
  if (result.status === 0) return python;

  console.error(`[demo] Meeting STT Python check failed (${process.execPath}, ${process.version})\n${describePythonFailure(result, python)}`);
  const pythonInstallDir = path.join(directory, ".python-runtime");
  const repairEnv = { ...env, UV_PROJECT_ENVIRONMENT: environment, UV_PYTHON_INSTALL_DIR: pythonInstallDir };
  async function runUv(args, phase) {
    if (isStopping()) throw new Error("[demo] Meeting STT environment repair cancelled");
    let code;
    try {
      const repair = run("uv", args, { cwd: directory, env: repairEnv });
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
    if (isStopping()) throw new Error("[demo] Meeting STT environment repair cancelled");
    if (code !== 0) throw new Error(`[demo] Meeting STT ${phase} failed (${code ?? "signal"})`);
  }

  console.log("[demo] Installing project-local Meeting STT Python with uv...");
  await runUv([
    "python", "install", "3.12", "--install-dir", pythonInstallDir, "--no-bin",
    ...(process.platform === "win32" ? ["--no-registry"] : []),
  ], "Python installation");
  if (existsSync(environment)) {
    const recovery = path.join(directory, `.venv-recovery-${randomUUID()}`);
    await rename(environment, recovery);
    console.log(`[demo] Preserved previous Meeting STT environment: ${recovery}`);
  }
  console.log("[demo] Rebuilding Meeting STT environment from its lockfile...");
  await runUv([
    "sync", "--locked", "--python", "3.12", "--managed-python", "--inexact",
    ...(diarizationEnabled ? ["--extra", "diarization"] : []),
  ], "environment repair");
  result = probe();
  if (result.status !== 0) throw new Error(`[demo] Meeting STT Python check failed after uv sync\n${describePythonFailure(result, python)}`);
  return python;
}
