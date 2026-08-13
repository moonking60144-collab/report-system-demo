import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";

const {
  resolveChildArgs,
  startBackendSupervisor,
} = require(path.resolve("scripts/start-backend.js")) as {
  resolveChildArgs(mode: string): { api: string[]; worker: string[] };
  startBackendSupervisor(options: Record<string, unknown>): unknown;
};

class FakeChild extends EventEmitter {
  kills: string[] = [];
  kill(signal: string) {
    this.kills.push(signal);
    return true;
  }
}

test("dev/prod child args 分別指向 API 與獨立 Meeting worker", () => {
  assert.deepEqual(resolveChildArgs("prod"), {
    api: ["dist/server.js"],
    worker: ["dist/workers/meetingWorker.js"],
  });
  assert.deepEqual(resolveChildArgs("dev"), {
    api: ["--watch", "--import", "tsx", "src/server.ts"],
    worker: ["--watch", "--import", "tsx", "src/workers/meetingWorker.ts"],
  });
});

test("worker crash 只排延遲重啟，不停止 API", () => {
  const children: FakeChild[] = [];
  const spawnedArgs: string[][] = [];
  const timers: Array<() => void> = [];
  const exits: number[] = [];
  const processRef = new EventEmitter() as EventEmitter & {
    argv: string[];
    env: NodeJS.ProcessEnv;
    execPath: string;
    exit(code: number): void;
  };
  processRef.argv = ["node", "start-backend.js"];
  processRef.env = { MEETING_WORKER_ENABLED: "true" };
  processRef.execPath = "/node";
  processRef.exit = (code) => exits.push(code);

  startBackendSupervisor({
    processRef,
    mode: "prod",
    consoleRef: { log() {}, error() {} },
    spawnImpl: (_command: string, args: string[]) => {
      spawnedArgs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });

  assert.deepEqual(spawnedArgs, [["dist/server.js"], ["dist/workers/meetingWorker.js"]]);
  children[1]!.emit("exit", 1, null);
  assert.deepEqual(exits, []);
  assert.equal(timers.length, 1);
  timers[0]!();
  assert.deepEqual(spawnedArgs, [
    ["dist/server.js"],
    ["dist/workers/meetingWorker.js"],
    ["dist/workers/meetingWorker.js"],
  ]);
});

test("worker spawn error 即使沒有 exit 事件也會排延遲重啟", () => {
  const children: FakeChild[] = [];
  const spawnedArgs: string[][] = [];
  const timers: Array<() => void> = [];
  const processRef = new EventEmitter() as EventEmitter & {
    argv: string[];
    env: NodeJS.ProcessEnv;
    execPath: string;
    exit(code: number): void;
  };
  processRef.argv = ["node", "start-backend.js"];
  processRef.env = { MEETING_WORKER_ENABLED: "true" };
  processRef.execPath = "/node";
  processRef.exit = () => undefined;

  startBackendSupervisor({
    processRef,
    mode: "prod",
    consoleRef: { log() {}, error() {} },
    spawnImpl: (_command: string, args: string[]) => {
      spawnedArgs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });

  children[1]!.emit("error", new Error("spawn EAGAIN"));
  children[1]!.emit("exit", 1, null);
  assert.equal(timers.length, 1);
  timers[0]!();
  assert.deepEqual(spawnedArgs, [
    ["dist/server.js"],
    ["dist/workers/meetingWorker.js"],
    ["dist/workers/meetingWorker.js"],
  ]);
});

test("API exit 會停止 worker 並沿用 API exit code", () => {
  const children: FakeChild[] = [];
  const exits: number[] = [];
  const processRef = new EventEmitter() as EventEmitter & {
    argv: string[];
    env: NodeJS.ProcessEnv;
    execPath: string;
    exit(code: number): void;
  };
  processRef.argv = ["node", "start-backend.js"];
  processRef.env = { MEETING_WORKER_ENABLED: "true" };
  processRef.execPath = "/node";
  processRef.exit = (code) => exits.push(code);

  startBackendSupervisor({
    processRef,
    mode: "prod",
    consoleRef: { log() {}, error() {} },
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  });

  children[0]!.emit("exit", 7, null);
  assert.deepEqual(children[1]!.kills, ["SIGTERM"]);
  children[1]!.emit("exit", 0, null);
  assert.deepEqual(exits, [7]);
});

test("parent shutdown 時 worker 先退出不會等待 force timer", () => {
  const children: FakeChild[] = [];
  const exits: number[] = [];
  const timers: number[] = [];
  const processRef = new EventEmitter() as EventEmitter & {
    argv: string[];
    env: NodeJS.ProcessEnv;
    execPath: string;
    exit(code: number): void;
  };
  processRef.argv = ["node", "start-backend.js"];
  processRef.env = { MEETING_WORKER_ENABLED: "true" };
  processRef.execPath = "/node";
  processRef.exit = (code) => exits.push(code);

  startBackendSupervisor({
    processRef,
    mode: "prod",
    consoleRef: { log() {}, error() {} },
    spawnImpl: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: (_callback: () => void, delayMs: number) => {
      timers.push(delayMs);
      return timers.length;
    },
    clearTimer: () => undefined,
  });

  processRef.emit("SIGTERM");
  children[1]!.emit("exit", 0, "SIGTERM");
  children[0]!.emit("exit", 0, "SIGTERM");

  assert.deepEqual(exits, [143]);
  assert.deepEqual(children[1]!.kills, ["SIGTERM"]);
  assert.deepEqual(timers, []);
});
