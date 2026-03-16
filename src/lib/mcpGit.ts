import fs from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./process";

import type { BatchStore, CreateCommitToolResult, SubmitScoreToolResult } from "../types";

export const AGENTS_RUNNER_MCP_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
] as const;

export const LATEST_AGENTS_RUNNER_MCP_PROTOCOL_VERSION = AGENTS_RUNNER_MCP_PROTOCOL_VERSIONS.at(-1)!;

export interface ManagedWorktreeRecord {
  batchId: string;
  runId: string;
  runTitle: string;
  worktreePath: string;
  workingDirectory: string | null;
}

export interface CreateCommitToolArgs {
  working_folder: string;
  files: string[];
  message: string;
}


export interface SubmitScoreToolArgs {
  working_folder: string;
  reviewed_run_id: string;
  score: number;
  reason: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function negotiateMcpProtocolVersion(requestedVersion: unknown): string {
  const normalized = String(requestedVersion ?? "").trim();
  return AGENTS_RUNNER_MCP_PROTOCOL_VERSIONS.includes(normalized as typeof AGENTS_RUNNER_MCP_PROTOCOL_VERSIONS[number])
    ? normalized
    : LATEST_AGENTS_RUNNER_MCP_PROTOCOL_VERSION;
}

async function normalizeExistingDirectory(targetPath: string): Promise<string> {
  return fs.realpath(targetPath).catch(() => path.resolve(targetPath));
}

function normalizeCommitMessage(message: unknown): string {
  return String(message ?? "").trim();
}


function normalizeScore(value: unknown): number {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    throw new Error("score must be a number.");
  }

  if (parsed < 0 || parsed > 100) {
    throw new Error("score must be between 0 and 100.");
  }

  return Number(parsed.toFixed(2));
}

function ensureUniqueFileList(values: string[]): string[] {
  return Array.from(new Set(values));
}

function resolvePathWithinRoot(rootPath: string, requestedPath: string): string {
  const trimmed = String(requestedPath ?? "").trim();
  if (!trimmed) {
    throw new Error("Each file path must be a non-empty string.");
  }

  const resolvedPath = path.resolve(rootPath, trimmed);
  const relativePath = path.relative(rootPath, resolvedPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`File path ${trimmed} must stay inside the requested working folder.`);
  }

  return relativePath.split(path.sep).join("/");
}

async function listStagedFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand("git", ["-C", worktreePath, "diff", "--cached", "--name-only", "--"]);
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function readCurrentBranch(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["-C", worktreePath, "branch", "--show-current"], { allowFailure: true });
  return result.stdout.trim();
}

export async function normalizeCreateCommitToolArgs(args: unknown): Promise<CreateCommitToolArgs> {
  if (!isObject(args)) {
    throw new Error("Commit arguments must be an object.");
  }

  const workingFolder = String(args.working_folder ?? "").trim();
  const message = normalizeCommitMessage(args.message);
  const files = Array.isArray(args.files)
    ? ensureUniqueFileList(args.files.map((value) => String(value ?? "").trim()).filter(Boolean))
    : [];

  if (!workingFolder) {
    throw new Error("working_folder is required.");
  }

  if (files.length === 0) {
    throw new Error("files must contain at least one path.");
  }

  if (!message) {
    throw new Error("message is required.");
  }

  return {
    working_folder: await normalizeExistingDirectory(workingFolder),
    files,
    message,
  };
}



export async function normalizeSubmitScoreToolArgs(args: unknown): Promise<SubmitScoreToolArgs> {
  if (!isObject(args)) {
    throw new Error("Score arguments must be an object.");
  }

  const workingFolder = String(args.working_folder ?? "").trim();
  const reviewedRunId = String(args.reviewed_run_id ?? "").trim();
  const score = normalizeScore(args.score);
  const reason = String(args.reason ?? "").trim();

  if (!workingFolder) {
    throw new Error("working_folder is required.");
  }

  if (!reviewedRunId) {
    throw new Error("reviewed_run_id is required.");
  }

  if (!reason) {
    throw new Error("reason is required.");
  }

  return {
    working_folder: await normalizeExistingDirectory(workingFolder),
    reviewed_run_id: reviewedRunId,
    score,
    reason,
  };
}

export async function collectManagedWorktrees(store: BatchStore): Promise<Map<string, ManagedWorktreeRecord>> {
  const worktrees = new Map<string, ManagedWorktreeRecord>();

  for (const summary of store.listSummaries()) {
    const batch = store.getBatch(summary.id);
    if (!batch) {
      continue;
    }

    for (const run of batch.runs) {
      if (!run.worktreePath) {
        continue;
      }

      const normalizedWorktreePath = await normalizeExistingDirectory(run.worktreePath);
      worktrees.set(normalizedWorktreePath, {
        batchId: batch.id,
        runId: run.id,
        runTitle: run.title,
        worktreePath: normalizedWorktreePath,
        workingDirectory: run.workingDirectory,
      });
    }
  }

  return worktrees;
}



export async function submitManagedRunScore(
  managedWorktrees: Map<string, ManagedWorktreeRecord>,
  rawArgs: unknown,
): Promise<SubmitScoreToolResult> {
  const args = await normalizeSubmitScoreToolArgs(rawArgs);
  const worktree = managedWorktrees.get(args.working_folder);

  if (!worktree) {
    throw new Error("The requested working folder is not one of the active run worktrees managed by Agents Runner.");
  }

  await fs.access(worktree.worktreePath).catch(() => {
    throw new Error("The requested working folder no longer exists on disk.");
  });

  if (worktree.runId !== args.reviewed_run_id) {
    throw new Error("The reviewed_run_id does not match the run tied to the requested working folder.");
  }

  return {
    workingFolder: worktree.worktreePath,
    reviewedRunId: args.reviewed_run_id,
    score: args.score,
    reason: args.reason,
  };
}

export async function createManagedWorktreeCommit(
  managedWorktrees: Map<string, ManagedWorktreeRecord>,
  rawArgs: unknown,
): Promise<CreateCommitToolResult> {
  const args = await normalizeCreateCommitToolArgs(rawArgs);
  const worktree = managedWorktrees.get(args.working_folder);

  if (!worktree) {
    throw new Error("The requested working folder is not one of the active run worktrees managed by Agents Runner.");
  }

  await fs.access(worktree.worktreePath).catch(() => {
    throw new Error("The requested working folder no longer exists on disk.");
  });

  const requestedFiles = ensureUniqueFileList(
    args.files.map((filePath) => resolvePathWithinRoot(worktree.worktreePath, filePath)),
  );
  const requestedFileSet = new Set(requestedFiles);

  const stagedBefore = await listStagedFiles(worktree.worktreePath);
  const preexistingOutsideSelection = stagedBefore.filter((filePath) => !requestedFileSet.has(filePath));
  if (preexistingOutsideSelection.length > 0) {
    throw new Error("This worktree already has staged changes outside the requested commit file set.");
  }

  await runCommand("git", ["-C", worktree.worktreePath, "add", "--", ...requestedFiles]);

  const stagedAfter = await listStagedFiles(worktree.worktreePath);
  if (stagedAfter.length === 0) {
    throw new Error("There are no staged changes to commit for the requested file set.");
  }

  const stagedOutsideSelection = stagedAfter.filter((filePath) => !requestedFileSet.has(filePath));
  if (stagedOutsideSelection.length > 0) {
    throw new Error("The commit would include staged changes outside the requested file set.");
  }

  await runCommand("git", ["-C", worktree.worktreePath, "commit", "-m", args.message]);

  const [commitSha, currentBranch, statResult] = await Promise.all([
    runCommand("git", ["-C", worktree.worktreePath, "rev-parse", "HEAD"]),
    readCurrentBranch(worktree.worktreePath),
    runCommand("git", ["-C", worktree.worktreePath, "show", "--stat", "--format=format:", "-1"]),
  ]);

  return {
    workingFolder: worktree.worktreePath,
    commitSha: commitSha.stdout.trim(),
    branch: currentBranch,
    message: args.message,
    stagedFiles: stagedAfter,
    statSummary: statResult.stdout.trim(),
  };
}
