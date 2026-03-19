import type { Batch, BatchMode, BatchStore, Run, RunTurn, SubmitResultToolFile } from "../../types";

export function buildMockBatch(overrides: {
  mode?: BatchMode;
  prompt?: string;
  taskPrompt?: string;
  reviewPrompt?: string;
  runCount?: number;
  reviewCount?: number;
}): Batch {
  return {
    id: "batch-test",
    mode: overrides.mode ?? "repeated",
    title: "Test Batch",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: overrides.runCount ?? 2,
      concurrency: 2,
      reviewCount: overrides.reviewCount ?? 2,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: overrides.prompt ?? "Do work.",
      taskPrompt: overrides.taskPrompt ?? "Generate tasks.",
      reviewPrompt: overrides.reviewPrompt ?? "Score it.",
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
    generation: null,
    projectContext: {
      projectPath: "/repo/project",
      repoRoot: "/repo",
      relativeProjectPath: "project",
      headSha: "abc123",
      branchName: "main",
    },
    runs: [],
  };
}

export function buildMockRun(overrides: {
  id?: string;
  index?: number;
  kind?: "candidate" | "reviewer" | "validator";
  reviewedRunId?: string | null;
  score?: number | null;
  rank?: number | null;
  status?: string;
  review?: { currentBranch: string | null } | null;
  turns?: RunTurn[];
}): Run {
  return {
    id: overrides.id ?? "run-1",
    index: overrides.index ?? 0,
    title: "Run 1",
    prompt: "Do work.",
    status: (overrides.status ?? "queued") as Run["status"],
    startedAt: null,
    completedAt: null,
    threadId: null,
    worktreePath: null,
    workingDirectory: null,
    baseRef: null,
    finalResponse: "",
    error: null,
    usage: null,
    logs: overrides.review?.currentBranch
      ? [{ id: "log-1", at: "2026-01-01T00:00:00Z", level: "info", message: `Created branch ${overrides.review.currentBranch}.` }]
      : [],
    turns: overrides.turns ?? [{
      id: "turn-1",
      index: 0,
      prompt: "Do work.",
      status: "queued",
      submittedAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      finalResponse: "",
      error: null,
      usage: null,
      codexConfig: null,
      items: [],
    }],
    items: [],
    review: overrides.review ? {
      currentBranch: overrides.review.currentBranch,
      headSha: null,
      comparisonBaseRef: null,
      statusShort: "",
      diffStat: "",
      trackedDiff: "",
      untrackedFiles: [],
    } : null,
    kind: overrides.kind ?? "candidate",
    score: overrides.score ?? null,
    rank: overrides.rank ?? null,
    reviewedRunId: overrides.reviewedRunId ?? null,
  };
}

export function buildMockReviewerRunWithScore(score: number): Run {
  return buildMockRun({
    id: "review-1",
    kind: "reviewer",
    reviewedRunId: "run-1",
    turns: [{
      id: "turn-1",
      index: 0,
      prompt: "Review.",
      status: "completed",
      submittedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      finalResponse: "done",
      error: null,
      usage: null,
      codexConfig: null,
      items: [{
        id: "item-1",
        type: "mcp_tool_call",
        server: "agents-runner-workflow",
        tool: "submit_score",
        status: "completed",
        result: {
          structured_content: {
            reviewedRunId: "run-1",
            score,
            reason: "good",
          },
        },
      }],
    }],
  });
}

export function buildMockReviewerRunWithoutScore(): Run {
  return buildMockRun({
    id: "review-no-score",
    kind: "reviewer",
    reviewedRunId: "run-1",
    turns: [{
      id: "turn-1",
      index: 0,
      prompt: "Review.",
      status: "completed",
      submittedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      finalResponse: "done",
      error: null,
      usage: null,
      codexConfig: null,
      items: [],
    }],
  });
}

export function buildMockWorkerRunWithSubmission(files: SubmitResultToolFile[]): Run {
  return buildMockRun({
    id: "run-1",
    kind: "candidate",
    turns: [{
      id: "turn-1",
      index: 0,
      prompt: "Do work.",
      status: "completed",
      submittedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      finalResponse: "done",
      error: null,
      usage: null,
      codexConfig: null,
      items: [{
        id: "item-1",
        type: "mcp_tool_call",
        server: "agents-runner-workflow",
        tool: "submit_result",
        status: "completed",
        result: {
          structured_content: {
            workingFolder: "/repo/worktrees/run-1",
            runId: "run-1",
            files,
          },
        },
      }],
    }],
  });
}

export function buildMockStore(initialBatch?: Batch): BatchStore {
  const batches = new Map<string, Batch>();
  if (initialBatch) {
    batches.set(initialBatch.id, JSON.parse(JSON.stringify(initialBatch)));
  }

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  return {
    async load() {},
    listSummaries() { return []; },
    getBatch(id) {
      const b = batches.get(id);
      return b ? clone(b) : null;
    },
    getMutableBatch(id) {
      return batches.get(id) ?? null;
    },
    createBatch({ mode, title, config }) {
      const batch: Batch = {
        id: "batch-test",
        mode,
        title,
        status: "queued",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        cancelRequested: false,
        error: null,
        config,
        generation: null,
        runs: [],
      };
      batches.set(batch.id, batch);
      return clone(batch);
    },
    updateBatch(id, updater) {
      const b = batches.get(id);
      if (!b) return null;
      updater(b);
      return clone(b);
    },
    appendRun(id, run) {
      const b = batches.get(id);
      if (!b) return null;
      b.runs.push(run);
      return clone(b);
    },
    updateRun(id, runId, updater) {
      const b = batches.get(id);
      if (!b) return null;
      const run = b.runs.find(r => r.id === runId);
      if (run) updater(run, b);
      return clone(b);
    },
    async deleteBatch(id) {
      const b = batches.get(id);
      if (!b) return null;
      batches.delete(id);
      return clone(b);
    },
    subscribe() { return () => {}; },
  };
}

export function buildMockRankedBatchWithScores(
  entries: Array<{ candidateId: string; reviewerScores: number[] }>,
): { store: BatchStore; batchId: string } {
  const batchId = "batch-ranked";
  const runs: Run[] = [];
  let runIndex = 0;

  // Create candidate runs
  for (const entry of entries) {
    runs.push(buildMockRun({
      id: entry.candidateId,
      index: runIndex++,
      kind: "candidate",
    }));
  }

  // Create reviewer runs with scores
  for (const entry of entries) {
    for (const score of entry.reviewerScores) {
      const reviewId = `review-${entry.candidateId}-${runIndex}`;
      runs.push({
        ...buildMockReviewerRunWithScore(score),
        id: reviewId,
        index: runIndex++,
        reviewedRunId: entry.candidateId,
      });
    }
  }

  const batch = buildMockBatch({ mode: "ranked" });
  batch.id = batchId;
  batch.runs = runs;

  return { store: buildMockStore(batch), batchId };
}
