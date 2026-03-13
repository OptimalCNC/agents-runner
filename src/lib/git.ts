import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process";

import type {
  DirectoryListing,
  ProjectContext,
  RunReview,
  RunReviewUntrackedFile,
  WorktreeInspection,
  WorktreeRemovalResult,
  PruneResult,
} from "../types";

const MAX_UNTRACKED_PREVIEW_BYTES = 20_000;

function sanitizeSegment(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function truncateText(value: string, limit: number = MAX_UNTRACKED_PREVIEW_BYTES): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n\n...truncated...`;
}

function deriveWorktreeProjectSegment(projectPath: string): string {
  return sanitizeSegment(path.basename(projectPath));
}

function deriveWorktreeBranchSegment(branchName: string, headSha: string): string {
  const normalizedBranch = String(branchName ?? "").trim();
  if (normalizedBranch) {
    return sanitizeSegment(normalizedBranch);
  }

  const shortHead = String(headSha ?? "").trim().slice(0, 7);
  return sanitizeSegment(`detached-${shortHead || "head"}`);
}

export interface WorktreeBaseNameInput {
  projectPath: string;
  branchName: string;
  headSha: string;
  batchId: string;
  runIndex: number;
}

export function buildWorktreeBaseName({
  projectPath,
  branchName,
  headSha,
  batchId,
  runIndex,
}: WorktreeBaseNameInput): string {
  const projectSegment = deriveWorktreeProjectSegment(projectPath);
  const branchSegment = deriveWorktreeBranchSegment(branchName, headSha);
  const batchSegment = sanitizeSegment(batchId);
  const runIndexSegment = sanitizeSegment(String(runIndex + 1));

  return `${projectSegment}-${branchSegment}-${batchSegment}-${runIndexSegment}`;
}

export async function inspectProject(projectPath: string): Promise<ProjectContext> {
  const requestedPath = await fs.realpath(projectPath);
  const repoRoot = (
    await runCommand("git", ["-C", requestedPath, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const repoRootPath = await fs.realpath(repoRoot);
  const relativeProjectPath = path.relative(repoRootPath, requestedPath) || ".";
  const headSha = (
    await runCommand("git", ["-C", requestedPath, "rev-parse", "HEAD"])
  ).stdout.trim();
  const branchName = (
    await runCommand("git", ["-C", requestedPath, "branch", "--show-current"], {
      allowFailure: true,
    })
  ).stdout.trim();

  return {
    projectPath: requestedPath,
    repoRoot: repoRootPath,
    relativeProjectPath,
    headSha,
    branchName,
  };
}

export async function ensureDirectory(targetPath: string): Promise<string> {
  await fs.mkdir(targetPath, { recursive: true });
  return fs.realpath(targetPath).catch(() => path.resolve(targetPath));
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  projectPath: string;
  worktreeRoot: string;
  baseRef: string;
  branchName: string;
  headSha: string;
  batchId: string;
  runIndex: number;
}

export async function createWorktree({
  repoRoot,
  projectPath,
  worktreeRoot,
  baseRef,
  branchName,
  headSha,
  batchId,
  runIndex,
}: CreateWorktreeOptions): Promise<string> {
  const resolvedRoot = await ensureDirectory(worktreeRoot);
  const baseName = buildWorktreeBaseName({
    projectPath,
    branchName,
    headSha,
    batchId,
    runIndex,
  });

  let attempt = 0;
  let candidate = path.join(resolvedRoot, baseName);

  while (true) {
    try {
      await fs.access(candidate);
      attempt += 1;
      candidate = path.join(resolvedRoot, `${baseName}-${attempt}`);
    } catch {
      break;
    }
  }

  await runCommand("git", ["-C", repoRoot, "worktree", "add", "--detach", candidate, baseRef]);
  return candidate;
}

export async function collectWorktreeReview(worktreePath: string): Promise<RunReview> {
  const [statusShort, diffStat, trackedDiff, untracked] = await Promise.all([
    runCommand("git", ["-C", worktreePath, "status", "--short"], { allowFailure: true }),
    runCommand("git", ["-C", worktreePath, "diff", "--stat"], { allowFailure: true }),
    runCommand("git", ["-C", worktreePath, "diff", "--no-ext-diff", "--submodule=diff"], {
      allowFailure: true,
    }),
    runCommand("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], {
      allowFailure: true,
    }),
  ]);

  const untrackedFiles: RunReviewUntrackedFile[] = [];
  const untrackedNames = untracked.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const relativeFile of untrackedNames) {
    const absoluteFile = path.join(worktreePath, relativeFile);

    try {
      const buffer = await fs.readFile(absoluteFile);
      untrackedFiles.push({
        path: relativeFile,
        preview: isTextBuffer(buffer as Buffer)
          ? truncateText((buffer as Buffer).toString("utf8"))
          : "Binary file preview unavailable.",
      });
    } catch (error) {
      untrackedFiles.push({
        path: relativeFile,
        preview: `Unable to read file: ${(error as Error).message}`,
      });
    }
  }

  return {
    statusShort: statusShort.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    trackedDiff: trackedDiff.stdout.trim(),
    untrackedFiles,
  };
}

interface StatusLineCounts {
  statusEntries: string[];
  trackedChangeCount: number;
  untrackedChangeCount: number;
  changeCount: number;
}

function parseStatusLineCounts(statusOutput: string | null | undefined): StatusLineCounts {
  const lines = String(statusOutput ?? "")
    .split("\n")
    .map((value) => value.trimEnd())
    .filter(Boolean);

  let trackedChangeCount = 0;
  let untrackedChangeCount = 0;

  for (const line of lines) {
    if (line.startsWith("?? ")) {
      untrackedChangeCount += 1;
      continue;
    }

    trackedChangeCount += 1;
  }

  return {
    statusEntries: lines,
    trackedChangeCount,
    untrackedChangeCount,
    changeCount: trackedChangeCount + untrackedChangeCount,
  };
}

export async function inspectWorktreeChanges(worktreePath: string): Promise<WorktreeInspection> {
  const resolvedPath = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const exists = await fs.access(resolvedPath).then(() => true).catch(() => false);
  const status = await runCommand(
    "git",
    ["-C", resolvedPath, "status", "--porcelain=v1", "--untracked-files=all"],
    { allowFailure: true },
  );

  const counts = parseStatusLineCounts(status.stdout);
  const errorText = (status.stderr || status.stdout || "").trim();

  return {
    worktreePath: resolvedPath,
    exists,
    isDirty: counts.changeCount > 0,
    changeCount: counts.changeCount,
    trackedChangeCount: counts.trackedChangeCount,
    untrackedChangeCount: counts.untrackedChangeCount,
    statusEntries: counts.statusEntries,
    error: status.code === 0 ? "" : errorText || "Unable to inspect worktree.",
  };
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<WorktreeRemovalResult> {
  const resolvedRepoRoot = await fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const resolvedWorktreePath = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const result = await runCommand(
    "git",
    ["-C", resolvedRepoRoot, "worktree", "remove", "--force", resolvedWorktreePath],
    { allowFailure: true },
  );
  const errorText =
    (result.stderr || result.stdout || "").trim() || "Failed to remove worktree.";
  const missingOnDisk = await fs.access(resolvedWorktreePath).then(() => false).catch(() => true);
  const alreadyMissing =
    missingOnDisk &&
    /does not exist|not a working tree|no such file|cannot find/i.test(errorText);

  return {
    worktreePath: resolvedWorktreePath,
    removed: result.code === 0 || alreadyMissing,
    alreadyMissing,
    error: result.code === 0 || alreadyMissing ? "" : errorText,
  };
}

export async function pruneWorktrees(repoRoot: string): Promise<PruneResult> {
  const resolvedRepoRoot = await fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const result = await runCommand(
    "git",
    ["-C", resolvedRepoRoot, "worktree", "prune", "--expire", "now"],
    { allowFailure: true },
  );

  return {
    ok: result.code === 0,
    error: result.code === 0 ? "" : (result.stderr || result.stdout || "").trim() || "Failed to prune worktrees.",
  };
}

export async function listDirectories(targetPath?: string): Promise<DirectoryListing> {
  const initialPath = targetPath ? path.resolve(targetPath) : os.homedir();
  const resolvedPath = await fs.realpath(initialPath).catch(() => path.resolve(initialPath));
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parentPath = path.dirname(resolvedPath);

  return {
    path: resolvedPath,
    parentPath: parentPath === resolvedPath ? null : parentPath,
    directories,
  };
}
