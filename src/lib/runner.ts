import path from "node:path";

import { Codex } from "@openai/codex-sdk";

import {
  collectWorktreeReview,
  createWorktreeBranch,
  createWorktree,
  inspectBranchDeleteCandidate,
  inspectProject,
  inspectWorktreeChanges,
  pruneWorktrees,
  removeBranch,
  removeWorktree,
} from "./git";
import {
  getContinueRunBlockedReason,
  getReopenFollowUpsError,
} from "./followUps";
import { isAbortError } from "./process";
import { hasStrongLatestTurnCompletionEvidence } from "./runCompletion";
import { isRunActiveStatus, isRunPendingStatus, isRunTerminalStatus } from "./runStatus";
import { getWorkflow } from "./workflows/registry";

import type {
  Batch,
  BatchDeleteBranchPreviewEntry,
  BatchDeletePreview,
  BatchDeleteWorktreePreviewEntry,
  BatchStatus,
  BatchStore,
  BranchRemovalResult,
  CodexTurnConfig,
  GenerationTask,
  ProjectContext,
  Run,
  RunLog,
  RunTurn,
  RunUsage,
  StreamItem,
  WorktreeRemovalResult,
} from "../types";

const MAX_LOG_ENTRIES = 160;
const MAX_TEXT_LENGTH = 24_000;
const WORKTREE_REMOVE_RETRY_DELAY_MS = 500;
const WORKTREE_REMOVE_RETRY_ATTEMPTS = 6;
const BATCH_SETTLE_TIMEOUT_MS = 5_000;
const NON_INTERACTIVE_APPROVAL_POLICY = "never" as const;
let logIdCounter = 0;

type RunAbortReason = "batch_cancel" | "stop" | "rerun";

interface ExecutionState {
  titleController: AbortController | null;
  generationController: AbortController | null;
  runControllers: Map<string, AbortController>;
  runAbortReasons: Map<string, RunAbortReason>;
  schedulerPromise: Promise<void> | null;
  schedulerDirty: boolean;
  schedulerWake: (() => void) | null;
}

interface CodexThreadHandle {
  run(prompt: string, options?: object): Promise<{ finalResponse: string }>;
  runStreamed(prompt: string, options?: object): Promise<{ events: AsyncIterable<unknown> }>;
}

interface CodexClientHandle {
  startThread(sessionConfig: object): CodexThreadHandle;
  resumeThread(threadId: string, sessionConfig: object): CodexThreadHandle;
}

const executionRegistry = new Map<string, ExecutionState>();
let codexClientFactory = (config?: Record<string, unknown>): CodexClientHandle => new Codex({
  apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,
  config: (config || {}) as never,
}) as unknown as CodexClientHandle;

export function nowIso(): string {
  return new Date().toISOString();
}

function createLogId(): string {
  logIdCounter += 1;
  return `log-${Date.now().toString(36)}-${logIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function upsertItemList(items: StreamItem[], item: unknown): void {
  const nextItem = sanitizeItem(item);
  const existingIndex = items.findIndex((entry) => entry.id === nextItem.id);

  if (existingIndex >= 0) {
    items[existingIndex] = nextItem;
  } else {
    items.push(nextItem);
  }
}

function appendLog(run: Run, level: string, message: string): void {
  run.logs.push({
    id: createLogId(),
    at: nowIso(),
    level,
    message: truncateText(message, 1_200),
  });

  if (run.logs.length > MAX_LOG_ENTRIES) {
    run.logs.splice(0, run.logs.length - MAX_LOG_ENTRIES);
  }
}

export function setCodexClientFactoryForTests(
  factory: ((config?: Record<string, unknown>) => CodexClientHandle) | null,
): void {
  codexClientFactory = factory || ((config?: Record<string, unknown>) => new Codex({
    apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,
    config: (config || {}) as never,
  }) as unknown as CodexClientHandle);
}

export function getCodexClient(config: Record<string, unknown> = {}): CodexClientHandle {
  return codexClientFactory(config);
}

export function getExecutionState(batchId: string): ExecutionState {
  if (!executionRegistry.has(batchId)) {
    executionRegistry.set(batchId, {
      titleController: null,
      generationController: null,
      runControllers: new Map(),
      runAbortReasons: new Map(),
      schedulerPromise: null,
      schedulerDirty: false,
      schedulerWake: null,
    });
  }

  return executionRegistry.get(batchId)!;
}

function clearExecutionState(batchId: string): void {
  executionRegistry.delete(batchId);
}

export function maybeClearExecutionState(batchId: string, execution: ExecutionState | undefined): void {
  if (!execution) {
    return;
  }

  if (
    execution.titleController
    || execution.generationController
    || execution.runControllers.size > 0
    || execution.schedulerPromise
  ) {
    return;
  }

  if (executionRegistry.get(batchId) === execution) {
    clearExecutionState(batchId);
  }
}

function abortRunExecution(batchId: string, runId: string, reason: RunAbortReason): void {
  const execution = executionRegistry.get(batchId);
  const controller = execution?.runControllers.get(runId);
  if (!execution || !controller) {
    return;
  }

  execution.runAbortReasons.set(runId, reason);
  controller.abort();
}

function abortBatchExecution(batchId: string): void {
  const execution = executionRegistry.get(batchId);
  execution?.titleController?.abort();
  execution?.generationController?.abort();
  for (const runId of execution?.runControllers.keys() ?? []) {
    abortRunExecution(batchId, runId, "batch_cancel");
  }
}

function notifyBatchScheduler(batchId: string): void {
  const execution = getExecutionState(batchId);
  execution.schedulerDirty = true;
  const wake = execution.schedulerWake;
  execution.schedulerWake = null;
  wake?.();
}

async function waitForBatchSchedulerSignal(execution: ExecutionState): Promise<void> {
  if (execution.schedulerDirty) {
    execution.schedulerDirty = false;
    return;
  }

  await new Promise<void>((resolve) => {
    execution.schedulerWake = () => resolve();
  });
  execution.schedulerWake = null;
  execution.schedulerDirty = false;
}

function getBatchWorktreeRuns(batch: Batch): Run[] {
  return batch.runs.filter((run) => Boolean(run.worktreePath));
}

function createTurnId(runIndex: number, turnIndex: number): string {
  return `turn-${runIndex + 1}-${turnIndex + 1}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildRunTurn(prompt: string, runIndex: number, turnIndex: number): RunTurn {
  return {
    id: createTurnId(runIndex, turnIndex),
    index: turnIndex,
    prompt,
    status: "queued",
    submittedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    finalResponse: "",
    error: null,
    usage: null,
    codexConfig: null,
    items: [],
  };
}

interface BuildCodexTurnConfigOptions {
  launchMode: "start" | "resume";
  developerPrompt?: string | null;
  clientConfig?: Record<string, unknown>;
  sessionConfig: {
    model?: string | null;
    sandboxMode: string;
    approvalPolicy: string;
    workingDirectory: string;
    additionalDirectories?: string[];
    networkAccessEnabled: boolean;
    webSearchEnabled: boolean;
    webSearchMode: string;
    modelReasoningEffort?: string | null;
  };
  resumeThreadId?: string | null;
}

export function buildCodexTurnConfig(options: BuildCodexTurnConfigOptions): CodexTurnConfig {
  const clientConfig = compactJson(options.clientConfig || {}) as Record<string, unknown>;
  const developerPrompt = String(
    options.developerPrompt
      ?? clientConfig.developer_instructions
      ?? "",
  ).trim();
  const additionalDirectories = Array.from(new Set(
    (options.sessionConfig.additionalDirectories || [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  ));

  return {
    launchMode: options.launchMode,
    developerPrompt: developerPrompt || null,
    clientConfig,
    sessionConfig: {
      model: options.sessionConfig.model?.trim() || null,
      sandboxMode: options.sessionConfig.sandboxMode,
      approvalPolicy: options.sessionConfig.approvalPolicy,
      workingDirectory: options.sessionConfig.workingDirectory,
      additionalDirectories,
      networkAccessEnabled: options.sessionConfig.networkAccessEnabled,
      webSearchEnabled: options.sessionConfig.webSearchEnabled,
      webSearchMode: options.sessionConfig.webSearchMode,
      modelReasoningEffort: options.sessionConfig.modelReasoningEffort?.trim() || null,
    },
    resumeThreadId: options.launchMode === "resume"
      ? String(options.resumeThreadId ?? "").trim() || null
      : null,
  };
}

function getRunTurn(run: Run, turnId: string): RunTurn | null {
  return run.turns.find((turn) => turn.id === turnId) ?? null;
}

function getLatestRunTurn(run: Run): RunTurn | null {
  return run.turns.at(-1) ?? null;
}

function buildFlattenedItems(turns: RunTurn[]): StreamItem[] {
  return turns.flatMap((turn) =>
    turn.items.map((item) => ({
      ...item,
      id: `${turn.id}:${item.id}`,
    })) as StreamItem[],
  );
}

function mergeUsage(left: RunUsage | null, right: RunUsage | null): RunUsage | null {
  if (!left && !right) {
    return null;
  }

  return {
    input_tokens: Number(left?.input_tokens ?? 0) + Number(right?.input_tokens ?? 0),
    output_tokens: Number(left?.output_tokens ?? 0) + Number(right?.output_tokens ?? 0),
    total_tokens:
      (left?.total_tokens != null || right?.total_tokens != null)
        ? Number(left?.total_tokens ?? 0) + Number(right?.total_tokens ?? 0)
        : undefined,
  };
}

function aggregateRunUsage(turns: RunTurn[]): RunUsage | null {
  return turns.reduce<RunUsage | null>((acc, turn) => mergeUsage(acc, turn.usage), null);
}

function getLatestTurnResponse(turns: RunTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].finalResponse) {
      return turns[index].finalResponse;
    }
  }
  return "";
}

function syncRunDerivedState(run: Run): void {
  const latestTurn = getLatestRunTurn(run);
  run.status = latestTurn?.status ?? run.status;
  run.completedAt = latestTurn?.completedAt ?? null;
  run.error = latestTurn?.error ?? null;
  run.finalResponse = getLatestTurnResponse(run.turns);
  run.usage = aggregateRunUsage(run.turns);
  run.items = buildFlattenedItems(run.turns);

  const firstStartedAt = run.turns.find((turn) => turn.startedAt)?.startedAt ?? null;
  if (!run.startedAt && firstStartedAt) {
    run.startedAt = firstStartedAt;
  }
}
const CREATED_BRANCH_LOG_PREFIX = "Created branch ";
const CREATED_BRANCH_LOG_SUFFIX = ".";

export function getRunCreatedBranchName(run: Run): string | null {
  for (let index = run.logs.length - 1; index >= 0; index -= 1) {
    const message = String(run.logs[index]?.message ?? "");
    if (!message.startsWith(CREATED_BRANCH_LOG_PREFIX) || !message.endsWith(CREATED_BRANCH_LOG_SUFFIX)) {
      continue;
    }

    const branchName = message
      .slice(CREATED_BRANCH_LOG_PREFIX.length, message.length - CREATED_BRANCH_LOG_SUFFIX.length)
      .trim();
    if (branchName) {
      return branchName;
    }
  }

  return null;
}

function resolveRunDeleteComparisonRef(batch: Batch, run: Run): string | null {
  return run.baseRef || batch.config.baseRef || batch.projectContext?.branchName || batch.projectContext?.headSha || null;
}

function buildWorktreePreviewEntry(run: Run, summary: Awaited<ReturnType<typeof inspectWorktreeChanges>>): BatchDeleteWorktreePreviewEntry {
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
    statusEntries: summary.statusEntries,
    error: summary.error,
  };
}

async function buildBatchDeletePreview(batch: Batch, repoRoot?: string | null): Promise<BatchDeletePreview> {
  const worktreeRuns = getBatchWorktreeRuns(batch);
  const worktrees: BatchDeleteWorktreePreviewEntry[] = await Promise.all(
    worktreeRuns.map(async (run) => {
      const summary = await inspectWorktreeChanges(run.worktreePath!);
      return buildWorktreePreviewEntry(run, summary);
    }),
  );
  const branchRuns = batch.runs
    .map((run) => ({ run, branchName: getRunCreatedBranchName(run) }))
    .filter((entry): entry is { run: Run; branchName: string } => Boolean(entry.branchName));

  let resolvedRepoRoot = repoRoot || null;
  let repoRootError = "";
  if (!resolvedRepoRoot && branchRuns.length > 0) {
    try {
      resolvedRepoRoot = await resolveBatchRepoRoot(batch);
    } catch (error) {
      repoRootError = (error as Error).message || "Failed to resolve the repository root.";
    }
  }

  const branches: BatchDeleteBranchPreviewEntry[] = resolvedRepoRoot
    ? await Promise.all(
      branchRuns.map(({ run, branchName }) =>
        inspectBranchDeleteCandidate({
          repoRoot: resolvedRepoRoot!,
          runId: run.id,
          runIndex: run.index,
          runTitle: run.title,
          branchName,
          comparisonRef: resolveRunDeleteComparisonRef(batch, run),
        }),
      ),
    )
    : branchRuns.map(({ run, branchName }) => ({
      runId: run.id,
      runIndex: run.index,
      runTitle: run.title,
      branchName,
      comparisonRef: resolveRunDeleteComparisonRef(batch, run),
      exists: true,
      aheadCount: null,
      behindCount: null,
      safeToDelete: false,
      canDelete: false,
      deleteByDefault: false,
      requiresForce: false,
      decisionReason: "Could not inspect this branch right now. Kept unchecked by default.",
      error: repoRootError || "Failed to resolve the repository root.",
    }));

  const dirtyWorktrees = worktrees.filter((entry) => entry.isDirty);
  const inspectFailures = worktrees.filter((entry) => entry.error);
  const safeBranches = branches.filter((entry) => entry.safeToDelete && entry.canDelete);
  const riskyBranches = branches.filter((entry) => entry.exists && entry.canDelete && !entry.safeToDelete);
  const branchInspectFailures = branches.filter((entry) => entry.error);

  return {
    batchId: batch.id,
    worktreeCount: worktrees.length,
    dirtyWorktreeCount: dirtyWorktrees.length,
    inspectFailureCount: inspectFailures.length,
    worktrees,
    branchCount: branches.length,
    safeBranchCount: safeBranches.length,
    riskyBranchCount: riskyBranches.length,
    branchInspectFailureCount: branchInspectFailures.length,
    branches,
  };
}

async function resolveBatchRepoRoot(batch: Batch): Promise<string> {
  if (batch.projectContext?.repoRoot) {
    return batch.projectContext.repoRoot;
  }

  const projectContext = await inspectProject(batch.config.projectPath);
  return projectContext.repoRoot;
}

function buildCleanupFailureMessage(
  label: "worktree" | "branch",
  failedEntries: Array<{ runTitle: string; error: string }>,
): string {
  if (failedEntries.length === 0) {
    return "";
  }

  const details = failedEntries
    .map((entry) => `${entry.runTitle}: ${entry.error}`)
    .join(" | ");

  const singularLabel = label;
  const pluralLabel = `${label}s`;

  return failedEntries.length === 1
    ? `Failed to remove 1 ${singularLabel}. ${details}`
    : `Failed to remove ${failedEntries.length} ${pluralLabel}. ${details}`;
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
  return batch?.runs.some((run) => isRunPendingStatus(run.status)) ?? false;
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
  entry: BatchDeleteWorktreePreviewEntry,
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

async function removeBranchWithRetries(
  repoRoot: string,
  branchName: string,
  force: boolean,
): Promise<BranchRemovalResult> {
  let result: BranchRemovalResult | null = null;

  for (let attempt = 0; attempt < WORKTREE_REMOVE_RETRY_ATTEMPTS; attempt += 1) {
    result = await removeBranch(repoRoot, branchName, { force });
    if (result.removed || !isRetryableWorktreeRemovalError(result.error)) {
      return result;
    }

    await sleep(WORKTREE_REMOVE_RETRY_DELAY_MS);
  }

  return result!;
}

export function createRunId(index: number): string {
  return `run-${index + 1}`;
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function buildCandidateDeveloperInstructions(branchName: string): string {
  return [
    "Work on the branch in the metadata below and produce exactly one commit for this run.",
    "Use `agents-runner-workflow.create_commit` to create the commit instead of running `git commit` directly.",
    "Use the worktree root from `git rev-parse --show-toplevel` as `working_folder`, and include only task-relevant files.",
    "",
    "<ranked_candidate_metadata>",
    `  <branch>${escapeXml(branchName)}</branch>`,
    "</ranked_candidate_metadata>",
  ].join("\n");
}

export function buildRunRecord(
  task: GenerationTask,
  index: number,
  kind: "candidate" | "reviewer" | "validator" = "candidate",
  reviewedRunId: string | null = null,
): Run {
  return {
    id: createRunId(index),
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
    turns: [buildRunTurn(task.prompt, index, 0)],
    items: [],
    review: null,
    followUpsReopened: false,
    followUpsReopenedAt: null,
    kind,
    score: null,
    rank: null,
    reviewedRunId,
  };
}


export function finalizeQueuedRun(
  store: BatchStore,
  batchId: string,
  runId: string,
  status: "failed" | "cancelled",
  message: string,
): void {
  store.updateRun(batchId, runId, (run) => {
    const turn = run.turns.at(0);
    if (!turn || turn.status !== "queued") {
      return;
    }

    turn.status = status;
    turn.completedAt = nowIso();
    turn.error = message;
    run.completedAt = nowIso();
    run.error = message;
    appendLog(run, status === "cancelled" ? "warning" : "error", message);
    syncRunDerivedState(run);
  });
}

export function cancelQueuedRuns(store: BatchStore, batchId: string, message: string): void {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return;
  }

  for (const run of batch.runs) {
    if (run.status !== "queued") {
      continue;
    }

    finalizeQueuedRun(store, batchId, run.id, "cancelled", message);
  }
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

function getBlockingRunIds(batch: Batch): string[] {
  return getWorkflow(batch.mode).getBlockingRunIds(batch);
}

function getReadyQueuedRunIds(batch: Batch): string[] {
  if (batch.cancelRequested) {
    return [];
  }

  const workflow = getWorkflow(batch.mode);
  return batch.runs
    .filter((run) => run.status === "queued" && workflow.isRunReady(batch, run))
    .map((run) => run.id);
}

function isBlockingRun(batch: Batch, runId: string): boolean {
  return getBlockingRunIds(batch).includes(runId);
}

function deriveBatchStatus(batch: Batch): BatchStatus {
  if (batch.cancelRequested) {
    return batch.runs.every((run) => isRunTerminalStatus(run.status)) ? "cancelled" : "running";
  }

  const hasActiveRuns = batch.runs.some((run) => isRunActiveStatus(run.status));
  if (hasActiveRuns) {
    return "running";
  }

  const readyQueuedRunIds = getReadyQueuedRunIds(batch);
  if (readyQueuedRunIds.length > 0) {
    return "running";
  }

  if (getBlockingRunIds(batch).length > 0) {
    return "blocked";
  }

  if (batch.runs.some((run) => run.status === "failed")) {
    return "failed";
  }

  if (batch.startedAt && batch.status === "failed" && batch.runs.length === 0) {
    return "failed";
  }

  if (batch.runs.length === 0) {
    return batch.startedAt ? "running" : "queued";
  }

  return "completed";
}

function getRunTerminalTimestamp(run: Run): string {
  const latestTurn = getLatestRunTurn(run);
  return latestTurn?.completedAt
    || run.completedAt
    || run.logs.at(-1)?.at
    || latestTurn?.startedAt
    || run.startedAt
    || nowIso();
}

function appendLogIfChanged(run: Run, level: string, message: string): void {
  const normalizedMessage = truncateText(message, 1_200);
  const lastLog = run.logs.at(-1);
  if (lastLog?.level === level && lastLog.message === normalizedMessage) {
    return;
  }

  appendLog(run, level, normalizedMessage);
}

interface FinalizeStreamedTurnOptions {
  completedMessage: string;
  cancelled?: boolean;
  cancelMessage?: string;
  streamErrorMessage?: string | null;
}

function finalizeStreamedTurn(run: Run, turn: RunTurn, options: FinalizeStreamedTurnOptions): void {
  const streamErrorMessage = String(options.streamErrorMessage ?? "").trim();

  if (turn.status === "failed") {
    turn.completedAt ||= nowIso();
    if (!turn.error && streamErrorMessage) {
      turn.error = streamErrorMessage;
    }
    syncRunDerivedState(run);
    return;
  }

  if (hasStrongLatestTurnCompletionEvidence(run)) {
    turn.status = "completed";
    turn.completedAt ||= nowIso();
    turn.error = null;
    appendLogIfChanged(run, "info", options.completedMessage);
    if (streamErrorMessage) {
      appendLogIfChanged(run, "warning", streamErrorMessage);
    }
    syncRunDerivedState(run);
    return;
  }

  if (options.cancelled) {
    turn.status = "cancelled";
    turn.completedAt ||= nowIso();
    turn.error = String(options.cancelMessage ?? "").trim() || "Batch cancelled.";
    appendLogIfChanged(run, "warning", turn.error);
    syncRunDerivedState(run);
    return;
  }

  turn.status = "failed";
  turn.completedAt ||= nowIso();
  turn.error = streamErrorMessage || "Run ended without reaching a terminal state.";
  appendLogIfChanged(run, "error", turn.error);
  syncRunDerivedState(run);
}

function refreshBatchLifecycleState(store: BatchStore, batchId: string): Batch | null {
  const before = store.getBatch(batchId);
  if (!before) {
    return null;
  }

  const workflow = getWorkflow(before.mode);
  workflow.reconcileLifecycle(store, batchId);

  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const nextStatus = deriveBatchStatus(batch);
  const shouldNotifySettled = before.status !== nextStatus && (nextStatus === "completed" || nextStatus === "cancelled");

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.status = nextStatus;
    mutableBatch.completedAt =
      nextStatus === "completed" || nextStatus === "cancelled" || nextStatus === "failed"
        ? (mutableBatch.completedAt || nowIso())
        : null;

    if (nextStatus !== "failed" && nextStatus !== "cancelled") {
      mutableBatch.error = null;
    }
  });

  if (shouldNotifySettled) {
    workflow.onBatchSettled(store, batchId);
  }

  return store.getBatch(batchId);
}

export async function generateBatchTitle(store: BatchStore, batchId: string): Promise<string | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const sourcePrompt = getWorkflow(batch.mode).getTitleSourcePrompt(batch);
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
    approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
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

async function streamTurnEvents(
  store: BatchStore,
  batchId: string,
  runId: string,
  turnId: string,
  events: AsyncIterable<unknown>,
): Promise<void> {
  for await (const event of events) {
    let shouldRecomputeRankedScores = false;

    store.updateRun(batchId, runId, (run) => {
      const turn = getRunTurn(run, turnId);
      if (!turn) {
        return;
      }

      const evt = event as Record<string, unknown>;
      switch (evt.type) {
        case "thread.started": {
          const threadId = (evt.thread_id ?? evt.id) as string | undefined;
          if (threadId) {
            run.threadId = threadId;
            if (!isRunTerminalStatus(turn.status) && turn.status !== "running") {
              turn.status = "waiting_for_codex";
            }
            appendLog(run, "info", `Thread started: ${threadId}`);
          }
          break;
        }
        case "turn.started":
          turn.status = "running";
          turn.startedAt ||= nowIso();
          appendLog(run, "info", "Codex turn started.");
          break;
        case "turn.completed":
          turn.status = "completed";
          turn.completedAt ||= nowIso();
          turn.usage = evt.usage as Run["usage"];
          turn.error = null;
          appendLog(run, "info", evt.usage
            ? `Turn completed. Tokens in/out: ${(evt.usage as Record<string, unknown>).input_tokens}/${(evt.usage as Record<string, unknown>).output_tokens}.`
            : "Turn completed.");
          break;
        case "turn.failed":
          turn.status = "failed";
          turn.error = (evt.error as Record<string, unknown>).message as string;
          appendLog(run, "error", turn.error);
          break;
        case "item.started":
          upsertItemList(turn.items, evt.item);
          appendLog(run, "info", describeItem(evt.item as Record<string, unknown>));
          break;
        case "item.updated":
          upsertItemList(turn.items, evt.item);
          break;
        case "item.completed": {
          upsertItemList(turn.items, evt.item);
          const completedItem = evt.item as Record<string, unknown>;

          if (completedItem.type === "agent_message") {
            turn.finalResponse = truncateText(completedItem.text ?? "");
          }

          if (
            completedItem.type === "mcp_tool_call"
            && String(completedItem.server ?? "") === "agents-runner-workflow"
            && String(completedItem.tool ?? "") === "submit_score"
            && String(completedItem.status ?? "") === "completed"
          ) {
            shouldRecomputeRankedScores = true;
          }

          appendLog(run, completedItem.type === "error" ? "warning" : "info", describeItem(completedItem));
          break;
        }
        case "error":
          appendLog(run, "warning", String(evt.message ?? ""));
          break;
        default:
          break;
      }

      syncRunDerivedState(run);
    });

    if (shouldRecomputeRankedScores) {
      const scoresBatch = store.getBatch(batchId);
      if (scoresBatch) {
        getWorkflow(scoresBatch.mode).onScoreSubmitted(store, batchId);
      }
    }
  }
}

function releaseRunExecution(store: BatchStore, batchId: string, runId: string, execution: ExecutionState): void {
  execution.runControllers.delete(runId);
  execution.runAbortReasons.delete(runId);
  refreshBatchLifecycleState(store, batchId);
  notifyBatchScheduler(batchId);
  maybeClearExecutionState(batchId, execution);
}

async function refreshRunReview(
  store: BatchStore,
  batchId: string,
  runId: string,
  worktreePath: string | null,
  baseRef: string | null,
): Promise<void> {
  if (!worktreePath) {
    return;
  }

  const review = await collectWorktreeReview(worktreePath, baseRef).catch(() => null);
  if (!review) {
    return;
  }

  store.updateRun(batchId, runId, (run) => {
    run.review = review;
  });
}

export async function createRunBranch(
  store: BatchStore,
  batchId: string,
  runId: string,
  branchName: string,
): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  if (!runSnapshot.worktreePath) {
    throw new Error("This run does not have a worktree yet.");
  }

  const nextBranchName = String(branchName ?? "").trim();
  if (!nextBranchName) {
    throw new Error("Branch name is required.");
  }

  const execution = getExecutionState(batchId);
  if (execution.runControllers.has(runId)) {
    throw new Error("This run is currently active.");
  }

  await createWorktreeBranch(runSnapshot.worktreePath, nextBranchName);
  const review = await collectWorktreeReview(runSnapshot.worktreePath, runSnapshot.baseRef).catch(() => null);

  store.updateRun(batchId, runId, (run) => {
    run.review = review ?? {
      currentBranch: nextBranchName,
      headSha: run.review?.headSha ?? null,
      comparisonBaseRef: run.review?.comparisonBaseRef ?? null,
      statusShort: run.review?.statusShort ?? "",
      diffStat: run.review?.diffStat ?? "",
      trackedDiff: run.review?.trackedDiff ?? "",
      untrackedFiles: run.review?.untrackedFiles ?? [],
    };
    appendLog(run, "info", `Created branch ${nextBranchName}.`);
  });

  return store.getBatch(batchId);
}

interface ExecuteRunOptions {
  promptOverride?: string;
  sandboxModeOverride?: "workspace-write" | "read-only" | "danger-full-access";
  workingDirectoryOverride?: string;
  additionalDirectoriesOverride?: string[];
  autoCreateBranch?: boolean;
  developerInstructions?: string;
}

export async function executeRun(
  store: BatchStore,
  batchId: string,
  runId: string,
  projectContext: ProjectContext,
  options: ExecuteRunOptions = {},
): Promise<void> {
  const batch = store.getBatch(batchId)!;
  const runSnapshot = batch.runs.find((entry) => entry.id === runId)!;
  const initialTurnId = runSnapshot.turns[0]?.id;
  if (!initialTurnId) {
    throw new Error("Run is missing its initial session turn.");
  }

  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.runControllers.set(runId, controller);

  const baseRef = batch.config.baseRef || projectContext.branchName || projectContext.headSha;
  let worktreePath: string | null = null;

  store.updateRun(batchId, runId, (run) => {
    const turn = getRunTurn(run, initialTurnId);
    if (!turn) {
      return;
    }

    if (options.promptOverride) {
      run.prompt = options.promptOverride;
      turn.prompt = options.promptOverride;
    }

    run.startedAt ||= nowIso();
    run.completedAt = null;
    run.error = null;
    turn.status = "preparing";
    turn.startedAt = null;
    turn.completedAt = null;
    turn.error = null;
    appendLog(run, "info", "Preparing git worktree.");
    syncRunDerivedState(run);
  });

  try {
    const useOverrideWorkingDirectory = Boolean(options.workingDirectoryOverride);
    if (!useOverrideWorkingDirectory) {
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

    }

    const workingDirectory = options.workingDirectoryOverride || (
      projectContext.relativeProjectPath === "."
        ? worktreePath!
        : path.join(worktreePath!, projectContext.relativeProjectPath)
    );
    const additionalDirectories = Array.from(new Set(
      (options.additionalDirectoriesOverride || [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean),
    ));

    store.updateRun(batchId, runId, (run) => {
      run.worktreePath = worktreePath;
      run.workingDirectory = workingDirectory;
      run.baseRef = baseRef;
      run.review = null;
      appendLog(run, "info", useOverrideWorkingDirectory
        ? `Using existing working directory ${workingDirectory}.`
        : `Worktree ready at ${worktreePath}.`);
    });

    let createdBranchName: string | null = null;
    if (options.autoCreateBranch && worktreePath) {
      createdBranchName = `batch/${batchId}/${runId}`;
      await createWorktreeBranch(worktreePath, createdBranchName);
      store.updateRun(batchId, runId, (run) => {
        appendLog(run, "info", `Created branch ${createdBranchName}.`);
      });
    }

    const developerInstructions = options.developerInstructions
      || (createdBranchName ? buildCandidateDeveloperInstructions(createdBranchName) : "");
    const clientConfig = developerInstructions
      ? { developer_instructions: developerInstructions }
      : {};
    const sessionConfig = {
      model: batch.config.model || undefined,
      sandboxMode: options.sandboxModeOverride || batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access",
      approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
      workingDirectory,
      additionalDirectories,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode as "disabled" | "live",
      modelReasoningEffort: (batch.config.reasoningEffort || undefined) as "low" | "medium" | "high" | undefined,
    };
    const turnCodexConfig = buildCodexTurnConfig({
      launchMode: "start",
      developerPrompt: developerInstructions,
      clientConfig,
      sessionConfig,
    });

    store.updateRun(batchId, runId, (run) => {
      const turn = getRunTurn(run, initialTurnId);
      if (!turn) {
        return;
      }

      turn.codexConfig = turnCodexConfig;
    });

    const codex = getCodexClient(clientConfig);
    const thread = codex.startThread(sessionConfig);

    const runPrompt = options.promptOverride || runSnapshot.prompt;
    const { events } = await thread.runStreamed(runPrompt, {
      signal: controller.signal,
    });

    await streamTurnEvents(store, batchId, runId, initialTurnId, events);

    store.updateRun(batchId, runId, (run) => {
      const turn = getRunTurn(run, initialTurnId);
      if (!turn) {
        return;
      }

      finalizeStreamedTurn(run, turn, {
        completedMessage: "Run completed.",
      });
    });

    releaseRunExecution(store, batchId, runId, execution);
    void refreshRunReview(store, batchId, runId, worktreePath, baseRef);
    return;
  } catch (error) {
    const abortReason = execution.runAbortReasons.get(runId);
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested || Boolean(abortReason);
    const cancelMessage = abortReason === "stop"
      ? "Run stopped."
      : abortReason === "rerun"
        ? "Run stopped for rerun."
        : "Batch cancelled.";

    store.updateRun(batchId, runId, (run) => {
      const turn = getRunTurn(run, initialTurnId);
      if (!turn) {
        return;
      }

      finalizeStreamedTurn(run, turn, {
        completedMessage: "Run completed.",
        cancelled,
        cancelMessage,
        streamErrorMessage: cancelled ? null : (error as Error).message,
      });
    });
    releaseRunExecution(store, batchId, runId, execution);
    void refreshRunReview(store, batchId, runId, worktreePath, baseRef);
    return;
  } finally {
    if (execution.runControllers.has(runId)) {
      releaseRunExecution(store, batchId, runId, execution);
    }
  }
}

export async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
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

function launchQueuedRun(
  store: BatchStore,
  batchId: string,
  runId: string,
  projectContext: ProjectContext,
  execution: ExecutionState,
): void {
  void executeRun(
    store,
    batchId,
    runId,
    projectContext,
    getWorkflow(store.getBatch(batchId)!.mode).getRunExecutionOptions(store.getBatch(batchId)!, store.getBatch(batchId)!.runs.find((run) => run.id === runId)!, projectContext),
  ).catch((error) => {
    console.error(`Run ${runId} in batch ${batchId} failed to launch`, error);
  }).finally(() => {
    maybeClearExecutionState(batchId, execution);
  });
}

function startBatchScheduler(store: BatchStore, batchId: string): void {
  const execution = getExecutionState(batchId);
  if (execution.schedulerPromise) {
    notifyBatchScheduler(batchId);
    return;
  }

  execution.schedulerDirty = true;
  execution.schedulerPromise = (async () => {
    while (true) {
      const batch = refreshBatchLifecycleState(store, batchId);
      if (!batch) {
        return;
      }

      if (batch.cancelRequested) {
        cancelQueuedRuns(store, batchId, "Batch cancelled before start.");
        const cancelledBatch = refreshBatchLifecycleState(store, batchId);
        if (cancelledBatch?.status === "cancelled" && execution.runControllers.size === 0) {
          return;
        }
      } else {
        let snapshot = store.getBatch(batchId);
        while (snapshot && execution.runControllers.size < snapshot.config.concurrency) {
          const nextRunId = getReadyQueuedRunIds(snapshot)[0];
          if (!nextRunId) {
            break;
          }

          if (!snapshot.projectContext) {
            throw new Error("Batch is missing its project context.");
          }

          launchQueuedRun(store, batchId, nextRunId, snapshot.projectContext, execution);
          snapshot = refreshBatchLifecycleState(store, batchId);
        }
      }

      const latest = store.getBatch(batchId);
      if (!latest) {
        return;
      }

      if ((latest.status === "completed" || latest.status === "cancelled" || latest.status === "failed") && execution.runControllers.size === 0) {
        return;
      }

      await waitForBatchSchedulerSignal(execution);
    }
  })().finally(() => {
    execution.schedulerPromise = null;
    execution.schedulerWake = null;
    execution.schedulerDirty = false;
    maybeClearExecutionState(batchId, execution);
  });
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

    const workflow = getWorkflow(batch.mode);
    const tasks = await workflow.createTasks(store, batchId, projectContext);

    for (const [index, task] of tasks.entries()) {
      const run = buildRunRecord(task, index, "candidate");
      store.appendRun(batchId, run);
    }

    const latestBatch = store.getBatch(batchId)!;
    const candidateRuns = latestBatch.runs.filter((run) => run.kind === "candidate");
    for (const run of await workflow.createAdditionalRuns(store, batchId, projectContext, candidateRuns)) {
      store.appendRun(batchId, run);
    }

    refreshBatchLifecycleState(store, batchId);
    startBatchScheduler(store, batchId);
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
  }
}

async function waitForRunExecutionToStop(
  store: BatchStore,
  batchId: string,
  runId: string,
  timeoutMs: number = BATCH_SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const execution = executionRegistry.get(batchId);
    const run = store.getBatch(batchId)?.runs.find((entry) => entry.id === runId);
    if (!execution?.runControllers.has(runId) && run && !isRunPendingStatus(run.status)) {
      return;
    }

    await sleep(50);
  }

  throw new Error("Timed out waiting for the run to stop.");
}

function resetRunForFreshAttempt(run: Run): void {
  const originalPrompt = run.prompt;

  run.status = "queued";
  run.startedAt = null;
  run.completedAt = null;
  run.threadId = null;
  run.worktreePath = null;
  run.workingDirectory = null;
  run.baseRef = null;
  run.finalResponse = "";
  run.error = null;
  run.usage = null;
  run.logs = [];
  run.turns = [buildRunTurn(originalPrompt, run.index, 0)];
  run.items = [];
  run.review = null;
  run.followUpsReopened = false;
  run.followUpsReopenedAt = null;
  run.score = null;
  run.rank = null;
}

function buildLifecycleResumePrompt(): string {
  return [
    "Continue from where you left off.",
    "Review the previous failure context in this same Codex thread, recover from it, and finish the run.",
    "Do not restart from scratch unless the earlier attempt already made that necessary.",
  ].join("\n\n");
}

export async function stopRun(store: BatchStore, batchId: string, runId: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  if (batch.cancelRequested) {
    throw new Error("Cancelled batches cannot stop individual runs.");
  }

  if (runSnapshot.status === "failed") {
    if (!isBlockingRun(batch, runId)) {
      throw new Error("Only failed runs that are currently blocking workflow progress can be stopped.");
    }

    store.updateRun(batchId, runId, (run) => {
      const latestTurn = getLatestRunTurn(run);
      if (!latestTurn) {
        return;
      }

      appendLog(run, "warning", `Run stopped after failure. Previous error: ${run.error || latestTurn.error || "Unknown error"}`);
      latestTurn.status = "cancelled";
      latestTurn.completedAt ||= nowIso();
      latestTurn.error = "Run stopped.";
      syncRunDerivedState(run);
    });

    refreshBatchLifecycleState(store, batchId);
    startBatchScheduler(store, batchId);
    return store.getBatch(batchId);
  }

  if (runSnapshot.status === "queued") {
    store.updateRun(batchId, runId, (run) => {
      const latestTurn = getLatestRunTurn(run);
      if (!latestTurn) {
        return;
      }

      latestTurn.status = "cancelled";
      latestTurn.completedAt = nowIso();
      latestTurn.error = "Run stopped before start.";
      appendLog(run, "warning", latestTurn.error);
      syncRunDerivedState(run);
    });

    refreshBatchLifecycleState(store, batchId);
    startBatchScheduler(store, batchId);
    return store.getBatch(batchId);
  }

  if (!isRunPendingStatus(runSnapshot.status)) {
    throw new Error("Only queued, active, or blocking failed runs can be stopped.");
  }

  abortRunExecution(batchId, runId, "stop");
  await waitForRunExecutionToStop(store, batchId, runId);
  refreshBatchLifecycleState(store, batchId);
  startBatchScheduler(store, batchId);
  return store.getBatch(batchId);
}

export async function rerunRun(store: BatchStore, batchId: string, runId: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  if (batch.cancelRequested) {
    throw new Error("Cancelled batches cannot rerun individual runs.");
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  if (!isRunPendingStatus(runSnapshot.status) && runSnapshot.status !== "failed" && runSnapshot.status !== "cancelled") {
    throw new Error("Only active, failed, or cancelled runs can be rerun.");
  }

  if (isRunPendingStatus(runSnapshot.status)) {
    abortRunExecution(batchId, runId, "rerun");
    await waitForRunExecutionToStop(store, batchId, runId);
  }

  const latestBatch = store.getBatch(batchId);
  if (!latestBatch) {
    return null;
  }

  const resetRunIds = new Set(getWorkflow(latestBatch.mode).getRerunResetRunIds(latestBatch, runId));
  if (!resetRunIds.has(runId)) {
    resetRunIds.add(runId);
  }

  for (const nextRunId of resetRunIds) {
    store.updateRun(batchId, nextRunId, (run) => {
      resetRunForFreshAttempt(run);
    });
  }

  refreshBatchLifecycleState(store, batchId);
  startBatchScheduler(store, batchId);
  return store.getBatch(batchId);
}

export async function resumeFailedRun(store: BatchStore, batchId: string, runId: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  if (batch.cancelRequested) {
    throw new Error("Cancelled batches cannot resume individual runs.");
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  if (runSnapshot.status !== "failed") {
    throw new Error("Only failed runs can be resumed.");
  }

  const resumed = await resumeRunWithPrompt(store, batch, runSnapshot, buildLifecycleResumePrompt());
  startBatchScheduler(store, batchId);
  return resumed;
}

export async function continueRun(store: BatchStore, batchId: string, runId: string, prompt: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  if (batch.cancelRequested) {
    throw new Error("This batch has been cancelled and cannot accept new turns.");
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  const blockedReason = getContinueRunBlockedReason(batch, runSnapshot);
  if (blockedReason) {
    throw new Error(blockedReason);
  }

  return resumeRunWithPrompt(store, batch, runSnapshot, prompt);
}

export async function reopenRunFollowUps(store: BatchStore, batchId: string, runId: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  const reopenError = getReopenFollowUpsError(batch, runSnapshot);
  if (reopenError) {
    throw new Error(reopenError);
  }

  store.updateRun(batchId, runId, (run) => {
    run.followUpsReopened = true;
    run.followUpsReopenedAt = nowIso();
    appendLog(run, "info", "Manual follow-up turns enabled.");
  });

  return store.getBatch(batchId);
}

export async function requestRunCommitFollowUp(store: BatchStore, batchId: string, runId: string): Promise<Batch | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  if (batch.cancelRequested) {
    throw new Error("This batch has been cancelled and cannot accept new turns.");
  }

  const runSnapshot = batch.runs.find((entry) => entry.id === runId);
  if (!runSnapshot) {
    throw new Error("Run not found.");
  }

  if (runSnapshot.kind === "reviewer" || runSnapshot.kind === "validator") {
    throw new Error("Only worker runs can request a commit follow-up.");
  }

  if (batch.mode === "validated") {
    const validatorRun = batch.runs.find((entry) => entry.kind === "validator");
    if (!validatorRun || !isRunTerminalStatus(validatorRun.status)) {
      throw new Error("Validated worker runs can request a commit only after the validator run has finished.");
    }
  }

  return resumeRunWithPrompt(store, batch, runSnapshot, buildCommitFollowUpPrompt());
}

function buildCommitFollowUpPrompt(): string {
  return [
    "Inspect the current git worktree yourself and create exactly one commit for the changes that belong together.",
    "Resolve the git worktree root with `git rev-parse --show-toplevel`, choose the files for the commit, write the commit message, and then call the MCP tool `create_commit` exactly once.",
    "Pass the git worktree root as `working_folder`, pass only the selected file paths in `files`, and do not run `git commit` directly yourself.",
    "After the MCP tool succeeds, reply with the commit SHA, branch, commit message, and any files you intentionally left uncommitted.",
  ].join("\n\n");
}

type SessionConfig = CodexTurnConfig["sessionConfig"];

function buildResumeSessionConfig(batch: Batch, runSnapshot: Run): SessionConfig {
  const previousSessionConfig = getLatestRunTurn(runSnapshot)?.codexConfig?.sessionConfig;

  return {
    model: previousSessionConfig?.model || batch.config.model || null,
    sandboxMode: previousSessionConfig?.sandboxMode
      || (batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access"),
    approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
    workingDirectory: previousSessionConfig?.workingDirectory || runSnapshot.workingDirectory || "",
    additionalDirectories: previousSessionConfig?.additionalDirectories || [],
    networkAccessEnabled: previousSessionConfig?.networkAccessEnabled ?? batch.config.networkAccessEnabled,
    webSearchEnabled: previousSessionConfig?.webSearchEnabled ?? batch.config.webSearchMode !== "disabled",
    webSearchMode: previousSessionConfig?.webSearchMode || (batch.config.webSearchMode as "disabled" | "live"),
    modelReasoningEffort:
      previousSessionConfig?.modelReasoningEffort
      || ((batch.config.reasoningEffort || null) as "low" | "medium" | "high" | null),
  };
}

async function resumeRunWithPrompt(
  store: BatchStore,
  batch: Batch,
  runSnapshot: Run,
  prompt: string,
): Promise<Batch | null> {
  const batchId = batch.id;
  const runId = runSnapshot.id;
  const threadId = runSnapshot.threadId;
  const workingDirectory = runSnapshot.workingDirectory;
  const worktreePath = runSnapshot.worktreePath;
  const baseRef = runSnapshot.baseRef;

  if (!threadId) {
    throw new Error("This run does not have a resumable Codex thread yet.");
  }

  if (!workingDirectory) {
    throw new Error("This run does not have a working directory yet.");
  }

  const execution = getExecutionState(batchId);
  if (execution.runControllers.has(runId)) {
    throw new Error("This run is already active.");
  }

  const sessionConfig = buildResumeSessionConfig(batch, runSnapshot);
  const nextTurn = buildRunTurn(prompt, runSnapshot.index, runSnapshot.turns.length);
  nextTurn.status = "waiting_for_codex";
  nextTurn.codexConfig = buildCodexTurnConfig({
    launchMode: "resume",
    clientConfig: {},
    sessionConfig,
    resumeThreadId: threadId,
  });
  const controller = new AbortController();
  execution.runControllers.set(runId, controller);

  store.updateRun(batchId, runId, (run) => {
    run.turns.push(nextTurn);
    run.startedAt ||= nowIso();
    run.completedAt = null;
    run.error = null;
    run.review = null;
    appendLog(run, "info", `Continuing Codex thread ${run.threadId}.`);
    syncRunDerivedState(run);
  });

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.status = "running";
    mutableBatch.completedAt = null;
    mutableBatch.error = null;
  });

  void (async () => {
    try {
      const codex = getCodexClient();
      const thread = codex.resumeThread(threadId, sessionConfig);

      const { events } = await thread.runStreamed(prompt, {
        signal: controller.signal,
      });

      await streamTurnEvents(store, batchId, runId, nextTurn.id, events);

      store.updateRun(batchId, runId, (run) => {
        const turn = getRunTurn(run, nextTurn.id);
        if (!turn) {
          return;
        }

        finalizeStreamedTurn(run, turn, {
          completedMessage: "Follow-up turn completed.",
        });
      });

      releaseRunExecution(store, batchId, runId, execution);
      void refreshRunReview(store, batchId, runId, worktreePath, baseRef);
      return;
    } catch (error) {
      const abortReason = execution.runAbortReasons.get(runId);
      const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested || Boolean(abortReason);
      const cancelMessage = abortReason === "stop"
        ? "Run stopped."
        : abortReason === "rerun"
          ? "Run stopped for rerun."
          : "Batch cancelled.";

      store.updateRun(batchId, runId, (run) => {
        const turn = getRunTurn(run, nextTurn.id);
        if (!turn) {
          return;
        }

        finalizeStreamedTurn(run, turn, {
          completedMessage: "Follow-up turn completed.",
          cancelled,
          cancelMessage,
          streamErrorMessage: cancelled ? null : (error as Error).message,
        });
      });

      releaseRunExecution(store, batchId, runId, execution);
      void refreshRunReview(store, batchId, runId, worktreePath, baseRef);
      return;
    } finally {
      if (execution.runControllers.has(runId)) {
        releaseRunExecution(store, batchId, runId, execution);
      }
    }
  })();

  return store.getBatch(batchId);
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
  refreshBatchLifecycleState(store, batchId);
  if (batch.projectContext) {
    startBatchScheduler(store, batchId);
  } else {
    notifyBatchScheduler(batchId);
  }
  return store.getBatch(batchId);
}

export async function previewBatchDelete(store: BatchStore, batchId: string): Promise<BatchDeletePreview | null> {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return null;
  }

  return buildBatchDeletePreview(batch);
}

export interface DeleteBatchOptions {
  removeWorktrees?: boolean;
  removeBranches?: string[];
}

interface WorktreeCleanupResult {
  removedCount: number;
  failedCount: number;
  worktrees: Array<BatchDeleteWorktreePreviewEntry & { removed: boolean; error: string }>;
  pruneError: string;
}

interface BranchCleanupResult {
  removedCount: number;
  failedCount: number;
  branches: Array<BatchDeleteBranchPreviewEntry & { removed: boolean; forced: boolean; error: string }>;
}

interface DeleteBatchCleanupResult {
  worktrees: WorktreeCleanupResult;
  branches: BranchCleanupResult;
}

export interface DeleteBatchResult {
  batch: Batch | null;
  deletePreview: BatchDeletePreview | null;
  cleanup: DeleteBatchCleanupResult | null;
}

export async function deleteBatch(store: BatchStore, batchId: string, options: DeleteBatchOptions = {}): Promise<DeleteBatchResult | null> {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return null;
  }

  const removeWorktreesRequested = Boolean(options.removeWorktrees);
  const selectedBranchNames = Array.from(new Set(
    (options.removeBranches || [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  ));
  batch.cancelRequested = true;
  abortBatchExecution(batchId);
  store.updateBatch(batchId, () => {});

  let deletePreview: BatchDeletePreview | null = null;
  let cleanup: DeleteBatchCleanupResult | null = null;
  if (removeWorktreesRequested) {
    await waitForBatchToSettle(store, batchId);
    let repoRoot: string | null = null;
    if (selectedBranchNames.length > 0) {
      try {
        repoRoot = await resolveBatchRepoRoot(batch);
      } catch (error) {
        throw new BatchDeleteCleanupError(`Failed to resolve the repository root for branch cleanup. ${(error as Error).message}`, {
          deletePreview: null,
          cleanup: null,
        });
      }
    }
    deletePreview = await buildBatchDeletePreview(batch, repoRoot);
    cleanup = {
      worktrees: {
        removedCount: 0,
        failedCount: 0,
        worktrees: [],
        pruneError: "",
      },
      branches: {
        removedCount: 0,
        failedCount: 0,
        branches: [],
      },
    };

    if (deletePreview.worktreeCount > 0) {
      if (!repoRoot) {
        try {
          repoRoot = await resolveBatchRepoRoot(batch);
        } catch (error) {
          throw new BatchDeleteCleanupError(`Failed to resolve the repository root for worktree cleanup. ${(error as Error).message}`, {
            deletePreview,
            cleanup,
          });
        }
      }
      const removals = await Promise.all(
        deletePreview.worktrees.map(async (entry) => {
          const result = await removeWorktreeWithRetries(repoRoot!, entry);
          return {
            ...entry,
            removed: result.removed,
            error: result.error,
          };
        }),
      );

      const pruneResult = await pruneWorktrees(repoRoot);
      const failedRemovals = removals.filter((entry) => !entry.removed);
      cleanup.worktrees = {
        removedCount: removals.filter((entry) => entry.removed).length,
        failedCount: failedRemovals.length,
        worktrees: removals,
        pruneError: pruneResult.ok ? "" : pruneResult.error,
      };

      if (failedRemovals.length > 0 || cleanup.worktrees.pruneError) {
        throw new BatchDeleteCleanupError(buildCleanupFailureMessage("worktree", failedRemovals) || cleanup.worktrees.pruneError, {
          deletePreview,
          cleanup,
        });
      }
    }

    if (selectedBranchNames.length > 0) {
      if (!repoRoot) {
        try {
          repoRoot = await resolveBatchRepoRoot(batch);
        } catch (error) {
          throw new BatchDeleteCleanupError(`Failed to resolve the repository root for branch cleanup. ${(error as Error).message}`, {
            deletePreview,
            cleanup,
          });
        }
      }

      const previewBranchMap = new Map(deletePreview.branches.map((entry) => [entry.branchName, entry]));
      const invalidSelections = selectedBranchNames.filter((branchName) => !previewBranchMap.has(branchName));
      if (invalidSelections.length > 0) {
        throw new BatchDeleteCleanupError(
          invalidSelections.length === 1
            ? `Cannot remove branch ${invalidSelections[0]} because it is not part of this batch preview.`
            : `Cannot remove ${invalidSelections.length} selected branches because they are not part of this batch preview.`,
          {
            deletePreview,
            cleanup,
          },
        );
      }

      const blockedSelections = selectedBranchNames
        .map((branchName) => previewBranchMap.get(branchName)!)
        .filter((entry) => !entry.canDelete);
      if (blockedSelections.length > 0) {
        throw new BatchDeleteCleanupError(
          blockedSelections.length === 1
            ? `Cannot remove branch ${blockedSelections[0].branchName}. ${blockedSelections[0].decisionReason}`
            : `Cannot remove ${blockedSelections.length} selected branches because at least one branch is not eligible for cleanup.`,
          {
            deletePreview,
            cleanup,
          },
        );
      }

      const branchRemovals = await Promise.all(
        selectedBranchNames.map(async (branchName) => {
          const previewEntry = previewBranchMap.get(branchName)!;
          const result = await removeBranchWithRetries(repoRoot!, branchName, previewEntry.requiresForce);
          return {
            ...previewEntry,
            removed: result.removed,
            forced: result.forced,
            error: result.error,
          };
        }),
      );
      const failedBranchRemovals = branchRemovals.filter((entry) => !entry.removed);
      cleanup.branches = {
        removedCount: branchRemovals.filter((entry) => entry.removed).length,
        failedCount: failedBranchRemovals.length,
        branches: branchRemovals,
      };

      if (failedBranchRemovals.length > 0) {
        throw new BatchDeleteCleanupError(buildCleanupFailureMessage("branch", failedBranchRemovals), {
          deletePreview,
          cleanup,
        });
      }
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
