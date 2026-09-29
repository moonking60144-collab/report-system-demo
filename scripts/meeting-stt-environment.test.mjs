import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureMeetingSttPython } from "./meeting-stt-environment.mjs";

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/meeting-stt");
const installedPython = path.join(service, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const pythonAvailable = spawnSync(installedPython, ["--version"], { stdio: "ignore" }).status === 0;
const uvAvailable = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

test("a usable Meeting Python environment does not require uv", { skip: !pythonAvailable }, async () => {
  const python = await ensureMeetingSttPython(service, {
    run: () => { throw new Error("Healthy environments must not be repaired"); },
  });
  assert.equal(python, installedPython);
});

test("a broken Meeting environment is repaired from its lockfile", { skip: !uvAvailable }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-repair-"));
  try {
    await copyFile(path.join(service, "pyproject.toml"), path.join(directory, "pyproject.toml"));
    await copyFile(path.join(service, "uv.lock"), path.join(directory, "uv.lock"));
    await cp(path.join(service, "app"), path.join(directory, "app"), {
      recursive: true,
      filter: source => !source.includes("__pycache__"),
    });
    const lockBefore = await readFile(path.join(directory, "uv.lock"), "utf8");
    if (process.platform === "win32") {
      const created = spawnSync("uv", ["venv", "--python", "3.12", path.join(directory, ".venv")], { cwd: directory, encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      const scripts = path.join(directory, ".venv", "Scripts");
      const configPath = path.join(directory, ".venv", "pyvenv.cfg");
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, config.replace(/^home = .*$/m, `home = ${path.join(directory, "missing-python")}`), "utf8");
      const broken = spawnSync(path.join(scripts, "python.exe"), ["--version"], { encoding: "utf8" });
      assert.equal(broken.status, 103, "The fixture must reproduce the missing base-Python failure");
      assert.match(broken.stderr, /No Python at/);
    }
    let repairs = 0;
    const python = await ensureMeetingSttPython(directory, {
      run: (command, args, options) => {
        repairs++;
        return spawn(command, args, { ...options, stdio: "inherit" });
      },
    });
    assert.equal(repairs, 1);
    assert.equal(await readFile(path.join(directory, "uv.lock"), "utf8"), lockBefore);
    const repaired = spawnSync(python, ["-c", "import sys, fastapi, faster_whisper, opencc, uvicorn; assert (3, 11) <= sys.version_info[:2] < (3, 13)"], { encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed environment repair prevents startup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-failed-"));
  try {
    await assert.rejects(ensureMeetingSttPython(directory, {
      run: () => spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }),
    }), /Meeting STT environment repair failed \(7\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
