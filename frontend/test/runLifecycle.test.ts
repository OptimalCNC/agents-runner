import { expect, test } from "bun:test";

import type { Batch, Run } from "../src/types.js";
import { canResumeRun, canRerunRun, canStopRun } from "../src/utils/runLifecycle.js";

function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? "run-1",
    index: overrides.index ?? 0,
    title: overrides.title ?? "Run 1",
    prompt: overrides.prompt ?? "Do work.",
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? "2026-01-01T00:00:01.000Z",
    completedAt: overrides.completedAt ?? "2026-01-01T00:00:05.000Z",
    threadId: overrides.threadId !== undefined ? overrides.threadId : "thread-1",
    worktreePath: overrides.worktreePath ?? "/repo/worktrees/run-1",
    workingDirectory: overrides.workingDirectory !== undefined ? overrides.workingDirectory : "/repo/worktrees/run-1/project",
    baseRef: overrides.baseRef ?? "main",
    finalResponse: overrides.finalResponse ?? "",
    error: overrides.error ?? null,
    usage: overrides.usage ?? null,
    logs: overrides.logs ?? [],
    turns: overrides.turns ?? [],
    items: overrides.items ?? [],
    review: overrides.review ?? null,
    followUpsReopened: overrides.followUpsReopened ?? false,
    followUpsReopenedAt: overrides.followUpsReopenedAt ?? null,
    kind: overrides.kind ?? "candidate",
    score: overrides.score ?? null,
    rank: overrides.rank ?? null,
    reviewedRunId: overrides.reviewedRunId ?? null,
  };
}

function buildBatch(mode: Batch["mode"], status: Batch["status"] = "completed"): Batch {
  return {
    id: "batch-1",
    mode,
    title: "Batch",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: status === "completed" ? "2026-01-01T00:00:10.000Z" : null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: 1,
      concurrency: 1,
      reviewCount: 1,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt: "Review it.",
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
    generation: null,
    projectContext: undefined,
    runs: [],
  };
}

test("failed ranked runs expose stop, rerun, and resume when they are recoverable", () => {
  const batch = buildBatch("ranked", "blocked");
  const run = buildRun({ status: "failed" });

  expect(canStopRun(batch, run)).toBe(true);
  expect(canRerunRun(batch, run)).toBe(true);
  expect(canResumeRun(batch, run)).toBe(true);
});

test("failed ranked runs do not expose stop before the batch is actually blocked", () => {
  const batch = buildBatch("ranked", "running");
  const run = buildRun({ status: "failed" });

  expect(canStopRun(batch, run)).toBe(false);
  expect(canRerunRun(batch, run)).toBe(true);
  expect(canResumeRun(batch, run)).toBe(true);
});

test("failed repeated runs cannot be stopped individually but can still rerun or resume", () => {
  const batch = buildBatch("repeated", "failed");
  const run = buildRun({ status: "failed" });

  expect(canStopRun(batch, run)).toBe(false);
  expect(canRerunRun(batch, run)).toBe(true);
  expect(canResumeRun(batch, run)).toBe(true);
});

test("cancelled batches disable all lifecycle actions", () => {
  const batch = buildBatch("validated", "cancelled");
  batch.cancelRequested = true;
  const run = buildRun({ status: "failed" });

  expect(canStopRun(batch, run)).toBe(false);
  expect(canRerunRun(batch, run)).toBe(false);
  expect(canResumeRun(batch, run)).toBe(false);
});

test("resume requires an existing thread and working directory", () => {
  const batch = buildBatch("validated", "blocked");
  const missingThread = buildRun({ status: "failed", threadId: null });
  const missingDirectory = buildRun({ status: "failed", workingDirectory: null });

  expect(canResumeRun(batch, missingThread)).toBe(false);
  expect(canResumeRun(batch, missingDirectory)).toBe(false);
});
