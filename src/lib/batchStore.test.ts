import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { createBatchId, createBatchStore } from "./batchStore";

test("createBatchId returns a five-character lowercase base36 id", () => {
  const id = createBatchId(new Set());

  expect(id).toHaveLength(5);
  expect(id).toMatch(/^[a-z0-9]{5}$/);
});

test("createBatchId avoids ids already present in the provided set", () => {
  const ids = new Set<string>();

  for (let index = 0; index < 64; index += 1) {
    const id = createBatchId(ids);
    expect(ids.has(id)).toBe(false);
    ids.add(id);
  }

  expect(ids.size).toBe(64);
});

test("load normalizes stale ranked batches and recomputes average scores", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-runner-batchstore-"));
  const batchDir = path.join(root, "batches", "rank1");
  const runsDir = path.join(batchDir, "runs");
  await fs.mkdir(runsDir, { recursive: true });

  await fs.writeFile(path.join(batchDir, "batch.json"), `${JSON.stringify({
    id: "rank1",
    mode: "ranked",
    title: "Ranked batch",
    status: "completed",
    createdAt: "2026-03-16T00:00:00.000Z",
    startedAt: "2026-03-16T00:00:01.000Z",
    completedAt: "2026-03-16T00:01:00.000Z",
    cancelRequested: false,
    error: null,
    config: {
      runCount: 1,
      concurrency: 2,
      reviewCount: 2,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt: "Score it.",
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
    runIds: ["run-1", "run-2", "run-3"],
  }, null, 2)}\n`);

  const candidateRun = {
    id: "run-1",
    index: 0,
    title: "Run 1",
    prompt: "Do work.",
    status: "completed",
    startedAt: "2026-03-16T00:00:01.000Z",
    completedAt: "2026-03-16T00:00:20.000Z",
    threadId: "thread-1",
    worktreePath: "/repo/worktrees/run-1",
    workingDirectory: "/repo/worktrees/run-1/project",
    baseRef: "main",
    finalResponse: "done",
    error: null,
    usage: null,
    logs: [],
    turns: [
      {
        id: "turn-1",
        index: 0,
        prompt: "Do work.",
        status: "completed",
        submittedAt: "2026-03-16T00:00:01.000Z",
        startedAt: "2026-03-16T00:00:02.000Z",
        completedAt: "2026-03-16T00:00:20.000Z",
        finalResponse: "done",
        error: null,
        usage: null,
        items: [],
      },
    ],
    items: [],
    review: null,
    followUpsReopened: false,
    followUpsReopenedAt: null,
    kind: "candidate",
    score: null,
    rank: null,
    reviewedRunId: null,
  };

  const reviewerCompleted = {
    id: "run-2",
    index: 1,
    title: "Review 1",
    prompt: "Review.",
    status: "completed",
    startedAt: "2026-03-16T00:00:21.000Z",
    completedAt: "2026-03-16T00:00:30.000Z",
    threadId: "thread-2",
    worktreePath: null,
    workingDirectory: "/repo/worktrees/run-1",
    baseRef: "main",
    finalResponse: "submitted",
    error: null,
    usage: null,
    logs: [],
    turns: [
      {
        id: "turn-2",
        index: 0,
        prompt: "Review.",
        status: "completed",
        submittedAt: "2026-03-16T00:00:21.000Z",
        startedAt: "2026-03-16T00:00:22.000Z",
        completedAt: "2026-03-16T00:00:30.000Z",
        finalResponse: "submitted",
        error: null,
        usage: null,
        items: [
          {
            id: "item-1",
            type: "mcp_tool_call",
            server: "agents-runner-workflow",
            tool: "submit_score",
            status: "completed",
            result: {
              structured_content: {
                reviewedRunId: "run-1",
                score: 60,
                reason: "okay",
              },
            },
          },
        ],
      },
    ],
    items: [],
    review: null,
    followUpsReopened: false,
    followUpsReopenedAt: null,
    kind: "reviewer",
    score: 60,
    rank: null,
    reviewedRunId: "run-1",
  };

  const reviewerStale = {
    id: "run-3",
    index: 2,
    title: "Review 2",
    prompt: "Review.",
    status: "running",
    startedAt: "2026-03-16T00:00:31.000Z",
    completedAt: null,
    threadId: "thread-3",
    worktreePath: null,
    workingDirectory: "/repo/worktrees/run-1",
    baseRef: "main",
    finalResponse: "submitted",
    error: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
    },
    logs: [
      {
        id: "log-1",
        at: "2026-03-16T00:00:40.000Z",
        level: "info",
        message: "Turn completed. Tokens in/out: 100/20.",
      },
    ],
    turns: [
      {
        id: "turn-3",
        index: 0,
        prompt: "Review.",
        status: "running",
        submittedAt: "2026-03-16T00:00:31.000Z",
        startedAt: "2026-03-16T00:00:32.000Z",
        completedAt: null,
        finalResponse: "submitted",
        error: null,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
        },
        items: [
          {
            id: "item-1",
            type: "mcp_tool_call",
            server: "agents-runner-workflow",
            tool: "submit_score",
            status: "completed",
            result: {
              structured_content: {
                reviewedRunId: "run-1",
                score: 80,
                reason: "good",
              },
            },
          },
          {
            id: "item-2",
            type: "agent_message",
            text: "submitted",
          },
        ],
      },
    ],
    items: [],
    review: null,
    followUpsReopened: false,
    followUpsReopenedAt: null,
    kind: "reviewer",
    score: 80,
    rank: null,
    reviewedRunId: "run-1",
  };

  await fs.writeFile(path.join(runsDir, "run-1.json"), `${JSON.stringify(candidateRun, null, 2)}\n`);
  await fs.writeFile(path.join(runsDir, "run-2.json"), `${JSON.stringify(reviewerCompleted, null, 2)}\n`);
  await fs.writeFile(path.join(runsDir, "run-3.json"), `${JSON.stringify(reviewerStale, null, 2)}\n`);

  const store = createBatchStore(root);
  await store.load();

  const batch = store.getBatch("rank1");
  expect(batch).not.toBeNull();
  expect(batch!.status).toBe("completed");

  const loadedCandidate = batch!.runs.find((run) => run.id === "run-1");
  const loadedReviewer = batch!.runs.find((run) => run.id === "run-3");
  expect(loadedCandidate?.score).toBe(70);
  expect(loadedCandidate?.rank).toBe(1);
  expect(loadedReviewer?.status).toBe("completed");
  expect(loadedReviewer?.completedAt).toBeTruthy();

  const summary = store.listSummaries().find((entry) => entry.id === "rank1");
  expect(summary?.runningRuns).toBe(0);
  expect(summary?.completedRuns).toBe(3);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(root, { recursive: true, force: true });
});
