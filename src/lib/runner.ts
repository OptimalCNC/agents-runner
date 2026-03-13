import path from "node:path";

import { Codex } from "@openai/codex-sdk";

import {
  collectWorktreeReview,
  createWorktree,
  inspectProject,
  inspectWorktreeChanges,
  pruneWorktrees,
  removeWorktree,
} from "./git";
import { isAbortError } from "./process";

import type {
  Batch,
  BatchStatus,
  BatchStore,
  GenerationTask,
  ProjectContext,
  Run,
  RunLog,
  StreamItem,
  WorktreeRemovalResult,
} from "../types";

const MAX_LOG_ENTRIES = 160;
const MAX_TEXT_LENGTH = 24_000;
const WORKTREE_REMOVE_RETRY_DELAY_MS = 500;
const WORKTREE_REMOVE_RETRY_ATTEMPTS = 6;
const BATCH_SETTLE_TIMEOUT_MS = 5_000;

interface ExecutionState {
  titleController: AbortController | null;
  generationController: AbortController | null;
  runControllers: Map<string, AbortController>;
}

const executionRegistry = new Map<string, ExecutionState>();

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value: unknown, limit: number = MAX_TEXT_LENGTH): string {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n\n...truncated...`;
}

function compactJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function sanitizeItem(item: unknown): StreamItem {
  if (!item || typeof item !== "object") {
    return item as StreamItem;
  }

  const clone = compactJson(item) as Record<string, unknown>;

  if (clone.type === "command_execution") {
    clone.aggregated_output = truncateText(clone.aggregated_output ?? "");
  }

  if (clone.type === "mcp_tool_call" && clone.result) {
    clone.result = compactJson(clone.result);
  }

  if (clone.type === "agent_message") {
    clone.text = truncateText(clone.text ?? "");
  }

  if (clone.type === "reasoning") {
    clone.text = truncateText(clone.text ?? "", 8_000);
  }

  if (clone.type === "error") {
    clone.message = truncateText(clone.message ?? "", 4_000);
  }

  return clone as unknown as StreamItem;
}

function upsertItem(run: Run, item: unknown): void {
  const nextItem = sanitizeItem(item);
  const existingIndex = run.items.findIndex((entry) => entry.id === nextItem.id);

  if (existingIndex >= 0) {
    run.items[existingIndex] = nextItem;
  } else {
    run.items.push(nextItem);
  }
}

function appendLog(run: Run, level: string, message: string): void {
  run.logs.push({
    at: nowIso(),
    level,
    message: truncateText(message, 1_200),
  });

  if (run.logs.length > MAX_LOG_ENTRIES) {
    run.logs.splice(0, run.logs.length - MAX_LOG_ENTRIES);
  }
}

function getCodexClient(): InstanceType<typeof Codex> {
  return new Codex({
    apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,
  });
}

function getExecutionState(batchId: string): ExecutionState {
  if (!executionRegistry.has(batchId)) {
    executionRegistry.set(batchId, {
      titleController: null,
      generationController: null,
      runControllers: new Map(),
    });
  }

  return executionRegistry.get(batchId)!;
}

function clearExecutionState(batchId: string): void {
  executionRegistry.delete(batchId);
}

function maybeClearExecutionState(batchId: string, execution: ExecutionState | undefined): void {
  if (!execution) {
    return;
  }

  if (execution.titleController || execution.generationController || execution.runControllers.size > 0) {
    return;
  }

  if (executionRegistry.get(batchId) === execution) {
    clearExecutionState(batchId);
  }
}

function abortBatchExecution(batchId: string): void {
  const execution = executionRegistry.get(batchId);
  execution?.titleController?.abort();
  execution?.generationController?.abort();
  for (const controller of execution?.runControllers.values() ?? []) {
    controller.abort();
  }
}

function getBatchWorktreeRuns(batch: Batch): Run[] {
  return batch.runs.filter((run) => Boolean(run.worktreePath));
}

interface WorktreePreviewEntry {
  runId: string;
  runIndex: number;
  runTitle: string;
  worktreePath: string;
  isDirty: boolean;
  changeCount: number;
  trackedChangeCount: number;
  untrackedChangeCount: number;
  exists: boolean;
  error: string;
}

interface BatchWorktreePreview {
  batchId: string;
  worktreeCount: number;
  dirtyWorktreeCount: number;
  inspectFailureCount: number;
  worktrees: WorktreePreviewEntry[];
}

async function buildBatchWorktreePreview(batch: Batch): Promise<BatchWorktreePreview> {
  const worktreeRuns = getBatchWorktreeRuns(batch);
  const worktrees: WorktreePreviewEntry[] = await Promise.all(
    worktreeRuns.map(async (run) => {
      const summary = await inspectWorktreeChanges(run.worktreePath!);
      return {
        runId: run.id,
        runIndex: run.index,
        runTitle: run.title,
        worktreePath: summary.worktreePath,
        isDirty: summary.isDirty,
        changeCount: summary.changeCount,
        trackedChangeCount: summary.trackedChangeCount,
        untrackedChangeCount: summary.untrackedChangeCount,
        exists: summary.exists,
        error: summary.error,
      };
    }),
  );

  const dirtyWorktrees = worktrees.filter((entry) => entry.isDirty);
  const inspectFailures = worktrees.filter((entry) => entry.error);

  return {
    batchId: batch.id,
    worktreeCount: worktrees.length,
    dirtyWorktreeCount: dirtyWorktrees.length,
    inspectFailureCount: inspectFailures.length,
    worktrees,
  };
}

async function resolveBatchRepoRoot(batch: Batch): Promise<string> {
  if (batch.projectContext?.repoRoot) {
    return batch.projectContext.repoRoot;
  }

  const projectContext = await inspectProject(batch.config.projectPath);
  return projectContext.repoRoot;
}

function buildCleanupFailureMessage(failedEntries: Array<{ runTitle: string; error: string }>): string {
  if (failedEntries.length === 0) {
    return "";
  }

  const details = failedEntries
    .map((entry) => `${entry.runTitle}: ${entry.error}`)
    .join(" | ");

  return failedEntries.length === 1
    ? `Failed to remove 1 worktree. ${details}`
    : `Failed to remove ${failedEntries.length} worktrees. ${details}`;
}

class BatchDeleteCleanupError extends Error {
  statusCode: number;
  details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BatchDeleteCleanupError";
    this.statusCode = 409;
    this.details = details;
  }
}

function hasActiveRuns(batch: Batch | null): boolean {
  return batch?.runs.some((run) => run.status === "running" || run.status === "queued") ?? false;
}

async function waitForBatchToSettle(store: BatchStore, batchId: string, timeoutMs: number = BATCH_SETTLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = store.getBatch(batchId);
    if (!hasActiveRuns(snapshot)) {
      return;
    }

    await sleep(200);
  }
}

function isRetryableWorktreeRemovalError(message: string | null | undefined): boolean {
  return /permission denied|resource busy|in use|being used|device or resource busy|access is denied/i.test(
    String(message ?? ""),
  );
}

async function removeWorktreeWithRetries(
  repoRoot: string,
  entry: WorktreePreviewEntry,
): Promise<WorktreeRemovalResult> {
  let result: WorktreeRemovalResult | null = null;

  for (let attempt = 0; attempt < WORKTREE_REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    result = await removeWorktree(repoRoot, entry.worktreePath);
    if (result.removed || !isRetryableWorktreeRemovalError(result.error)) {
      return result;
    }

    await sleep(WORKTREE_REMOVE_RETRY_DELAY_MS);
  }

  return result!;
}

function buildRunRecord(task: GenerationTask, index: number): Run {
  return {
    id: `run-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    index,
    title: task.title,
    prompt: task.prompt,
    status: "queued",
    startedAt: null,
    completedAt: null,
    threadId: null,
    worktreePath: null,
    workingDirectory: null,
    baseRef: null,
    finalResponse: "",
    error: null,
    usage: null,
    logs: [],
    items: [],
    review: null,
  };
}

function buildTaskSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "prompt"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            prompt: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

function buildTaskGenerationPrompt(userPrompt: string, count: number): string {
  return [
    userPrompt.trim(),
    "",
    `Generate exactly ${count} coding tasks for parallel Codex execution.`,
    "Each task will run in its own git worktree cloned from the same repository state.",
    "Prefer tasks that do not overlap heavily in files or responsibilities.",
    "Each prompt must be self-contained, concrete, and directly runnable by an autonomous coding agent.",
    'Return only JSON that matches the provided schema with a top-level "tasks" array.',
  ].join("\n");
}

function getProjectFolderName(projectPath: string | null | undefined): string {
  const normalizedPath = String(projectPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!normalizedPath) {
    return "";
  }

  const parts = normalizedPath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalizedPath;
}

function buildBatchTitleSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 80 },
    },
  };
}

function buildBatchTitlePrompt(batch: Batch): string {
  const sourcePrompt = batch.mode === "generated" ? batch.config.taskPrompt : batch.config.prompt;
  const projectFolder = getProjectFolderName(batch.config.projectPath);

  return [
    "Name this coding batch for a dashboard.",
    "Write a concise title that captures the actual engineering goal from the user's prompt.",
    "Requirements:",
    "- 3 to 7 words.",
    "- Specific and concrete.",
    "- No quotes.",
    "- No trailing punctuation.",
    "- Avoid generic words like workflow, batch, run, agent, repeated, or generated unless they are required for clarity.",
    `Project folder: ${projectFolder || batch.config.projectPath}`,
    `Mode: ${batch.mode}`,
    `Run count: ${batch.config.runCount}`,
    "User prompt:",
    truncateText(sourcePrompt, 4_000),
    'Return JSON with a single "title" field.',
  ].join("\n");
}

function sanitizeGeneratedTitle(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "");

  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 80);
}

function describeItem(item: Record<string, unknown>): string {
  switch (item.type) {
    case "command_execution":
      return `${item.status === "failed" ? "Command failed" : "Command"}: ${item.command}`;
    case "file_change":
      return `Patch ${item.status}: ${((item.changes as Array<{ path: string }>) || []).map((change) => change.path).join(", ") || "file updates"}`;
    case "agent_message":
      return "Codex produced a response.";
    case "reasoning":
      return "Reasoning summary updated.";
    case "todo_list":
      return `Todo list updated (${(item.items as Array<{ completed: boolean }>).filter((entry) => entry.completed).length}/${(item.items as Array<{ completed: boolean }>).length}).`;
    case "mcp_tool_call":
      return `${item.server}.${item.tool} ${item.status}`;
    case "web_search":
      return `Web search: ${item.query}`;
    case "error":
      return `Error: ${item.message}`;
    default:
      return item.type as string;
  }
}

function deriveBatchStatus(batch: Batch): BatchStatus {
  if (batch.cancelRequested && batch.runs.every((run) => run.status === "cancelled" || run.status === "completed" || run.status === "failed")) {
    return "cancelled";
  }

  if (batch.runs.some((run) => run.status === "failed")) {
    return "failed";
  }

  if (batch.runs.every((run) => run.status === "completed")) {
    return "completed";
  }

  if (batch.runs.some((run) => run.status === "running")) {
    return "running";
  }

  if (batch.cancelRequested) {
    return "cancelled";
  }

  return "queued";
}

async function generateTasks(store: BatchStore, batchId: string, projectContext: ProjectContext): Promise<GenerationTask[]> {
  const batch = store.getBatch(batchId)!;
  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.generationController = controller;

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.generation!.status = "running";
    mutableBatch.generation!.startedAt = nowIso();
    mutableBatch.generation!.error = null;
  });

  try {
    const codex = getCodexClient();
    const thread = codex.startThread({
      model: batch.config.model || undefined,
      sandboxMode: batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access",
      approvalPolicy: batch.config.approvalPolicy as "never" | "on-request" | "on-failure" | "untrusted",
      workingDirectory: projectContext.projectPath,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode as "disabled" | "live",
      modelReasoningEffort: (batch.config.reasoningEffort || undefined) as "low" | "medium" | "high" | undefined,
    });

    const result = await thread.run(buildTaskGenerationPrompt(batch.config.taskPrompt, batch.config.runCount), {
      signal: controller.signal,
      outputSchema: buildTaskSchema(batch.config.runCount),
    });

    const parsed = JSON.parse(result.finalResponse) as { tasks: Array<{ title?: string; prompt: string }> };
    const tasks: GenerationTask[] = parsed.tasks.map((task, index) => ({
      title: task.title || `Task ${index + 1}`,
      prompt: task.prompt,
    }));

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation!.status = "completed";
      mutableBatch.generation!.completedAt = nowIso();
      mutableBatch.generation!.tasks = tasks;
    });

    return tasks;
  } catch (error) {
    const message = isAbortError(error) ? "Task generation cancelled." : (error as Error).message;

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation!.status = isAbortError(error) ? "cancelled" : "failed";
      mutableBatch.generation!.completedAt = nowIso();
      mutableBatch.generation!.error = message;
      mutableBatch.error = message;
    });

    throw error;
  } finally {
    execution.generationController = null;
    maybeClearExecutionState(batchId, execution);
  }
}

export async function generateBatchTitle(store: BatchStore, batchId: string): Promise<string | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const sourcePrompt = batch.mode === "generated" ? batch.config.taskPrompt : batch.config.prompt;
  if (!sourcePrompt) {
    return batch.title;
  }

  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.titleController = controller;

  const codex = getCodexClient();
  const thread = codex.startThread({
    model: batch.config.model || undefined,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    workingDirectory: batch.config.projectPath,
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "low",
  });

  try {
    const result = await thread.run(buildBatchTitlePrompt(batch), {
      signal: controller.signal,
      outputSchema: buildBatchTitleSchema(),
    });

    const parsed = JSON.parse(result.finalResponse) as { title?: string };
    const nextTitle = sanitizeGeneratedTitle(parsed.title, batch.title);

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.title = nextTitle;
    });

    return nextTitle;
  } catch (error) {
    if (isAbortError(error) || !store.getMutableBatch(batchId)) {
      return null;
    }
    throw error;
  } finally {
    execution.titleController = null;
    maybeClearExecutionState(batchId, execution);
  }
}

async function executeRun(store: BatchStore, batchId: string, runId: string, projectContext: ProjectContext): Promise<void> {
  const batch = store.getBatch(batchId)!;
  const runSnapshot = batch.runs.find((entry) => entry.id === runId)!;
  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.runControllers.set(runId, controller);

  let worktreePath: string | null = null;

  store.updateRun(batchId, runId, (run) => {
    run.status = "running";
    run.startedAt = nowIso();
    appendLog(run, "info", "Preparing git worktree.");
  });

  try {
    const baseRef = batch.config.baseRef || projectContext.branchName || projectContext.headSha;
    worktreePath = await createWorktree({
      repoRoot: projectContext.repoRoot,
      projectPath: projectContext.projectPath,
      worktreeRoot: batch.config.worktreeRoot,
      baseRef,
      branchName: projectContext.branchName,
      headSha: projectContext.headSha,
      batchId,
      runIndex: runSnapshot.index,
    });

    const workingDirectory =
      projectContext.relativeProjectPath === "."
        ? worktreePath
        : path.join(worktreePath, projectContext.relativeProjectPath);

    store.updateRun(batchId, runId, (run) => {
      run.worktreePath = worktreePath;
      run.workingDirectory = workingDirectory;
      run.baseRef = baseRef;
      appendLog(run, "info", `Worktree ready at ${worktreePath}.`);
    });

    const codex = getCodexClient();
    const thread = codex.startThread({
      model: batch.config.model || undefined,
      sandboxMode: batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access",
      approvalPolicy: batch.config.approvalPolicy as "never" | "on-request" | "on-failure" | "untrusted",
      workingDirectory,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode as "disabled" | "live",
      modelReasoningEffort: (batch.config.reasoningEffort || undefined) as "low" | "medium" | "high" | undefined,
    });

    const { events } = await thread.runStreamed(runSnapshot.prompt, {
      signal: controller.signal,
    });

    for await (const event of events) {
      store.updateRun(batchId, runId, (run) => {
        const evt = event as Record<string, unknown>;
        switch (evt.type) {
          case "thread.started":
            run.threadId = evt.thread_id as string;
            appendLog(run, "info", `Thread started: ${evt.thread_id}`);
            break;
          case "turn.started":
            appendLog(run, "info", "Codex turn started.");
            break;
          case "turn.completed":
            run.usage = evt.usage as Run["usage"];
            appendLog(run, "info", evt.usage
              ? `Turn completed. Tokens in/out: ${(evt.usage as Record<string, unknown>).input_tokens}/${(evt.usage as Record<string, unknown>).output_tokens}.`
              : "Turn completed.");
            break;
          case "turn.failed":
            run.error = (evt.error as Record<string, unknown>).message as string;
            appendLog(run, "error", (evt.error as Record<string, unknown>).message as string);
            break;
          case "item.started":
            upsertItem(run, evt.item);
            appendLog(run, "info", describeItem(evt.item as Record<string, unknown>));
            break;
          case "item.updated":
            upsertItem(run, evt.item);
            break;
          case "item.completed":
            upsertItem(run, evt.item);
            if ((evt.item as Record<string, unknown>).type === "agent_message") {
              run.finalResponse = truncateText((evt.item as Record<string, unknown>).text ?? "");
            }
            if ((evt.item as Record<string, unknown>).type === "error") {
              run.error = (evt.item as Record<string, unknown>).message as string;
            }
            appendLog(run, "info", describeItem(evt.item as Record<string, unknown>));
            break;
          case "error":
            run.error = evt.message as string;
            appendLog(run, "error", evt.message as string);
            break;
          default:
            break;
        }
      });
    }

    const review = worktreePath ? await collectWorktreeReview(worktreePath) : null;

    store.updateRun(batchId, runId, (run) => {
      run.status = run.error ? "failed" : "completed";
      run.completedAt = nowIso();
      run.review = review;

      if (!run.error) {
        appendLog(run, "info", "Run completed.");
      }
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;
    const review = worktreePath ? await collectWorktreeReview(worktreePath).catch(() => null) : null;

    store.updateRun(batchId, runId, (run) => {
      run.status = cancelled ? "cancelled" : "failed";
      run.completedAt = nowIso();
      run.error = cancelled ? "Batch cancelled." : (error as Error).message;
      run.review = review ?? run.review;
      appendLog(run, cancelled ? "warning" : "error", run.error!);
    });
  } finally {
    execution.runControllers.delete(runId);
    maybeClearExecutionState(batchId, execution);
  }
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const activeWorkers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(activeWorkers);
}

export async function executeBatch(store: BatchStore, batchId: string): Promise<void> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return;
  }

  const execution = getExecutionState(batchId);

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.status = "running";
    mutableBatch.startedAt = nowIso();
  });

  try {
    const projectContext = await inspectProject(batch.config.projectPath);
    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.projectContext = projectContext;
    });

    const tasks: GenerationTask[] =
      batch.mode === "generated"
        ? await generateTasks(store, batchId, projectContext)
        : Array.from({ length: batch.config.runCount }, (_, index) => ({
            title: `Run ${index + 1}`,
            prompt: batch.config.prompt,
          }));

    for (const [index, task] of tasks.entries()) {
      store.appendRun(batchId, buildRunRecord(task, index));
    }

    const latestBatch = store.getBatch(batchId)!;
    await runWithConcurrency(latestBatch.runs, latestBatch.config.concurrency, async (run) => {
      const mutableBatch = store.getMutableBatch(batchId);
      if (!mutableBatch || mutableBatch.cancelRequested) {
        store.updateRun(batchId, run.id, (mutableRun) => {
          mutableRun.status = "cancelled";
          mutableRun.completedAt = nowIso();
          mutableRun.error = "Batch cancelled before start.";
          appendLog(mutableRun, "warning", mutableRun.error!);
        });
        return;
      }

      await executeRun(store, batchId, run.id, projectContext);
    });

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.status = deriveBatchStatus(mutableBatch);
      mutableBatch.completedAt = nowIso();
    });
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.status = cancelled ? "cancelled" : "failed";
      mutableBatch.completedAt = nowIso();
      mutableBatch.error = cancelled ? "Batch cancelled." : (error as Error).message;

      for (const run of mutableBatch.runs) {
        if (run.status === "queued") {
          run.status = cancelled ? "cancelled" : "failed";
          run.completedAt = nowIso();
          run.error = mutableBatch.error;
        }
      }
    });
  } finally {
    execution.generationController?.abort();
    for (const controller of execution.runControllers.values()) {
      controller.abort();
    }
    execution.generationController = null;
    execution.runControllers.clear();
    maybeClearExecutionState(batchId, execution);
  }
}

export function cancelBatch(store: BatchStore, batchId: string): Batch | null {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return null;
  }

  batch.cancelRequested = true;
  if (batch.status === "queued") {
    batch.status = "cancelled";
    batch.completedAt = nowIso();
  }

  abortBatchExecution(batchId);

  store.updateBatch(batchId, () => {});
  return store.getBatch(batchId);
}

export async function previewBatchDelete(store: BatchStore, batchId: string): Promise<BatchWorktreePreview | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  return buildBatchWorktreePreview(batch);
}

export interface DeleteBatchOptions {
  removeWorktrees?: boolean;
}

interface WorktreeCleanupResult {
  removedCount: number;
  failedCount: number;
  worktrees: Array<WorktreePreviewEntry & { removed: boolean; error: string }>;
  pruneError: string;
}

export interface DeleteBatchResult {
  batch: Batch | null;
  deletePreview: BatchWorktreePreview | null;
  cleanup: WorktreeCleanupResult | null;
}

export async function deleteBatch(store: BatchStore, batchId: string, options: DeleteBatchOptions = {}): Promise<DeleteBatchResult | null> {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return null;
  }

  const removeWorktreesRequested = Boolean(options.removeWorktrees);
  batch.cancelRequested = true;
  abortBatchExecution(batchId);
  store.updateBatch(batchId, () => {});

  let deletePreview: BatchWorktreePreview | null = null;
  let cleanup: WorktreeCleanupResult | null = null;
  if (removeWorktreesRequested) {
    await waitForBatchToSettle(store, batchId);
    deletePreview = await buildBatchWorktreePreview(batch);

    if (deletePreview.worktreeCount > 0) {
      let repoRoot: string;
      try {
        repoRoot = await resolveBatchRepoRoot(batch);
      } catch (error) {
        throw new BatchDeleteCleanupError(`Failed to resolve the repository root for worktree cleanup. ${(error as Error).message}`, {
          deletePreview,
          cleanup: null,
        });
      }
      const removals = await Promise.all(
        deletePreview.worktrees.map(async (entry) => {
          const result = await removeWorktreeWithRetries(repoRoot, entry);
          return {
            ...entry,
            removed: result.removed,
            error: result.error,
          };
        }),
      );

      const pruneResult = await pruneWorktrees(repoRoot);
      const failedRemovals = removals.filter((entry) => !entry.removed);
      cleanup = {
        removedCount: removals.filter((entry) => entry.removed).length,
        failedCount: failedRemovals.length,
        worktrees: removals,
        pruneError: pruneResult.ok ? "" : pruneResult.error,
      };

      if (failedRemovals.length > 0 || cleanup.pruneError) {
        throw new BatchDeleteCleanupError(buildCleanupFailureMessage(failedRemovals) || cleanup.pruneError, {
          deletePreview,
          cleanup,
        });
      }
    } else {
      cleanup = {
        removedCount: 0,
        failedCount: 0,
        worktrees: [],
        pruneError: "",
      };
    }
  }

  clearExecutionState(batchId);
  const deletedBatch = await store.deleteBatch(batchId);
  return {
    batch: deletedBatch,
    deletePreview,
    cleanup,
  };
}
