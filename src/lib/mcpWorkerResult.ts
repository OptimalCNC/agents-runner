import fs from "node:fs/promises";
import path from "node:path";

import { normalizeExistingDirectory } from "./mcpGit";

import type { SubmitResultToolFile, SubmitResultToolResult } from "../types";
import type { ManagedWorktreeRecord } from "./mcpGit";

export interface SubmitResultToolArgs {
  working_folder: string;
  files: Array<{
    path: string;
    explanation: string;
  }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePathWithinRoot(rootPath: string, requestedPath: string): string {
  const trimmed = String(requestedPath ?? "").trim();
  if (!trimmed) {
    throw new Error("Each submitted file path must be a non-empty string.");
  }

  const resolvedPath = path.resolve(rootPath, trimmed);
  const relativePath = path.relative(rootPath, resolvedPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Submitted file path ${trimmed} must stay inside the requested working folder.`);
  }

  return relativePath.split(path.sep).join("/");
}

function normalizeSubmittedFiles(value: unknown): SubmitResultToolFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("files must contain at least one submitted file.");
  }

  const seenPaths = new Set<string>();
  const files: SubmitResultToolFile[] = [];

  for (const entry of value) {
    if (!isObject(entry)) {
      throw new Error("Each submitted file must be an object.");
    }

    const filePath = String(entry.path ?? "").trim();
    const explanation = String(entry.explanation ?? "").trim();

    if (!filePath) {
      throw new Error("Each submitted file requires a path.");
    }

    if (!explanation) {
      throw new Error(`Submitted file ${filePath} requires an explanation.`);
    }

    if (seenPaths.has(filePath)) {
      throw new Error(`Submitted file ${filePath} is duplicated.`);
    }

    seenPaths.add(filePath);
    files.push({ path: filePath, explanation });
  }

  return files;
}

export async function normalizeSubmitResultToolArgs(args: unknown): Promise<SubmitResultToolArgs> {
  if (!isObject(args)) {
    throw new Error("Result arguments must be an object.");
  }

  const workingFolder = String(args.working_folder ?? "").trim();
  if (!workingFolder) {
    throw new Error("working_folder is required.");
  }

  return {
    working_folder: await normalizeExistingDirectory(workingFolder),
    files: normalizeSubmittedFiles(args.files),
  };
}

export async function submitManagedWorkerResult(
  managedWorktrees: Map<string, ManagedWorktreeRecord>,
  rawArgs: unknown,
): Promise<SubmitResultToolResult> {
  const args = await normalizeSubmitResultToolArgs(rawArgs);
  const worktree = managedWorktrees.get(args.working_folder);

  if (!worktree) {
    throw new Error("The requested working folder is not one of the active run worktrees managed by Agents Runner.");
  }

  await fs.access(worktree.worktreePath).catch(() => {
    throw new Error("The requested working folder no longer exists on disk.");
  });

  const files = await Promise.all(args.files.map(async (entry) => {
    const relativePath = resolvePathWithinRoot(worktree.worktreePath, entry.path);
    const absolutePath = path.join(worktree.worktreePath, relativePath);

    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw new Error(`Submitted file ${relativePath} does not exist as a file in the requested working folder.`);
    }

    return {
      path: relativePath,
      explanation: entry.explanation,
    };
  }));

  return {
    workingFolder: worktree.worktreePath,
    runId: worktree.runId,
    files,
  };
}
