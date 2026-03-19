import { expect, test } from "bun:test";

import { validatedWorkflow } from "./validated.js";
import type { Batch, Run } from "../types.js";

function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? "run-1",
    index: overrides.index ?? 0,
    title: overrides.title ?? "Run 1",
    prompt: overrides.prompt ?? "Do work.",
    status: overrides.status ?? "queued",
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    threadId: overrides.threadId ?? null,
    worktreePath: overrides.worktreePath ?? null,
    workingDirectory: overrides.workingDirectory ?? null,
    baseRef: overrides.baseRef ?? null,
    finalResponse: overrides.finalResponse ?? "",
    error: overrides.error ?? null,
    usage: overrides.usage ?? null,
    logs: overrides.logs ?? [],
    turns: overrides.turns ?? [],
    items: overrides.items ?? [],
    review: overrides.review ?? null,
    kind: overrides.kind ?? "candidate",
    score: overrides.score ?? null,
    rank: overrides.rank ?? null,
    reviewedRunId: overrides.reviewedRunId ?? null,
  };
}

function buildBatch(runs: Run[]): Batch {
  return {
    id: "batch-1",
    mode: "validated",
    title: "Validated Batch",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: 2,
      concurrency: 2,
      reviewCount: 1,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt: "Check it.",
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
    generation: null,
    runs,
  };
}

test("validated workflow requires prompt and checker prompt in the form", () => {
  expect(validatedWorkflow.canSubmit({ prompt: "", taskPrompt: "", reviewPrompt: "Check it." })).toBe(false);
  expect(validatedWorkflow.canSubmit({ prompt: "Do work", taskPrompt: "", reviewPrompt: "" })).toBe(false);
  expect(validatedWorkflow.canSubmit({ prompt: "Do work", taskPrompt: "", reviewPrompt: "Check it." })).toBe(true);
});

test("validated workflow summary label reflects workers and validator", () => {
  const batch = buildBatch([]);
  expect(validatedWorkflow.buildRunsSummaryLabel(batch)).toBe("2 workers · 1 validator");
});

test("validated workflow keeps sessions read-only and hides review tab for validator runs", () => {
  expect(validatedWorkflow.isSessionReadOnly).toBe(true);
  expect(validatedWorkflow.showReviewTab(buildRun({ kind: "candidate" }))).toBe(true);
  expect(validatedWorkflow.showReviewTab(buildRun({ kind: "validator" }))).toBe(false);
});

test("validated workflow tags validator cards", () => {
  expect(validatedWorkflow.getRunCardExtras(buildRun({ kind: "candidate" }))).toBeNull();
  expect(validatedWorkflow.getRunCardExtras(buildRun({ kind: "validator" }))).toEqual({
    tags: [{ label: "Validator" }],
  });
});
