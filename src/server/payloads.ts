import path from "node:path";

import { DEFAULT_RUN_COUNT, DEFAULT_SANDBOX_MODE } from "./constants";

import type { BatchMode } from "../types";

const MAX_BATCH_RUN_COUNT = 50;

function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, parsed));
}

export function normalizeString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeMode(value: unknown): BatchMode {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function getProjectFolderLabel(projectPath: string): string {
  const normalizedPath = String(projectPath ?? "").replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || normalizedPath;
}

function buildFallbackBatchTitle({
  mode,
  runCount,
  projectPath,
}: {
  mode: BatchMode;
  runCount: number;
  projectPath: string;
}): string {
  const projectLabel = getProjectFolderLabel(projectPath);
  const modeLabel = mode === "generated" ? "Generated" : "Repeated";
  return projectLabel ? `${projectLabel} - ${modeLabel} x${runCount}` : `${modeLabel} x${runCount}`;
}

export interface NormalizedCreateBatchPayload {
  mode: BatchMode;
  title: string;
  autoGenerateTitle: boolean;
  config: {
    runCount: number;
    concurrency: number;
    projectPath: string;
    worktreeRoot: string;
    prompt: string;
    taskPrompt: string;
    baseRef: string;
    model: string;
    sandboxMode: string;
    networkAccessEnabled: boolean;
    webSearchMode: string;
    reasoningEffort: string;
  };
}

export function normalizeCreateBatchPayload(body: Record<string, unknown>): NormalizedCreateBatchPayload {
  const mode = normalizeMode(body.mode ?? body.workflowType);
  const runCount = normalizeInteger(body.runCount, DEFAULT_RUN_COUNT, 1, MAX_BATCH_RUN_COUNT);
  const concurrency = normalizeInteger(body.concurrency, runCount, 1, runCount);
  const projectPath = normalizeString(body.projectPath);
  const worktreeRoot = normalizeString(body.worktreeRoot);
  const prompt = normalizeString(body.prompt);
  const taskPrompt = normalizeString(body.taskPrompt);
  const requestedTitle = normalizeString(body.title);

  if (!projectPath) {
    throw new Error("Project path is required.");
  }

  if (mode === "repeated" && !prompt) {
    throw new Error("Prompt is required for Repeated mode.");
  }

  if (mode === "generated" && !taskPrompt) {
    throw new Error("Task generation prompt is required for Generated mode.");
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedWorktreeRoot = worktreeRoot
    ? path.resolve(worktreeRoot)
    : path.dirname(resolvedProjectPath);

  return {
    mode,
    title: requestedTitle || buildFallbackBatchTitle({ mode, runCount, projectPath: resolvedProjectPath }),
    autoGenerateTitle: !requestedTitle,
    config: {
      runCount,
      concurrency,
      projectPath: resolvedProjectPath,
      worktreeRoot: resolvedWorktreeRoot,
      prompt,
      taskPrompt,
      baseRef: normalizeString(body.baseRef),
      model: normalizeString(body.model),
      sandboxMode: normalizeString(body.sandboxMode) || DEFAULT_SANDBOX_MODE,
      networkAccessEnabled: Boolean(body.networkAccessEnabled),
      webSearchMode: body.webSearchMode === "live" ? "live" : "disabled",
      reasoningEffort: normalizeString(body.reasoningEffort) || "",
    },
  };
}

export function normalizeDeleteBatchPayload(body: Record<string, unknown>): {
  removeWorktrees: boolean;
  removeBranches: string[];
} {
  const removeWorktrees = Boolean(body.removeWorktrees);
  const removeBranches = Array.isArray(body.removeBranches)
    ? Array.from(new Set(
      body.removeBranches
        .map((value) => normalizeString(value))
        .filter(Boolean),
    ))
    : [];

  return {
    removeWorktrees,
    removeBranches: removeWorktrees ? removeBranches : [],
  };
}

export function normalizeContinueRunPayload(body: Record<string, unknown>): { prompt: string } {
  const prompt = normalizeString(body.prompt);
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  return { prompt };
}

export function normalizeCreateBranchPayload(body: Record<string, unknown>): { branchName: string } {
  const branchName = normalizeString(body.branchName);
  if (!branchName) {
    throw new Error("Branch name is required.");
  }

  return { branchName };
}

