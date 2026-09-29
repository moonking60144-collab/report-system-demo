import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureMeetingSttPython } from "./meeting-stt-environment.mjs";

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/meeting-stt");
const installedPython = path.join(service, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const pythonAvailable = spawnSync(installedPython, ["-c", "import fastapi, faster_whisper, opencc, uvicorn"], { stdio: "ignore" }).status === 0;
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
    await mkdir(path.join(directory, ".model-cache"));
    await writeFile(path.join(directory, ".model-cache", "preserved.txt"), "model cache", "utf8");
    await writeFile(path.join(directory, ".env"), "MEETING_STT_MODEL=small\n", "utf8");
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
      await writeFile(path.join(directory, ".venv", "preserved.txt"), "old environment", "utf8");
    }
    let repairs = 0;
    const python = await ensureMeetingSttPython(directory, {
      run: (command, args, options) => {
        repairs++;
        return spawn(command, args, { ...options, stdio: "inherit" });
      },
    });
    assert.equal(repairs, 2);
    assert.equal(await readFile(path.join(directory, "uv.lock"), "utf8"), lockBefore);
    const repaired = spawnSync(python, ["-c", "import sys, fastapi, faster_whisper, opencc, uvicorn; assert (3, 11) <= sys.version_info[:2] < (3, 13); print(sys.base_prefix)"], { encoding: "utf8" });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.ok(repaired.stdout.trim().startsWith(path.join(directory, ".python-runtime") + path.sep), "The repaired interpreter must not depend on a user-profile Python installation");
    assert.equal(await readFile(path.join(directory, ".model-cache", "preserved.txt"), "utf8"), "model cache");
    assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "MEETING_STT_MODEL=small\n");
    if (process.platform === "win32") {
      const recovery = (await readdir(directory)).find(name => name.startsWith(".venv-recovery-"));
      assert.ok(recovery, "The previous environment must be preserved");
      assert.equal(await readFile(path.join(directory, recovery, "preserved.txt"), "utf8"), "old environment");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed environment repair prevents startup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-failed-"));
  try {
    await assert.rejects(ensureMeetingSttPython(directory, {
      run: () => spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" }),
    }), /Meeting STT Python installation failed \(7\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unrepaired Python failure retains the subprocess error and interpreter path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-unrepaired-"));
  try {
    await assert.rejects(ensureMeetingSttPython(directory, {
      run: () => spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" }),
    }), error => error.message.includes("ENOENT") && error.message.includes(path.join(directory, ".venv")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation after Python installation preserves the original environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-cancel-install-"));
  try {
    await mkdir(path.join(directory, ".venv"));
    await writeFile(path.join(directory, ".venv", "preserved.txt"), "original", "utf8");
    let stopping = false;
    let calls = 0;
    await assert.rejects(ensureMeetingSttPython(directory, {
      isStopping: () => stopping,
      run: () => {
        calls++;
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
        child.once("close", () => { stopping = true; });
        return child;
      },
    }), /environment repair cancelled/);
    assert.equal(calls, 1, "Cancellation must prevent the dependency sync from starting");
    assert.equal(await readFile(path.join(directory, ".venv", "preserved.txt"), "utf8"), "original");
    assert.equal((await readdir(directory)).filter(name => name.startsWith(".venv-recovery-")).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation across the environment rename does not start a new sync", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "report-demo-stt-cancel-rename-"));
  try {
    await mkdir(path.join(directory, ".venv"));
    await writeFile(path.join(directory, ".venv", "preserved.txt"), "original", "utf8");
    let calls = 0;
    await assert.rejects(ensureMeetingSttPython(directory, {
      isStopping: () => readdirSync(directory).some(name => name.startsWith(".venv-recovery-")),
      run: () => {
        calls++;
        return spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      },
    }), /environment repair cancelled/);
    assert.equal(calls, 1, "Cancellation must prevent the dependency sync from starting");
    assert.equal(existsSync(path.join(directory, ".venv")), false);
    const recovery = (await readdir(directory)).find(name => name.startsWith(".venv-recovery-"));
    assert.equal(await readFile(path.join(directory, recovery, "preserved.txt"), "utf8"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
