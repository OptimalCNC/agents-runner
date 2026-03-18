import { expect, test } from "bun:test";

import { buildCodexTurnConfig, createRunId } from "./runner";
import { buildReviewPrompt } from "./workflows/ranked";
import type { Batch } from "../types";

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
    networkAccessEnabled: false,
    webSearchEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "high",
  });
  expect(config.resumeThreadId).toBeNull();
});
