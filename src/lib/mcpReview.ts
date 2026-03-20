import fs from "node:fs/promises";

import { normalizeExistingDirectory } from "./mcpGit";

import type { SubmitScoreToolResult } from "../types";
import type { ManagedWorktreeRecord } from "./mcpGit";

export interface SubmitScoreToolArgs {
  working_folder: string;
  reviewed_run_id: string;
  score: number;
  reason: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    reviewedRunId: args.reviewed_run_id,
    score: args.score,
    reason: args.reason,
  };
}
