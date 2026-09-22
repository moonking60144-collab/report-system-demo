import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRagicDefinitionsVersionControlService,
  type GitCommandRunner,
} from "../../../src/services/dev/ragicDefinitionsVersionControlService";

async function buildFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "ragic-vc-test-"));
  const definitionsRoot = join(repoRoot, "ragic-definitions");
  await mkdir(definitionsRoot, { recursive: true });
  return { repoRoot, definitionsRoot };
}

test("version control status：ragic-definitions 以外 dirty 會阻擋 commit", async () => {
  const fixture = await buildFixture();
  try {
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      if (command.startsWith("status ")) {
        return {
          stdout:
            " M ragic-definitions/forms/default/devtest/51/formulas.json\n M backend/src/server.ts\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const status = await service.getStatus();
    assert.equal(status.gitAvailable, true);
    assert.equal(status.canCommit, false);
    assert.equal(status.definitionsEntries.length, 1);
    assert.equal(status.outsideEntries.length, 1);
    assert.match(status.blockers.join("\n"), /ragic-definitions 以外已追蹤檔案差異/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control status：ragic-definitions 以外 untracked 只警告、不阻擋 commit", async () => {
  const fixture = await buildFixture();
  try {
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      if (command.startsWith("status ")) {
        return {
          stdout:
            " M ragic-definitions/forms/default/devtest/51/formulas.json\n?? ,備份/\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const status = await service.getStatus();
    assert.equal(status.canCommit, true);
    assert.equal(status.blockers.length, 0);
    assert.match(status.warnings.join("\n"), /未追蹤檔案/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control status：ahead/behind 且工作樹乾淨時標記可自動同步推送", async () => {
  const fixture = await buildFixture();
  try {
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "1\t1\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const status = await service.getStatus();
    assert.equal(status.canPush, false);
    assert.equal(status.canAutoSyncPush, true);
    assert.match(status.blockers.join("\n"), /origin\/main 有 1 個新提交/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control commit：只 add/commit ragic-definitions pathspec", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    let clean = false;
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command.startsWith("status ")) {
        return {
          stdout: clean
            ? ""
            : " M ragic-definitions/forms/default/devtest/51/formulas.json\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: clean ? "def5678\n" : "abc1234\n", stderr: "" };
      }
      if (command === "add -- ragic-definitions") {
        return { stdout: "", stderr: "" };
      }
      if (command === "commit -m chore(ragic): 更新 definitions baseline -- ragic-definitions") {
        clean = true;
        return { stdout: "[main def5678] chore(ragic): 更新 definitions baseline\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.commitBaseline("chore(ragic): 更新 definitions baseline");
    assert.equal(result.committed, true);
    assert.equal(result.commit, "def5678");
    assert.ok(commands.includes("add -- ragic-definitions"));
    assert.ok(commands.includes("commit -m chore(ragic): 更新 definitions baseline -- ragic-definitions"));
    assert.equal(result.status.clean, true);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control commit：指定 formPaths 時只 add/commit 對應表單資料夾，其他 definitions 保留", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    let committedScoped = false;
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command.startsWith("status ")) {
        return {
          stdout: committedScoped
            ? " M ragic-definitions/forms/default/devtest/56/formulas.json\n"
            : [
                " M ragic-definitions/forms/default/devtest/51/formulas.json",
                " M ragic-definitions/forms/default/devtest/56/formulas.json",
              ].join("\n") + "\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: committedScoped ? "def5678\n" : "abc1234\n", stderr: "" };
      }
      if (command === "add -- ragic-definitions/forms/default/devtest/51") {
        return { stdout: "", stderr: "" };
      }
      if (
        command ===
        "commit -m chore(ragic): 更新 definitions baseline -- ragic-definitions/forms/default/devtest/51"
      ) {
        committedScoped = true;
        return { stdout: "[main def5678] chore(ragic): 更新 definitions baseline\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.commitBaseline("chore(ragic): 更新 definitions baseline", {
      formPaths: ["default/devtest/51"],
    });
    assert.equal(result.committed, true);
    assert.deepEqual(result.scopedFormPaths, ["default/devtest/51"]);
    assert.equal(result.committedDefinitionsEntries?.length, 1);
    assert.equal(result.retainedDefinitionsEntries?.length, 1);
    assert.match(result.warnings.join("\n"), /其他 ragic-definitions 差異會保留/);
    assert.ok(commands.includes("add -- ragic-definitions/forms/default/devtest/51"));
    assert.ok(
      commands.includes(
        "commit -m chore(ragic): 更新 definitions baseline -- ragic-definitions/forms/default/devtest/51"
      )
    );
    assert.equal(result.status.definitionsEntries.length, 1);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control commit：指定 formPaths 但該範圍沒有差異時阻擋", async () => {
  const fixture = await buildFixture();
  try {
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      if (command.startsWith("status ")) {
        return {
          stdout: " M ragic-definitions/forms/default/devtest/56/formulas.json\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.commitBaseline("chore(ragic): 更新 definitions baseline", {
      formPaths: ["default/devtest/51"],
    });
    assert.equal(result.committed, false);
    assert.match(result.blockers.join("\n"), /指定表單範圍內沒有 ragic-definitions 差異/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control commit：有 actor 時用 actor 當 Git author", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    let clean = false;
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command.startsWith("status ")) {
        return {
          stdout: clean
            ? ""
            : " M ragic-definitions/forms/default/devtest/51/formulas.json\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: clean ? "def5678\n" : "abc1234\n", stderr: "" };
      }
      if (command === "add -- ragic-definitions") {
        return { stdout: "", stderr: "" };
      }
      if (
        command ===
        "commit -m chore(ragic): 更新 definitions baseline --author dev-user <dev-user@ragic-report.local> -- ragic-definitions"
      ) {
        clean = true;
        return { stdout: "[main def5678] chore(ragic): 更新 definitions baseline\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.commitBaseline(
      "chore(ragic): 更新 definitions baseline",
      { actor: "dev-user" }
    );
    assert.equal(result.committed, true);
    assert.ok(
      commands.includes(
        "commit -m chore(ragic): 更新 definitions baseline --author dev-user <dev-user@ragic-report.local> -- ragic-definitions"
      )
    );
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：只有本地領先 origin/main 時才 push", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "def5678\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "0\t1\n", stderr: "" };
      }
      if (command === "push origin main") {
        return { stdout: "", stderr: "To github.com:example-org/report-system.git\n" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, true);
    assert.ok(commands.includes("fetch origin main"));
    assert.ok(commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：工作樹仍有 definitions 差異時仍可推送已提交 commit", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return {
          stdout: " M ragic-definitions/forms/default/devtest/56/formulas.json\n",
          stderr: "",
        };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "def5678\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "0\t1\n", stderr: "" };
      }
      if (command === "push origin main") {
        return { stdout: "", stderr: "To github.com:example-org/report-system.git\n" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, true);
    assert.match(result.warnings.join("\n"), /不會包含工作樹差異/);
    assert.ok(commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：ahead/behind 分叉且工作樹乾淨時先 rebase 再 push", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    let rebased = false;
    let pushed = false;
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: pushed ? "def9999\n" : rebased ? "def5678\n" : "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: pushed ? "0\t0\n" : rebased ? "0\t1\n" : "1\t1\n", stderr: "" };
      }
      if (command === "rebase origin/main") {
        rebased = true;
        return { stdout: "Successfully rebased and updated refs/heads/main.\n", stderr: "" };
      }
      if (command === "push origin main") {
        pushed = true;
        return { stdout: "", stderr: "To github.com:example-org/report-system.git\n" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, true);
    assert.ok(commands.includes("fetch origin main"));
    assert.ok(commands.includes("rebase origin/main"));
    assert.ok(commands.includes("push origin main"));
    assert.match(result.warnings.join("\n"), /已先同步 origin\/main/);
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：ahead/behind 自動 rebase 失敗時 abort 並回 blocker", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "1\t1\n", stderr: "" };
      }
      if (command === "rebase origin/main") {
        throw new Error("CONFLICT (content): Merge conflict in ragic-definitions/forms/default/devtest/51/formulas.json");
      }
      if (command === "rebase --abort") {
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, false);
    assert.match(result.blockers.join("\n"), /自動同步 origin\/main 失敗/);
    assert.ok(commands.includes("rebase origin/main"));
    assert.ok(commands.includes("rebase --abort"));
    assert.ok(!commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：只有落後 origin/main、沒有本地 commit 時回傳 blocker", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "2\t0\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, false);
    assert.match(result.blockers.join("\n"), /origin\/main 有 2 個新提交/);
    assert.ok(!commands.includes("rebase origin/main"));
    assert.ok(!commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：fetch origin main 失敗時回 blocker、不 push", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        throw new Error("network down");
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return { stdout: "0\t1\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, false);
    assert.match(result.blockers.join("\n"), /無法更新 origin\/main 狀態/);
    assert.ok(!commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});

test("version control push：ahead/behind 無法判斷（origin/main 缺）時擋下", async () => {
  const fixture = await buildFixture();
  try {
    const commands: string[] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      const command = args.join(" ");
      commands.push(command);
      if (command === "fetch origin main") {
        return { stdout: "", stderr: "" };
      }
      if (command.startsWith("status ")) {
        return { stdout: "", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref HEAD") {
        return { stdout: "main\n", stderr: "" };
      }
      if (command === "rev-parse --short HEAD") {
        return { stdout: "abc1234\n", stderr: "" };
      }
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
        return { stdout: "origin/main\n", stderr: "" };
      }
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        throw new Error("fatal: bad revision 'origin/main...HEAD'");
      }
      throw new Error(`unexpected git command: ${command}`);
    };

    const service = createRagicDefinitionsVersionControlService({
      repoRoot: fixture.repoRoot,
      definitionsRoot: fixture.definitionsRoot,
      gitRunner,
    });
    const result = await service.pushBaseline();
    assert.equal(result.pushed, false);
    assert.match(result.blockers.join("\n"), /無法判斷本地 main 與 origin\/main 差異/);
    assert.ok(!commands.includes("push origin main"));
  } finally {
    await rm(fixture.repoRoot, { recursive: true, force: true });
  }
});
