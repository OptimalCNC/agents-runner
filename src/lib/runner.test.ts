import { expect, test } from "bun:test";

import {
  buildCodexTurnConfig,
  continueRun,
  createRunId,
  reopenRunFollowUps,
  setCodexClientFactoryForTests,
  requestRunCommitFollowUp,
} from "./runner";
import { buildReviewPrompt } from "./workflows/ranked";
import { buildMockBatch, buildMockRun, buildMockStore } from "./workflows/test-helpers";
import type { Batch } from "../types";

async function* emptyEvents(): AsyncIterable<unknown> {
  return;
}

function installMockCodexClient(): void {
  setCodexClientFactoryForTests(() => ({
    startThread() {
      return {
        async run() {
          return { finalResponse: "{\"tasks\":[]}" };
        },
        async runStreamed() {
          return { events: emptyEvents() };
        },
      };
    },
    resumeThread() {
      return {
        async run() {
          return { finalResponse: "" };
        },
        async runStreamed() {
          return { events: emptyEvents() };
        },
      };
    },
  }));
}

function resetMockCodexClient(): void {
  setCodexClientFactoryForTests(null);
}

test("createRunId returns a stable run id derived from the run index", () => {
  const id = createRunId(0);

  expect(id).toBe("run-1");
});

test("createRunId increments with the run index", () => {
  expect(createRunId(1)).toBe("run-2");
  expect(createRunId(9)).toBe("run-10");
});

test("buildReviewPrompt keeps reviewer prompt focused on the scoring task", () => {
  const batch: Batch = {
    id: "batch-1",
    mode: "ranked",
    title: "Improve ranked mode",
    status: "queued",
    createdAt: "2026-03-16T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: 2,
      concurrency: 2,
      reviewCount: 3,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Implement ranked-mode scheduling updates.",
      taskPrompt: "",
      reviewPrompt: "Score the candidate carefully.",
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

  const prompt = buildReviewPrompt(batch);

  expect(prompt).toContain("Score the candidate carefully.");
  expect(prompt).toContain("The task is to:");
  expect(prompt).toContain("Implement ranked-mode scheduling updates.");
  expect(prompt).not.toContain("<review_info>");
  expect(prompt).not.toContain("<task_branch>");
  expect(prompt).not.toContain("<base_branch>");
  expect(prompt).not.toContain("The candidate agent's prompt was:");
  expect(prompt).not.toContain("Update ranked mode so reviewers can start early.");
});

test("buildCodexTurnConfig captures developer prompt and session settings", () => {
  const developerInstructions = [
    "Submit exactly one score with `agents-runner-workflow.submit_score`.",
    "",
    "<ranked_review_metadata>",
    "  <reviewed_run_id>run-1</reviewed_run_id>",
    "</ranked_review_metadata>",
  ].join("\n");

  const config = buildCodexTurnConfig({
    launchMode: "start",
    developerPrompt: developerInstructions,
    clientConfig: {
      developer_instructions: developerInstructions,
    },
    sessionConfig: {
      model: "gpt-5-codex",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workingDirectory: "/repo/worktrees/run-1/project",
      additionalDirectories: ["/repo/worktrees/run-1", "/repo/worktrees/run-2"],
      networkAccessEnabled: false,
      webSearchEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "high",
    },
  });

  expect(config.launchMode).toBe("start");
  expect(config.developerPrompt).toBe(developerInstructions);
  expect(config.clientConfig).toEqual({
    developer_instructions: developerInstructions,
  });
  expect(config.sessionConfig).toEqual({
    model: "gpt-5-codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    workingDirectory: "/repo/worktrees/run-1/project",
    additionalDirectories: ["/repo/worktrees/run-1", "/repo/worktrees/run-2"],
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "high",
  });
  expect(config.resumeThreadId).toBeNull();
});

test("continueRun rejects validated runs until follow-ups are reopened", async () => {
  const batch = buildMockBatch({ mode: "validated" });
  batch.status = "completed";
  const run = buildMockRun({ id: "run-1", kind: "candidate", status: "completed" });
  run.threadId = "thread-1";
  run.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [run];
  const store = buildMockStore(batch);

  await expect(continueRun(store, batch.id, run.id, "Follow up")).rejects.toThrow(
    "Follow-up turns are locked for this run until you enable them manually from the session view.",
  );
});

test("continueRun rejects ranked reviewer runs until follow-ups are reopened", async () => {
  const batch = buildMockBatch({ mode: "ranked" });
  batch.status = "completed";
  const reviewer = buildMockRun({ id: "review-1", kind: "reviewer", status: "completed" });
  reviewer.threadId = "thread-review";
  reviewer.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [reviewer];
  const store = buildMockStore(batch);

  await expect(continueRun(store, batch.id, reviewer.id, "Follow up")).rejects.toThrow(
    "Follow-up turns are locked for this run until you enable them manually from the session view.",
  );
});

test("reopenRunFollowUps persists the manual override on an eligible run", async () => {
  const batch = buildMockBatch({ mode: "validated" });
  batch.status = "completed";
  batch.completedAt = "2026-01-01T00:10:00.000Z";
  const run = buildMockRun({ id: "run-1", kind: "candidate", status: "completed" });
  run.threadId = "thread-1";
  run.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [run];
  const store = buildMockStore(batch);

  const updated = await reopenRunFollowUps(store, batch.id, run.id);

  expect(updated?.runs[0]?.followUpsReopened).toBe(true);
  expect(updated?.runs[0]?.followUpsReopenedAt).toBeTruthy();
  expect(updated?.runs[0]?.logs.at(-1)?.message).toBe("Manual follow-up turns enabled.");
});

test("reopenRunFollowUps rejects duplicate reopen requests", async () => {
  const batch = buildMockBatch({ mode: "validated" });
  batch.status = "completed";
  const run = buildMockRun({
    id: "run-1",
    kind: "candidate",
    status: "completed",
    followUpsReopened: true,
    followUpsReopenedAt: "2026-01-01T00:05:00.000Z",
  });
  run.threadId = "thread-1";
  run.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [run];
  const store = buildMockStore(batch);

  await expect(reopenRunFollowUps(store, batch.id, run.id)).rejects.toThrow(
    "Follow-up turns are already enabled for this run.",
  );
});

test("reopenRunFollowUps rejects runs in default-open modes", async () => {
  const batch = buildMockBatch({ mode: "repeated" });
  batch.status = "completed";
  const run = buildMockRun({ id: "run-1", status: "completed" });
  run.threadId = "thread-1";
  run.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [run];
  const store = buildMockStore(batch);

  await expect(reopenRunFollowUps(store, batch.id, run.id)).rejects.toThrow(
    "This run already accepts follow-up turns without reopening.",
  );
});

test("reopenRunFollowUps rejects runs before the batch settles", async () => {
  const batch = buildMockBatch({ mode: "ranked" });
  batch.status = "running";
  const run = buildMockRun({ id: "run-1", status: "completed" });
  run.threadId = "thread-1";
  run.workingDirectory = "/repo/worktrees/run-1/project";
  batch.runs = [run];
  const store = buildMockStore(batch);

  await expect(reopenRunFollowUps(store, batch.id, run.id)).rejects.toThrow(
    "Follow-up turns can be reopened only after the batch has finished.",
  );
});

test("reopenRunFollowUps rejects runs without a resumable thread", async () => {
  const batch = buildMockBatch({ mode: "ranked" });
  batch.status = "completed";
  const run = buildMockRun({ id: "run-1", status: "completed" });
  batch.runs = [run];
  const store = buildMockStore(batch);

  await expect(reopenRunFollowUps(store, batch.id, run.id)).rejects.toThrow(
    "This run does not have a resumable Codex thread yet.",
  );
});

test("continueRun resumes reopened reviewer runs with the previous read-only sandbox and directories", async () => {
  installMockCodexClient();
  try {
    const batch = buildMockBatch({ mode: "ranked" });
    batch.status = "completed";
    const reviewer = buildMockRun({
      id: "review-1",
      kind: "reviewer",
      status: "completed",
      followUpsReopened: true,
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
        codexConfig: buildCodexTurnConfig({
          launchMode: "start",
          sessionConfig: {
            model: "gpt-5-codex",
            sandboxMode: "read-only",
            approvalPolicy: "never",
            workingDirectory: "/repo/worktrees/review/project",
            additionalDirectories: ["/repo/worktrees/candidate-a", "/repo/worktrees/candidate-b"],
            networkAccessEnabled: false,
            webSearchEnabled: false,
            webSearchMode: "disabled",
            modelReasoningEffort: "high",
          },
        }),
        items: [],
      }],
    });
    reviewer.threadId = "thread-review";
    reviewer.workingDirectory = "/repo/worktrees/review/project";
    batch.runs = [reviewer];
    const store = buildMockStore(batch);

    const updated = await continueRun(store, batch.id, reviewer.id, "Inspect again");
    const nextTurn = updated?.runs[0]?.turns.at(-1);

    expect(nextTurn?.prompt).toBe("Inspect again");
    expect(nextTurn?.codexConfig?.sessionConfig.sandboxMode).toBe("read-only");
    expect(nextTurn?.codexConfig?.sessionConfig.workingDirectory).toBe("/repo/worktrees/review/project");
    expect(nextTurn?.codexConfig?.sessionConfig.additionalDirectories).toEqual([
      "/repo/worktrees/candidate-a",
      "/repo/worktrees/candidate-b",
    ]);
  } finally {
    resetMockCodexClient();
  }
});

test("continueRun resumes reopened validator runs", async () => {
  installMockCodexClient();
  try {
    const batch = buildMockBatch({ mode: "validated" });
    batch.status = "completed";
    const validator = buildMockRun({
      id: "run-2",
      index: 1,
      kind: "validator",
      status: "completed",
      followUpsReopened: true,
      turns: [{
        id: "turn-1",
        index: 0,
        prompt: "Validate.",
        status: "completed",
        submittedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:05.000Z",
        finalResponse: "done",
        error: null,
        usage: null,
        codexConfig: buildCodexTurnConfig({
          launchMode: "start",
          sessionConfig: {
            model: "gpt-5-codex",
            sandboxMode: "read-only",
            approvalPolicy: "never",
            workingDirectory: "/repo/project",
            additionalDirectories: ["/repo/worktrees/worker-1", "/repo/worktrees/worker-2"],
            networkAccessEnabled: false,
            webSearchEnabled: false,
            webSearchMode: "disabled",
            modelReasoningEffort: "medium",
          },
        }),
        items: [],
      }],
    });
    validator.threadId = "thread-validator";
    validator.workingDirectory = "/repo/project";
    batch.runs = [validator];
    const store = buildMockStore(batch);

    const updated = await continueRun(store, batch.id, validator.id, "Double-check the verdict");
    const nextTurn = updated?.runs[0]?.turns.at(-1);

    expect(nextTurn?.prompt).toBe("Double-check the verdict");
    expect(nextTurn?.codexConfig?.sessionConfig.sandboxMode).toBe("read-only");
    expect(nextTurn?.codexConfig?.sessionConfig.additionalDirectories).toEqual([
      "/repo/worktrees/worker-1",
      "/repo/worktrees/worker-2",
    ]);
  } finally {
    resetMockCodexClient();
  }
});

test("requestRunCommitFollowUp rejects validated runs before the validator finishes", async () => {
  const batch = buildMockBatch({ mode: "validated" });
  const workerRun = buildMockRun({ id: "run-1", kind: "candidate", status: "completed" });
  workerRun.threadId = "thread-1";
  workerRun.workingDirectory = "/repo/worktrees/run-1/project";
  const validatorRun = buildMockRun({ id: "run-2", index: 1, kind: "validator", status: "running" });
  batch.runs = [workerRun, validatorRun];
  const store = buildMockStore(batch);

  await expect(requestRunCommitFollowUp(store, batch.id, workerRun.id)).rejects.toThrow(
    "Validated worker runs can request a commit only after the validator run has finished.",
  );
});

test("requestRunCommitFollowUp still works for validated workers after the validator finishes", async () => {
  installMockCodexClient();
  try {
    const batch = buildMockBatch({ mode: "validated" });
    batch.status = "completed";
    const workerRun = buildMockRun({ id: "run-1", kind: "candidate", status: "completed" });
    workerRun.threadId = "thread-1";
    workerRun.workingDirectory = "/repo/worktrees/run-1/project";
    const validatorRun = buildMockRun({ id: "run-2", index: 1, kind: "validator", status: "completed" });
    batch.runs = [workerRun, validatorRun];
    const store = buildMockStore(batch);

    const updated = await requestRunCommitFollowUp(store, batch.id, workerRun.id);
    const nextTurn = updated?.runs[0]?.turns.at(-1);

    expect(nextTurn?.prompt).toContain("create exactly one commit");
  } finally {
    resetMockCodexClient();
  }
});
