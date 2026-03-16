import { expect, test } from "bun:test";

import { buildCodexTurnConfig, createRunId, buildReviewPrompt } from "./runner";
import type { Batch, Run } from "../types";

test("createRunId returns a stable run id derived from the run index", () => {
  const id = createRunId(0);

  expect(id).toBe("run-1");
});

test("createRunId increments with the run index", () => {
  expect(createRunId(1)).toBe("run-2");
  expect(createRunId(9)).toBe("run-10");
});

test("buildReviewPrompt includes XML metadata and the candidate prompt", () => {
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

  const candidateRun: Run = {
    id: "run-1",
    index: 0,
    title: "Run 1",
    prompt: "Update ranked mode so reviewers can start early.",
    status: "completed",
    startedAt: "2026-03-16T00:00:00.000Z",
    completedAt: "2026-03-16T00:10:00.000Z",
    threadId: "thread-1",
    worktreePath: "/repo/worktrees/run-1",
    workingDirectory: "/repo/worktrees/run-1/project",
    baseRef: "main",
    finalResponse: "",
    error: null,
    usage: null,
    logs: [
      {
        id: "log-1",
        at: "2026-03-16T00:05:00.000Z",
        level: "info",
        message: "Created branch batch/batch-1/run-1.",
      },
    ],
    turns: [],
    items: [],
    review: null,
    kind: "candidate",
    score: null,
    rank: null,
    reviewedRunId: null,
  };

  const prompt = buildReviewPrompt(batch, candidateRun);

  expect(prompt).toContain("<review_info>");
  expect(prompt).toContain("<task_branch>batch/batch-1/run-1</task_branch>");
  expect(prompt).toContain("<base_branch>main</base_branch>");
  expect(prompt).toContain("The task is to:");
  expect(prompt).toContain("Implement ranked-mode scheduling updates.");
  expect(prompt).not.toContain("The candidate agent's prompt was:");
  expect(prompt).not.toContain("Update ranked mode so reviewers can start early.");
});

test("buildCodexTurnConfig captures developer prompt and session settings", () => {
  const config = buildCodexTurnConfig({
    launchMode: "start",
    developerPrompt: "Follow the managed branch workflow.",
    clientConfig: {
      developer_instructions: "Follow the managed branch workflow.",
    },
    sessionConfig: {
      model: "gpt-5-codex",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workingDirectory: "/repo/worktrees/run-1/project",
      networkAccessEnabled: false,
      webSearchEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "high",
    },
  });

  expect(config.launchMode).toBe("start");
  expect(config.developerPrompt).toBe("Follow the managed branch workflow.");
  expect(config.clientConfig).toEqual({
    developer_instructions: "Follow the managed branch workflow.",
  });
  expect(config.sessionConfig).toEqual({
    model: "gpt-5-codex",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    workingDirectory: "/repo/worktrees/run-1/project",
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "high",
  });
  expect(config.resumeThreadId).toBeNull();
});
