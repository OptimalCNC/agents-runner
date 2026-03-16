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
import { isAbortError } from "./process";
import { isRunPendingStatus, isRunTerminalStatus } from "./runStatus";

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

interface ExecutionState {
  titleController: AbortController | null;
  generationController: AbortController | null;
  runControllers: Map<string, AbortController>;
}

const executionRegistry = new Map<string, ExecutionState>();

function nowIso(): string {
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

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
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

function getCodexClient(config: Record<string, unknown> = {}): InstanceType<typeof Codex> {
  return new Codex({
    apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.CODEX_BASE_URL,
    config: config as never,
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

  return {
    launchMode: options.launchMode,
    developerPrompt: developerPrompt || null,
    clientConfig,
    sessionConfig: {
      model: options.sessionConfig.model?.trim() || null,
      sandboxMode: options.sessionConfig.sandboxMode,
      approvalPolicy: options.sessionConfig.approvalPolicy,
      workingDirectory: options.sessionConfig.workingDirectory,
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

function getRunCreatedBranchName(run: Run): string | null {
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

function buildRunRecord(
  task: GenerationTask,
  index: number,
  kind: "candidate" | "reviewer" = "candidate",
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
    kind,
    score: null,
    rank: null,
    reviewedRunId,
  };
}


function normalizeNumericScore(value: unknown): number | null {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(100, parsed));
}

function buildCandidateDeveloperInstructions(branchName: string): string {
  return [
    "Follow this git workflow exactly:",
    `- Use branch ${branchName}.`,
    "- Produce exactly one commit for this run.",
    "- Use the MCP server \"agents-runner-workflow\" tool \"create_commit\" to create the commit.",
    "- Do not run git commit directly.",
    "- For create_commit.working_folder, pass the worktree root from `git rev-parse --show-toplevel`.",
    "- For create_commit.files, include only files relevant to this task.",
    "- For create_commit.message, provide a concise commit message.",
    "- In your final response, include the branch name and commit SHA.",
  ].join("\n");
}

function buildReviewRunTitle(candidateRun: Run, reviewIndex: number): string {
  return `Review ${reviewIndex + 1} for ${candidateRun.title}`;
}

function buildReviewTasks(batch: Batch, candidateRun: Run): Array<GenerationTask & { reviewedRunId: string }> {
  return Array.from({ length: batch.config.reviewCount }, (_, reviewIndex) => ({
    title: buildReviewRunTitle(candidateRun, reviewIndex),
    prompt: buildReviewPrompt(batch, candidateRun),
    reviewedRunId: candidateRun.id,
  }));
}

export function buildReviewPrompt(batch: Batch, candidateRun: Run): string {
  const candidateBranch = getRunCreatedBranchName(candidateRun) || "(branch unavailable)";
  const baseBranch = candidateRun.baseRef || batch.config.baseRef || batch.projectContext?.branchName || batch.projectContext?.headSha || "(base unavailable)";
  const originalTask = batch.config.prompt.trim() || "(task unavailable)";

  return [
    batch.config.reviewPrompt.trim(),
    "",
    "---",
    "",
    "You can find the work in the repository:",
    "",
    "```xml",
    "<review_info>",
    `<task_branch>${escapeXml(candidateBranch)}</task_branch>`,
    `<base_branch>${escapeXml(baseBranch)}</base_branch>`,
    `<candidate_run_id>${escapeXml(candidateRun.id)}</candidate_run_id>`,
    "</review_info>",
    "```",
    "",
    "Review the task branch against the base branch in the current repository before you score it.",
    "",
    "The task is to:",
    "````markdown",
    originalTask,
    "````",
  ].join("\n");
}

function buildReviewerDeveloperInstructions(reviewedRunId: string): string {
  return [
    "You must submit your score through MCP tool agents-runner-workflow.submit_score exactly once.",
    `- reviewed_run_id must be ${reviewedRunId}.`,
    "- working_folder must be the worktree root from `git rev-parse --show-toplevel`.",
    "- score must be between 0 and 100.",
    "- reason must be concise and specific.",
    "After calling submit_score, provide a brief human-readable summary.",
  ].join("\n");
}

function extractReviewerScoreFromMcp(reviewRun: Run): number | null {
  for (let turnIndex = reviewRun.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = reviewRun.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex] as Record<string, unknown>;
      if (item.type !== "mcp_tool_call") {
        continue;
      }

      if (String(item.server ?? "") !== "agents-runner-workflow" || String(item.tool ?? "") !== "submit_score") {
        continue;
      }

      if (String(item.status ?? "") !== "completed") {
        continue;
      }

      const result = item.result as Record<string, unknown> | undefined;
      const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
      const score = normalizeNumericScore(structured?.score);
      if (score !== null) {
        return score;
      }
    }
  }

  return null;
}

function recomputeRankedScores(store: BatchStore, batchId: string): void {
  const batch = store.getBatch(batchId);
  if (!batch || batch.mode !== "ranked") {
    return;
  }

  const reviewerRuns = batch.runs.filter((run) => run.kind === "reviewer");
  applyCandidateScores(store, batchId, reviewerRuns);
}

function applyCandidateScores(store: BatchStore, batchId: string, reviewRuns: Run[]): void {
  const scoreMap = new Map<string, number[]>();
  const reviewerScoreMap = new Map<string, number>();

  for (const reviewRun of reviewRuns) {
    const reviewedRunId = String(reviewRun.reviewedRunId ?? "").trim();
    if (!reviewedRunId) {
      continue;
    }

    const score = extractReviewerScoreFromMcp(reviewRun);
    if (score === null) {
      continue;
    }

    reviewerScoreMap.set(reviewRun.id, score);

    if (!scoreMap.has(reviewedRunId)) {
      scoreMap.set(reviewedRunId, []);
    }
    scoreMap.get(reviewedRunId)!.push(score);
  }

  const batch = store.getBatch(batchId);
  if (!batch || batch.mode !== "ranked") {
    return;
  }

  const candidateRuns = batch.runs.filter((run) => run.kind !== "reviewer");
  const candidateScoreMap = new Map<string, number | null>();
  const candidateRankMap = new Map<string, number | null>();

  for (const run of candidateRuns) {
    const values = scoreMap.get(run.id) || [];
    candidateScoreMap.set(
      run.id,
      values.length > 0
        ? Number((values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(2))
        : null,
    );
    candidateRankMap.set(run.id, null);
  }

  const rankedRuns = candidateRuns
    .filter((run) => candidateScoreMap.get(run.id) !== null)
    .sort((left, right) => Number(candidateScoreMap.get(right.id) ?? -1) - Number(candidateScoreMap.get(left.id) ?? -1));

  for (const [index, run] of rankedRuns.entries()) {
    candidateRankMap.set(run.id, index + 1);
  }

  for (const run of batch.runs) {
    if (run.kind === "reviewer") {
      const nextScore = reviewerScoreMap.get(run.id) ?? null;
      if ((run.score ?? null) === nextScore && (run.rank ?? null) === null) {
        continue;
      }

      store.updateRun(batchId, run.id, (mutableRun) => {
        mutableRun.score = nextScore;
        mutableRun.rank = null;
      });
      continue;
    }

    const nextScore = candidateScoreMap.get(run.id) ?? null;
    const nextRank = candidateRankMap.get(run.id) ?? null;
    if ((run.score ?? null) === nextScore && (run.rank ?? null) === nextRank) {
      continue;
    }

    store.updateRun(batchId, run.id, (mutableRun) => {
      mutableRun.score = nextScore;
      mutableRun.rank = nextRank;
    });
  }
}

function listReviewerRunsForCandidate(batch: Batch, candidateRunId: string): Run[] {
  return batch.runs
    .filter((run) => run.kind === "reviewer" && run.reviewedRunId === candidateRunId)
    .sort((left, right) => left.index - right.index);
}

function finalizeQueuedRun(
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

function cancelQueuedRuns(store: BatchStore, batchId: string, message: string): void {
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
  if (batch.cancelRequested && batch.runs.every((run) => isRunTerminalStatus(run.status))) {
    return "cancelled";
  }

  if (batch.runs.some((run) => run.status === "failed")) {
    return "failed";
  }

  if (batch.runs.length > 0 && batch.runs.every((run) => run.status === "completed")) {
    return "completed";
  }

  if (batch.runs.some((run) => isRunPendingStatus(run.status))) {
    return "running";
  }

  if (batch.cancelRequested) {
    return "cancelled";
  }

  return "queued";
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

function hasRunCompletionEvidence(run: Run): boolean {
  const latestTurn = getLatestRunTurn(run);
  if (latestTurn?.error) {
    return false;
  }

  if (extractReviewerScoreFromMcp(run) !== null) {
    return true;
  }

  if (latestTurn?.finalResponse || run.finalResponse) {
    return true;
  }

  return run.logs.some((entry) =>
    entry.message.startsWith("Turn completed.")
      || entry.message === "Run completed."
      || entry.message === "Follow-up turn completed.",
  );
}

function reconcileSettledBatchRuns(store: BatchStore, batchId: string): void {
  const batch = store.getBatch(batchId);
  if (!batch) {
    return;
  }

  const pendingRunIds = batch.runs
    .filter((run) => isRunPendingStatus(run.status))
    .map((run) => run.id);

  if (pendingRunIds.length === 0) {
    return;
  }

  for (const runId of pendingRunIds) {
    store.updateRun(batchId, runId, (run) => {
      const latestTurn = getLatestRunTurn(run);
      if (!latestTurn) {
        return;
      }

      if (!isRunPendingStatus(latestTurn.status)) {
        syncRunDerivedState(run);
        return;
      }

      latestTurn.completedAt ||= getRunTerminalTimestamp(run);

      if (batch.cancelRequested) {
        latestTurn.status = "cancelled";
        latestTurn.error ||= "Batch cancelled.";
      } else if (hasRunCompletionEvidence(run)) {
        latestTurn.status = "completed";
      } else {
        latestTurn.status = "failed";
        latestTurn.error ||= "Run ended without reaching a terminal state.";
      }

      syncRunDerivedState(run);
    });
  }

  if (batch.mode === "ranked") {
    recomputeRankedScores(store, batchId);
  }
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
      approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
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
          turn.usage = evt.usage as Run["usage"];
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
          if (completedItem.type === "error") {
            turn.error = completedItem.message as string;
          }

          if (
            completedItem.type === "mcp_tool_call"
            && String(completedItem.server ?? "") === "agents-runner-workflow"
            && String(completedItem.tool ?? "") === "submit_score"
            && String(completedItem.status ?? "") === "completed"
          ) {
            shouldRecomputeRankedScores = true;
          }

          appendLog(run, "info", describeItem(completedItem));
          break;
        }
        case "error":
          turn.status = "failed";
          turn.error = evt.message as string;
          appendLog(run, "error", turn.error);
          break;
        default:
          break;
      }

      syncRunDerivedState(run);
    });

    if (shouldRecomputeRankedScores) {
      recomputeRankedScores(store, batchId);
    }
  }
}

function releaseRunExecution(store: BatchStore, batchId: string, runId: string, execution: ExecutionState): void {
  execution.runControllers.delete(runId);

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.status = deriveBatchStatus(mutableBatch);
    mutableBatch.completedAt =
      mutableBatch.status === "running" || mutableBatch.status === "queued"
        ? null
        : nowIso();
  });

  maybeClearExecutionState(batchId, execution);
}

async function refreshRunReview(
  store: BatchStore,
  batchId: string,
  runId: string,
  worktreePath: string | null,
): Promise<void> {
  if (!worktreePath) {
    return;
  }

  const review = await collectWorktreeReview(worktreePath).catch(() => null);
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
  const review = await collectWorktreeReview(runSnapshot.worktreePath).catch(() => null);

  store.updateRun(batchId, runId, (run) => {
    run.review = review ?? {
      currentBranch: nextBranchName,
      headSha: run.review?.headSha ?? null,
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
  autoCreateBranch?: boolean;
  developerInstructions?: string;
}

async function executeRun(
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

  let worktreePath: string | null = null;

  store.updateRun(batchId, runId, (run) => {
    const turn = getRunTurn(run, initialTurnId);
    if (!turn) {
      return;
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
    const baseRef = batch.config.baseRef || projectContext.branchName || projectContext.headSha;
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

      turn.status = turn.error ? "failed" : "completed";
      turn.completedAt ||= nowIso();
      if (!turn.error) {
        appendLog(run, "info", "Run completed.");
      }
      syncRunDerivedState(run);
    });

    releaseRunExecution(store, batchId, runId, execution);
    void refreshRunReview(store, batchId, runId, worktreePath);
    return;
  } catch (error) {
    const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;

    store.updateRun(batchId, runId, (run) => {
      const turn = getRunTurn(run, initialTurnId);
      if (!turn) {
        return;
      }

      turn.status = cancelled ? "cancelled" : "failed";
      turn.completedAt = nowIso();
      turn.error = cancelled ? "Batch cancelled." : (error as Error).message;
      appendLog(run, cancelled ? "warning" : "error", turn.error);
      syncRunDerivedState(run);
    });
    releaseRunExecution(store, batchId, runId, execution);
    void refreshRunReview(store, batchId, runId, worktreePath);
    return;
  } finally {
    if (execution.runControllers.has(runId)) {
      releaseRunExecution(store, batchId, runId, execution);
    }
  }
}

async function executeReviewerRun(
  store: BatchStore,
  batchId: string,
  runId: string,
  projectContext: ProjectContext,
): Promise<void> {
  const batch = store.getMutableBatch(batchId);
  if (!batch || batch.cancelRequested) {
    finalizeQueuedRun(store, batchId, runId, "cancelled", "Batch cancelled before review start.");
    return;
  }

  const reviewRun = batch.runs.find((entry) => entry.id === runId);
  if (!reviewRun || reviewRun.kind !== "reviewer" || reviewRun.status !== "queued") {
    return;
  }

  const reviewedRun = batch.runs.find((entry) => entry.id === reviewRun.reviewedRunId);
  if (!reviewedRun) {
    finalizeQueuedRun(store, batchId, runId, "failed", "Reviewed run is unavailable.");
    return;
  }

  const reviewedWorkingDirectory = reviewedRun.workingDirectory || reviewedRun.worktreePath || null;
  const prompt = buildReviewPrompt(batch, reviewedRun);

  store.updateRun(batchId, runId, (run) => {
    run.prompt = prompt;
    const turn = run.turns[0];
    if (turn && turn.status === "queued") {
      turn.prompt = prompt;
    }
  });

  if (!reviewedWorkingDirectory) {
    finalizeQueuedRun(store, batchId, runId, "failed", "Reviewed run workspace is unavailable.");
    return;
  }

  await executeRun(store, batchId, runId, projectContext, {
    sandboxModeOverride: "read-only",
    workingDirectoryOverride: reviewedWorkingDirectory,
    promptOverride: prompt,
    developerInstructions: buildReviewerDeveloperInstructions(String(reviewRun.reviewedRunId ?? "")),
  });
}

function getRankedExecutionConcurrency(batch: Batch): number {
  return Math.max(
    1,
    Math.min(batch.config.concurrency, batch.config.runCount * Math.max(1, batch.config.reviewCount)),
  );
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

interface RankedScheduledTask {
  kind: "candidate" | "reviewer";
  runId: string;
}

async function executeRankedBatch(
  store: BatchStore,
  batchId: string,
  projectContext: ProjectContext,
  candidateRuns: Run[],
): Promise<void> {
  const rankedBatch = store.getBatch(batchId)!;
  const reviewTaskEntries = candidateRuns.flatMap((candidateRun) => buildReviewTasks(rankedBatch, candidateRun));

  for (const [index, task] of reviewTaskEntries.entries()) {
    const run = buildRunRecord(task, candidateRuns.length + index, "reviewer", task.reviewedRunId);
    store.appendRun(batchId, run);
  }

  const readyQueue: RankedScheduledTask[] = candidateRuns.map((run) => ({
    kind: "candidate",
    runId: run.id,
  }));
  const enqueuedReviewerRunIds = new Set<string>();
  const activeTasks = new Set<Promise<void>>();
  const concurrency = getRankedExecutionConcurrency(store.getBatch(batchId)!);

  function enqueueReviewerRuns(candidateRunId: string): void {
    const currentBatch = store.getBatch(batchId);
    if (!currentBatch || currentBatch.mode !== "ranked" || currentBatch.cancelRequested) {
      return;
    }

    const nextReviewerTasks: RankedScheduledTask[] = [];
    for (const reviewerRun of listReviewerRunsForCandidate(currentBatch, candidateRunId)) {
      if (reviewerRun.status !== "queued" || enqueuedReviewerRunIds.has(reviewerRun.id)) {
        continue;
      }

      nextReviewerTasks.push({
        kind: "reviewer",
        runId: reviewerRun.id,
      });
      enqueuedReviewerRunIds.add(reviewerRun.id);
    }

    if (nextReviewerTasks.length > 0) {
      readyQueue.unshift(...nextReviewerTasks);
    }
  }

  function launchTask(task: RankedScheduledTask): void {
    const promise = (async () => {
      if (task.kind === "candidate") {
        const mutableBatch = store.getMutableBatch(batchId);
        if (!mutableBatch || mutableBatch.cancelRequested) {
          finalizeQueuedRun(store, batchId, task.runId, "cancelled", "Batch cancelled before start.");
          return;
        }

        await executeRun(store, batchId, task.runId, projectContext, {
          autoCreateBranch: true,
        });
        enqueueReviewerRuns(task.runId);
        return;
      }

      await executeReviewerRun(store, batchId, task.runId, projectContext);
    })().finally(() => {
      activeTasks.delete(promise);
    });

    activeTasks.add(promise);
  }

  while (readyQueue.length > 0 || activeTasks.size > 0) {
    const mutableBatch = store.getMutableBatch(batchId);
    if (mutableBatch?.cancelRequested && readyQueue.length > 0) {
      while (readyQueue.length > 0) {
        const task = readyQueue.shift()!;
        finalizeQueuedRun(
          store,
          batchId,
          task.runId,
          "cancelled",
          task.kind === "reviewer" ? "Batch cancelled before review start." : "Batch cancelled before start.",
        );
      }
    }

    while (readyQueue.length > 0 && activeTasks.size < concurrency && !store.getMutableBatch(batchId)?.cancelRequested) {
      launchTask(readyQueue.shift()!);
    }

    if (activeTasks.size === 0) {
      break;
    }

    await Promise.race(activeTasks);
  }

  if (store.getMutableBatch(batchId)?.cancelRequested) {
    cancelQueuedRuns(store, batchId, "Batch cancelled before start.");
  }

  recomputeRankedScores(store, batchId);
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
      const run = buildRunRecord(task, index, "candidate");
      store.appendRun(batchId, run);
    }

    const latestBatch = store.getBatch(batchId)!;
    const candidateRuns = latestBatch.runs.filter((run) => run.kind !== "reviewer");
    if (latestBatch.mode === "ranked") {
      await executeRankedBatch(store, batchId, projectContext, candidateRuns);
    } else {
      await runWithConcurrency(candidateRuns, latestBatch.config.concurrency, async (run) => {
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

        await executeRun(store, batchId, run.id, projectContext, {
          autoCreateBranch: false,
        });
      });
    }

    reconcileSettledBatchRuns(store, batchId);
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

  if (runSnapshot.kind === "reviewer") {
    throw new Error("Reviewer runs are read-only and cannot be continued.");
  }

  if (!runSnapshot.threadId) {
    throw new Error("This run does not have a resumable Codex thread yet.");
  }

  if (!runSnapshot.workingDirectory) {
    throw new Error("This run does not have a working directory yet.");
  }

  const threadId = runSnapshot.threadId;
  const workingDirectory = runSnapshot.workingDirectory;
  const worktreePath = runSnapshot.worktreePath;

  const execution = getExecutionState(batchId);
  if (execution.runControllers.has(runId)) {
    throw new Error("This run is already active.");
  }

  const sessionConfig = {
    model: batch.config.model || undefined,
    sandboxMode: batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access",
    approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
    workingDirectory,
    networkAccessEnabled: batch.config.networkAccessEnabled,
    webSearchEnabled: batch.config.webSearchMode !== "disabled",
    webSearchMode: batch.config.webSearchMode as "disabled" | "live",
    modelReasoningEffort: (batch.config.reasoningEffort || undefined) as "low" | "medium" | "high" | undefined,
  };
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

        turn.status = turn.error ? "failed" : "completed";
        turn.completedAt ||= nowIso();
        if (!turn.error) {
          appendLog(run, "info", "Follow-up turn completed.");
        }
        syncRunDerivedState(run);
      });

      releaseRunExecution(store, batchId, runId, execution);
      void refreshRunReview(store, batchId, runId, worktreePath);
      return;
    } catch (error) {
      const cancelled = isAbortError(error) || store.getMutableBatch(batchId)?.cancelRequested;

      store.updateRun(batchId, runId, (run) => {
        const turn = getRunTurn(run, nextTurn.id);
        if (!turn) {
          return;
        }

        turn.status = cancelled ? "cancelled" : "failed";
        turn.completedAt = nowIso();
        turn.error = cancelled ? "Batch cancelled." : (error as Error).message;
        appendLog(run, cancelled ? "warning" : "error", turn.error);
        syncRunDerivedState(run);
      });

      releaseRunExecution(store, batchId, runId, execution);
      void refreshRunReview(store, batchId, runId, worktreePath);
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

  store.updateBatch(batchId, () => {});
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
