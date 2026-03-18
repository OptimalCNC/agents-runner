import { expect, test } from "bun:test";

import {
  applyCandidateScores,
  buildReviewPrompt,
  buildReviewTasks,
  buildReviewerDeveloperInstructions,
} from "./ranked";
import {
  buildMockBatch,
  buildMockRankedBatchWithScores,
  buildMockReviewerRunWithScore,
  buildMockRun,
} from "./test-helpers";
import { getWorkflow } from "./registry";

const wf = getWorkflow("ranked");

// --- Validation ---

test("ranked workflow requires prompt", () => {
  expect(() => wf.validatePayload({ prompt: "", taskPrompt: "", reviewPrompt: "Score it" })).toThrow();
});

test("ranked workflow requires reviewPrompt", () => {
  expect(() => wf.validatePayload({ prompt: "Do work", taskPrompt: "", reviewPrompt: "" })).toThrow();
});

test("ranked workflow accepts both prompt and reviewPrompt", () => {
  expect(() => wf.validatePayload({ prompt: "Do work", taskPrompt: "", reviewPrompt: "Score it" })).not.toThrow();
});

// --- Concurrency ---

test("ranked workflow max concurrency is runCount * reviewCount", () => {
  expect(wf.getMaxConcurrency(3, 4)).toBe(12);
  expect(wf.getMaxConcurrency(2, 5)).toBe(10);
  expect(wf.getMaxConcurrency(1, 1)).toBe(1);
});

// --- Initial state ---

test("ranked workflow has null generation state", () => {
  expect(wf.buildInitialBatchState().generation).toBeNull();
});

// --- Title source ---

test("ranked workflow uses config.prompt for title", () => {
  const batch = buildMockBatch({ mode: "ranked", prompt: "Do work", taskPrompt: "Gen" });
  expect(wf.getTitleSourcePrompt(batch)).toBe("Do work");
});

// --- preCreateCheck ---

test("ranked workflow has preCreateCheck", () => {
  expect(typeof wf.preCreateCheck).toBe("function");
});

// --- buildReviewPrompt ---

test("buildReviewPrompt includes the reviewPrompt and original task", () => {
  const batch = buildMockBatch({
    mode: "ranked",
    prompt: "Implement feature X",
    reviewPrompt: "Score the quality",
  });
  const result = buildReviewPrompt(batch);
  expect(result).toContain("Score the quality");
  expect(result).toContain("The task is to:");
  expect(result).toContain("Implement feature X");
});

test("buildReviewPrompt does not include reviewer metadata or branch info", () => {
  const batch = buildMockBatch({ mode: "ranked", prompt: "Do work" });
  const result = buildReviewPrompt(batch);
  expect(result).not.toContain("<task_branch>");
  expect(result).not.toContain("<base_branch>");
  expect(result).not.toContain("<ranked_review_metadata>");
});

// --- buildReviewerDeveloperInstructions ---

test("buildReviewerDeveloperInstructions includes submit_score instruction", () => {
  const batch = buildMockBatch({ mode: "ranked" });
  const candidateRun = buildMockRun({ id: "r1", review: { currentBranch: "batch/b1/r1" } });
  const instructions = buildReviewerDeveloperInstructions(batch, candidateRun, "r1");
  expect(instructions).toContain("submit_score");
  expect(instructions).toContain("r1");
  expect(instructions).toContain("batch/b1/r1");
});

// --- buildReviewTasks ---

test("buildReviewTasks creates reviewCount tasks per candidate", () => {
  const batch = buildMockBatch({ mode: "ranked", reviewCount: 3 });
  const candidateRun = buildMockRun({ id: "c1", title: "Run 1" } as Parameters<typeof buildMockRun>[0]);
  candidateRun.title = "Run 1";
  const tasks = buildReviewTasks(batch, candidateRun);
  expect(tasks).toHaveLength(3);
  for (const task of tasks) {
    expect(task.reviewedRunId).toBe("c1");
  }
});

// --- applyCandidateScores ---

test("applyCandidateScores computes averages and assigns ranks correctly", () => {
  const { store, batchId } = buildMockRankedBatchWithScores([
    { candidateId: "a", reviewerScores: [80, 90] },
    { candidateId: "b", reviewerScores: [60, 70] },
  ]);

  const batch = store.getBatch(batchId)!;
  const reviewerRuns = batch.runs.filter((r) => r.kind === "reviewer");
  applyCandidateScores(store, batchId, reviewerRuns);

  const updatedBatch = store.getBatch(batchId)!;
  const candidateA = updatedBatch.runs.find((r) => r.id === "a")!;
  const candidateB = updatedBatch.runs.find((r) => r.id === "b")!;

  expect(candidateA.score).toBe(85);
  expect(candidateA.rank).toBe(1);
  expect(candidateB.score).toBe(65);
  expect(candidateB.rank).toBe(2);
});

test("applyCandidateScores sets null score and rank when no reviewer scores exist", () => {
  const { store, batchId } = buildMockRankedBatchWithScores([
    { candidateId: "a", reviewerScores: [] },
  ]);

  const batch = store.getBatch(batchId)!;
  const reviewerRuns = batch.runs.filter((r) => r.kind === "reviewer");
  applyCandidateScores(store, batchId, reviewerRuns);

  const updatedBatch = store.getBatch(batchId)!;
  const candidateA = updatedBatch.runs.find((r) => r.id === "a")!;
  expect(candidateA.score).toBeNull();
  expect(candidateA.rank).toBeNull();
});

// --- onScoreSubmitted / onBatchSettled call recomputeRankedScores ---

test("onScoreSubmitted triggers recomputeRankedScores for ranked batches", () => {
  const reviewRun = buildMockReviewerRunWithScore(75);
  reviewRun.id = "review-1";
  reviewRun.reviewedRunId = "candidate-1";

  const candidateRun = buildMockRun({ id: "candidate-1", kind: "candidate" });

  const batch = buildMockBatch({ mode: "ranked" });
  batch.runs = [candidateRun, reviewRun];

  const store = require("./test-helpers").buildMockStore(batch);

  wf.onScoreSubmitted(store, batch.id);

  const updated = store.getBatch(batch.id)!;
  const candidate = updated.runs.find((r: { id: string }) => r.id === "candidate-1");
  expect(candidate?.score).toBe(75);
});
