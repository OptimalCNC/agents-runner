import { getBundledMcpStatus } from "../codexMcp";
import { buildRunRecord, cancelQueuedRuns, executeRun, finalizeQueuedRun, getRunCreatedBranchName } from "../runner";
import type { Batch, BatchStore, GenerationTask, ProjectContext, Run } from "../../types";
import { extractReviewerScoreFromMcp } from "./shared";
import type { ExecuteRunFn, WorkflowDefinition } from "./types";

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function buildReviewRunTitle(candidateRun: Run, reviewIndex: number): string {
  return `Review ${reviewIndex + 1} for ${candidateRun.title}`;
}

export function buildReviewTasks(batch: Batch, candidateRun: Run): Array<GenerationTask & { reviewedRunId: string }> {
  return Array.from({ length: batch.config.reviewCount }, (_, reviewIndex) => ({
    title: buildReviewRunTitle(candidateRun, reviewIndex),
    prompt: buildReviewPrompt(batch),
    reviewedRunId: candidateRun.id,
  }));
}

export function buildReviewPrompt(batch: Batch): string {
  const originalTask = batch.config.prompt.trim() || "(task unavailable)";

  return [
    batch.config.reviewPrompt.trim(),
    "",
    "The task is to:",
    "````markdown",
    originalTask,
    "````",
  ].join("\n");
}

export function buildReviewerDeveloperInstructions(batch: Batch, candidateRun: Run, reviewedRunId: string): string {
  const candidateBranch = getRunCreatedBranchName(candidateRun) || "(branch unavailable)";
  const baseBranch = candidateRun.baseRef || batch.config.baseRef || batch.projectContext?.branchName || batch.projectContext?.headSha || "(base unavailable)";

  return [
    "Review the task branch against the base branch from the metadata below before scoring.",
    "Submit exactly one score with `agents-runner-workflow.submit_score` instead of reporting the score only in plain text.",
    "Use the worktree root from `git rev-parse --show-toplevel` as `working_folder`. Keep the score between 0 and 100, and keep the reason concise and specific.",
    "",
    "<ranked_review_metadata>",
    `  <reviewed_run_id>${escapeXml(reviewedRunId)}</reviewed_run_id>`,
    `  <task_branch>${escapeXml(candidateBranch)}</task_branch>`,
    `  <base_branch>${escapeXml(baseBranch)}</base_branch>`,
    "</ranked_review_metadata>",
  ].join("\n");
}

export function applyCandidateScores(store: BatchStore, batchId: string, reviewRuns: Run[]): void {
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

function recomputeRankedScores(store: BatchStore, batchId: string): void {
  const batch = store.getBatch(batchId);
  if (!batch || batch.mode !== "ranked") {
    return;
  }

  const reviewerRuns = batch.runs.filter((run) => run.kind === "reviewer");
  applyCandidateScores(store, batchId, reviewerRuns);
}

function listReviewerRunsForCandidate(batch: Batch, candidateRunId: string): Run[] {
  return batch.runs
    .filter((run) => run.kind === "reviewer" && run.reviewedRunId === candidateRunId)
    .sort((left, right) => left.index - right.index);
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
  const prompt = buildReviewPrompt(batch);

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
    developerInstructions: buildReviewerDeveloperInstructions(batch, reviewedRun, String(reviewRun.reviewedRunId ?? "")),
  });
}

function getRankedExecutionConcurrency(batch: Batch): number {
  return Math.max(
    1,
    Math.min(batch.config.concurrency, batch.config.runCount * Math.max(1, batch.config.reviewCount)),
  );
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

export const rankedWorkflow: WorkflowDefinition = {
  mode: "ranked",
  label: "Ranked",

  validatePayload({ prompt, reviewPrompt }) {
    if (!prompt) {
      throw new Error("Prompt is required for Ranked mode.");
    }
    if (!reviewPrompt) {
      throw new Error("Review prompt is required for Ranked mode.");
    }
  },

  getMaxConcurrency(runCount, reviewCount) {
    return Math.max(1, runCount * Math.max(1, reviewCount));
  },

  buildInitialBatchState() {
    return { generation: null };
  },

  getTitleSourcePrompt(batch: Batch) {
    return batch.config.prompt;
  },

  async createTasks(store: BatchStore, batchId: string): Promise<GenerationTask[]> {
    const batch = store.getBatch(batchId)!;
    return Array.from({ length: batch.config.runCount }, (_, index) => ({
      title: `Run ${index + 1}`,
      prompt: batch.config.prompt,
    }));
  },

  async executeBatchRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
  ): Promise<void> {
    await executeRankedBatch(store, batchId, projectContext, candidateRuns);
  },

  onScoreSubmitted(store: BatchStore, batchId: string) {
    recomputeRankedScores(store, batchId);
  },

  onBatchSettled(store: BatchStore, batchId: string) {
    recomputeRankedScores(store, batchId);
  },

  async preCreateCheck(port: number) {
    const mcpStatus = await getBundledMcpStatus(port);
    if (!mcpStatus.healthy) {
      return {
        ok: false,
        error: "Ranked workflow requires bundled MCP tools. Open Settings and install/repair the Agents Runner MCP server first.",
      };
    }
    return { ok: true, error: "" };
  },
};
