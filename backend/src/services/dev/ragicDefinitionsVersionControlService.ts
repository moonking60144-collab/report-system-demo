import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  findExistingDefinitionsRoot,
  findRepoRoot,
  isAllowedDefinitionsPathspec,
  normalizeDefinitionsPathspec,
} from "./ragicDefinitionsPaths";
import {
  buildFormDefinitionsPathspec,
  getDefinitionsEntryFormPath,
  normalizeRagicFormPath,
  normalizeScopedFormPaths,
  splitDefinitionsEntriesByFormScope,
} from "./ragicDefinitionsGitScope";
import { withDefinitionsWriteLock } from "./ragicDefinitionsIoLock";
import type {
  RagicDefinitionsGitEntry,
  RagicDefinitionsVersionControlStatus,
  RagicDefinitionsVersionControlCommitResult,
  RagicDefinitionsVersionControlPushResult,
} from "@shared-types/ragicDefinitions";

export type {
  RagicDefinitionsGitEntry,
  RagicDefinitionsVersionControlStatus,
  RagicDefinitionsVersionControlCommitResult,
  RagicDefinitionsVersionControlPushResult,
};

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 32;

export type GitCommandRunner = (
  args: string[],
  options: { cwd: string; timeout: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface RagicDefinitionsVersionControlServiceOptions {
  definitionsRoot?: string;
  repoRoot?: string;
  gitRunner?: GitCommandRunner;
}

export interface RagicDefinitionsVersionControlCommitOptions {
  actor?: string | null;
  formPaths?: string[] | null;
}

const DEFAULT_COMMIT_MESSAGE = "chore(ragic): 更新 definitions baseline";

function parseGitStatusLine(line: string, definitionsPathspec: string): RagicDefinitionsGitEntry {
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
  const prefix = `${definitionsPathspec}/`;
  const inDefinitions = path === definitionsPathspec || path.startsWith(prefix);
  return {
    raw: line,
    status,
    path,
    inDefinitions,
    formPath: inDefinitions ? getDefinitionsEntryFormPath(path, definitionsPathspec) : null,
  };
}

function normalizeCommitMessage(raw: string | undefined): string {
  const message = (raw ?? DEFAULT_COMMIT_MESSAGE).trim() || DEFAULT_COMMIT_MESSAGE;
  return message.replace(/\s+/g, " ").slice(0, 160);
}

function normalizeCommitAuthor(actor: string | null | undefined): string | null {
  const name = String(actor ?? "")
    .trim()
    .replace(/[\r\n<>]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (!name) return null;

  const localPart =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "dev";
  return `${name} <${localPart}@ragic-report.local>`;
}

function parseAheadBehind(raw: string): { behind: number; ahead: number } | null {
  const [behindRaw, aheadRaw] = raw.trim().split(/\s+/, 2);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null;
  return { behind, ahead };
}

function isRemoteBehindBlocker(blocker: string): boolean {
  return /^origin\/main 有 \d+ 個新提交，先同步後再操作 baseline$/.test(blocker);
}

function formatGitError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function emptyUnavailableStatus(params: {
  repoRoot: string;
  definitionsRoot: string;
  definitionsPathspec: string;
  error: string;
}): RagicDefinitionsVersionControlStatus {
  return {
    gitAvailable: false,
    repoRoot: params.repoRoot,
    definitionsRoot: params.definitionsRoot,
    definitionsPathspec: params.definitionsPathspec,
    branch: null,
    lastCommit: null,
    remoteTrackingBranch: null,
    ahead: null,
    behind: null,
    clean: false,
    definitionsClean: false,
    canCommit: false,
    canPush: false,
    canAutoSyncPush: false,
    entries: [],
    definitionsEntries: [],
    outsideEntries: [],
    blockers: [params.error],
    warnings: [],
    error: params.error,
  };
}

export function createRagicDefinitionsVersionControlService(
  options: RagicDefinitionsVersionControlServiceOptions = {}
) {
  const definitionsRoot = resolve(options.definitionsRoot ?? findExistingDefinitionsRoot());
  const repoRoot = resolve(options.repoRoot ?? findRepoRoot(definitionsRoot));
  const definitionsPathspec = normalizeDefinitionsPathspec(repoRoot, definitionsRoot);
  const gitRunner: GitCommandRunner =
    options.gitRunner ??
    ((args, runnerOptions) =>
      execFileAsync("git", args, {
        cwd: runnerOptions.cwd,
        timeout: runnerOptions.timeout,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      }));

  async function runGit(args: string[], timeout = 10_000) {
    return gitRunner(args, { cwd: repoRoot, timeout });
  }

  async function runOptionalGit(args: string[], timeout = 10_000) {
    try {
      return await runGit(args, timeout);
    } catch {
      return null;
    }
  }

  async function gitPathExists(pathName: string): Promise<boolean> {
    const result = await runOptionalGit(["rev-parse", "--git-path", pathName]);
    const gitPath = result?.stdout.trim();
    if (!gitPath) return false;
    return existsSync(resolve(repoRoot, gitPath));
  }

  async function isRebaseInProgress(): Promise<boolean> {
    const [mergePathExists, applyPathExists] = await Promise.all([
      gitPathExists("rebase-merge"),
      gitPathExists("rebase-apply"),
    ]);
    return mergePathExists || applyPathExists;
  }

  async function getStatus(): Promise<RagicDefinitionsVersionControlStatus> {
    if (!isAllowedDefinitionsPathspec(definitionsPathspec)) {
      return emptyUnavailableStatus({
        repoRoot,
        definitionsRoot,
        definitionsPathspec,
        error: `definitionsRoot 必須是 repo 內的 ragic-definitions 目錄，目前 pathspec=${definitionsPathspec}`,
      });
    }

    try {
      const [statusResult, branchResult, lastCommitResult, remoteBranchResult, aheadBehindResult] = await Promise.all([
        runGit(["status", "--porcelain=v1", "--untracked-files=normal"]),
        runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
        runGit(["rev-parse", "--short", "HEAD"]),
        runOptionalGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
        runOptionalGit(["rev-list", "--left-right", "--count", "origin/main...HEAD"]),
      ]);
      const entries = statusResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => parseGitStatusLine(line, definitionsPathspec));
      const definitionsEntries = entries.filter((entry) => entry.inDefinitions);
      const outsideEntries = entries.filter((entry) => !entry.inDefinitions);
      const outsideTrackedEntries = outsideEntries.filter((entry) => entry.status !== "??");
      const outsideUntrackedEntries = outsideEntries.filter((entry) => entry.status === "??");
      const branch = branchResult.stdout.trim() || null;
      const lastCommit = lastCommitResult.stdout.trim() || null;
      const remoteTrackingBranch = remoteBranchResult?.stdout.trim() || "origin/main";
      const aheadBehind = aheadBehindResult
        ? parseAheadBehind(aheadBehindResult.stdout)
        : null;
      const ahead = aheadBehind?.ahead ?? null;
      const behind = aheadBehind?.behind ?? null;
      const blockers: string[] = [];
      const warnings: string[] = [];
      if (outsideTrackedEntries.length > 0) {
        blockers.push(
          `repo 有 ragic-definitions 以外已追蹤檔案差異：${outsideTrackedEntries
            .map((entry) => entry.raw)
            .join(" / ")}`
        );
      }
      if (outsideUntrackedEntries.length > 0) {
        warnings.push(
          `repo 有 ragic-definitions 以外未追蹤檔案，commit baseline 時會略過：${outsideUntrackedEntries
            .map((entry) => entry.raw)
            .join(" / ")}`
        );
      }
      if (branch !== "main") {
        blockers.push(`只能在 main 分支操作，目前是 ${branch ?? "unknown"}`);
      }
      const trackedDirtyEntries = entries.filter((entry) => entry.status !== "??");
      const canAutoSyncPush =
        Boolean(aheadBehind) &&
        ahead !== null &&
        ahead > 0 &&
        behind !== null &&
        behind > 0 &&
        branch === "main" &&
        trackedDirtyEntries.length === 0 &&
        blockers.length === 0;

      if (!aheadBehind) {
        warnings.push("無法判斷本地 main 與 origin/main 的 ahead/behind 狀態");
      } else if (aheadBehind.behind > 0) {
        blockers.push(`origin/main 有 ${aheadBehind.behind} 個新提交，先同步後再操作 baseline`);
      }

      return {
        gitAvailable: true,
        repoRoot,
        definitionsRoot,
        definitionsPathspec,
        branch,
        lastCommit,
        remoteTrackingBranch,
        ahead,
        behind,
        clean: entries.length === 0,
        definitionsClean: definitionsEntries.length === 0,
        canCommit:
          definitionsEntries.length > 0 &&
          outsideTrackedEntries.length === 0 &&
          branch === "main" &&
          blockers.length === 0,
        canPush:
          outsideTrackedEntries.length === 0 &&
          ahead !== null &&
          ahead > 0 &&
          behind === 0 &&
          branch === "main" &&
          blockers.length === 0,
        canAutoSyncPush,
        entries,
        definitionsEntries,
        outsideEntries,
        blockers,
        warnings,
        error: null,
      };
    } catch (error) {
      return emptyUnavailableStatus({
        repoRoot,
        definitionsRoot,
        definitionsPathspec,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function commitBaselineUnlocked(
    messageRaw?: string,
    options: RagicDefinitionsVersionControlCommitOptions = {}
  ): Promise<RagicDefinitionsVersionControlCommitResult> {
    const message = normalizeCommitMessage(messageRaw);
    const author = normalizeCommitAuthor(options.actor);
    const requestedFormPaths = options.formPaths ?? null;
    const scopedFormPaths = normalizeScopedFormPaths(requestedFormPaths);
    const before = await getStatus();
    const scopedCommit = Array.isArray(requestedFormPaths) && requestedFormPaths.length > 0;
    const { scopedEntries, retainedEntries } = scopedCommit
      ? splitDefinitionsEntriesByFormScope(
          before.definitionsEntries,
          scopedFormPaths,
          definitionsPathspec
        )
      : { scopedEntries: before.definitionsEntries, retainedEntries: [] };
    const blockers = [...before.blockers];
    const warnings = [...before.warnings];
    if (!before.gitAvailable) blockers.push("Git 狀態不可用，不能 commit");
    if (scopedCommit) {
      const invalidFormPaths = requestedFormPaths?.filter((item) => !normalizeRagicFormPath(item)) ?? [];
      if (invalidFormPaths.length > 0) {
        blockers.push(`提交範圍包含不合法 formPath：${invalidFormPaths.join(" / ")}`);
      }
      if (scopedFormPaths.length === 0) {
        blockers.push("沒有可用的表單提交範圍");
      }
      if (scopedEntries.length === 0) {
        blockers.push("指定表單範圍內沒有 ragic-definitions 差異可提交");
      }
      if (retainedEntries.length > 0) {
        warnings.push(
          `其他 ragic-definitions 差異會保留，不納入本次提交：${retainedEntries
            .map((entry) => entry.raw)
            .join(" / ")}`
        );
      }
    } else if (before.definitionsEntries.length === 0) {
      blockers.push("沒有 ragic-definitions 差異可提交");
    }
    if (before.outsideEntries.length > 0) {
      const outsideTrackedEntries = before.outsideEntries.filter((entry) => entry.status !== "??");
      if (outsideTrackedEntries.length > 0) {
        blockers.push("存在 ragic-definitions 以外已追蹤檔案差異，先處理後才能提交 baseline");
      }
    }
    if (before.branch !== "main") {
      blockers.push(`只能在 main 分支提交，目前是 ${before.branch ?? "unknown"}`);
    }
    if (blockers.length > 0) {
      return {
        committed: false,
        commit: null,
        message,
        scopedFormPaths,
        committedDefinitionsEntries: [],
        retainedDefinitionsEntries: scopedCommit ? retainedEntries : [],
        stdout: "",
        stderr: "",
        status: before,
        blockers: Array.from(new Set(blockers)),
        warnings,
      };
    }

    const commitPathspecs = scopedCommit
      ? scopedFormPaths
          .map((formPath) => buildFormDefinitionsPathspec(definitionsPathspec, formPath))
          .filter((pathspec): pathspec is string => Boolean(pathspec))
      : [definitionsPathspec];
    const addResult = await runGit(["add", "--", ...commitPathspecs]);
    const commitArgs = author
      ? ["commit", "-m", message, "--author", author, "--", ...commitPathspecs]
      : ["commit", "-m", message, "--", ...commitPathspecs];
    const commitResult = await runGit(commitArgs, 30_000);
    const commit = (await runGit(["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
    const after = await getStatus();
    return {
      committed: true,
      commit,
      message,
      scopedFormPaths,
      committedDefinitionsEntries: scopedEntries,
      retainedDefinitionsEntries: retainedEntries,
      stdout: [addResult.stdout.trim(), commitResult.stdout.trim()].filter(Boolean).join("\n"),
      stderr: [addResult.stderr.trim(), commitResult.stderr.trim()].filter(Boolean).join("\n"),
      status: after,
      blockers: [],
      warnings: Array.from(new Set([...warnings, ...after.warnings])),
    };
  }

  async function commitBaseline(
    messageRaw?: string,
    options: RagicDefinitionsVersionControlCommitOptions = {}
  ): Promise<RagicDefinitionsVersionControlCommitResult> {
    return withDefinitionsWriteLock(() => commitBaselineUnlocked(messageRaw, options));
  }

  async function pushBaselineUnlocked(): Promise<RagicDefinitionsVersionControlPushResult> {
    try {
      await runGit(["fetch", "origin", "main"], 60_000);
    } catch (error) {
      const status = await getStatus();
      const message = error instanceof Error ? error.message : String(error);
      return {
        pushed: false,
        stdout: "",
        stderr: "",
        status,
        blockers: [`無法更新 origin/main 狀態：${message}`],
        warnings: status.warnings,
      };
    }

    let before = await getStatus();
    const rebaseOutputs: Array<{ stdout: string; stderr: string }> = [];
    let blockers = before.blockers.filter((blocker) => !isRemoteBehindBlocker(blocker));
    const warnings = [...before.warnings];
    if (!before.gitAvailable) blockers.push("Git 狀態不可用，不能 push");
    if (!before.definitionsClean) {
      warnings.push("ragic-definitions 仍有未提交差異；push 只會推送已提交 commit，不會包含工作樹差異");
    }
    const trackedDirtyEntries = before.entries.filter((entry) => entry.status !== "??");
    const outsideTrackedDirtyEntries = before.outsideEntries.filter((entry) => entry.status !== "??");
    if (outsideTrackedDirtyEntries.length > 0) {
      blockers.push("存在 ragic-definitions 以外已追蹤檔案差異，先處理後才能 push");
    }
    if (before.branch !== "main") {
      blockers.push(`只能從 main 分支 push，目前是 ${before.branch ?? "unknown"}`);
    }
    if (before.ahead === null || before.behind === null) {
      blockers.push("無法判斷本地 main 與 origin/main 差異，不能安全 push");
    } else {
      if (before.ahead === 0) {
        blockers.push("沒有本地 baseline commit 需要 push");
      }
      if (before.behind > 0) {
        const canAutoRebase =
          before.ahead > 0 &&
          before.gitAvailable &&
          before.branch === "main" &&
          trackedDirtyEntries.length === 0 &&
          blockers.length === 0;
        if (canAutoRebase) {
          try {
            const rebaseResult = await runGit(["rebase", "origin/main"], 120_000);
            rebaseOutputs.push(rebaseResult);
            warnings.push("已先同步 origin/main（rebase）再推送");
            before = await getStatus();
            blockers = before.blockers.filter((blocker) => !isRemoteBehindBlocker(blocker));
            if (before.behind && before.behind > 0) {
              blockers.push(`origin/main 仍有 ${before.behind} 個新提交，不能安全 push`);
            }
            if (before.ahead === 0) {
              blockers.push("rebase 後沒有本地 baseline commit 需要 push");
            }
          } catch (error) {
            await runOptionalGit(["rebase", "--abort"], 30_000);
            const rebaseStillActive = await isRebaseInProgress();
            const status = await getStatus();
            return {
              pushed: false,
              stdout: "",
              stderr: "",
              status,
              blockers: [
                rebaseStillActive
                  ? `自動同步 origin/main 失敗，且 rebase abort 可能未完成；請人工檢查 repo 狀態：${formatGitError(error)}`
                  : `自動同步 origin/main 失敗，已取消 rebase；請人工檢查衝突：${formatGitError(error)}`,
              ],
              warnings: Array.from(new Set([...warnings, ...status.warnings])),
            };
          }
        } else if (trackedDirtyEntries.length > 0) {
          blockers.push(
            `origin/main 有 ${before.behind} 個新提交，且工作樹有未提交差異；先提交或回復後才能自動同步推送`
          );
        } else {
          blockers.push(`origin/main 有 ${before.behind} 個新提交，先同步後才能 push`);
        }
      }
    }
    if (blockers.length > 0) {
      return {
        pushed: false,
        stdout: "",
        stderr: "",
        status: before,
        blockers: Array.from(new Set(blockers)),
        warnings,
      };
    }

    const pushResult = await runGit(["push", "origin", "main"], 60_000);
    const after = await getStatus();
    return {
      pushed: true,
      stdout: [...rebaseOutputs.map((item) => item.stdout.trim()), pushResult.stdout.trim()]
        .filter(Boolean)
        .join("\n"),
      stderr: [...rebaseOutputs.map((item) => item.stderr.trim()), pushResult.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
      status: after,
      blockers: [],
      warnings: Array.from(new Set([...warnings, ...after.warnings])),
    };
  }

  async function pushBaseline(): Promise<RagicDefinitionsVersionControlPushResult> {
    return withDefinitionsWriteLock(() => pushBaselineUnlocked());
  }

  return {
    getStatus,
    commitBaseline,
    pushBaseline,
  };
}

export type RagicDefinitionsVersionControlService = ReturnType<
  typeof createRagicDefinitionsVersionControlService
>;

export const ragicDefinitionsVersionControlService =
  createRagicDefinitionsVersionControlService();
