import { expect, test } from "bun:test";

import { buildMockBatch, buildMockStore } from "./test-helpers";
import { getWorkflow } from "./registry";

const wf = getWorkflow("repeated");

test("repeated workflow validates that prompt is required", () => {
  expect(() => wf.validatePayload({ prompt: "", taskPrompt: "", reviewPrompt: "" })).toThrow();
  expect(() => wf.validatePayload({ prompt: "Do work", taskPrompt: "", reviewPrompt: "" })).not.toThrow();
});

test("repeated workflow max concurrency equals runCount", () => {
  expect(wf.getMaxConcurrency(5, 3)).toBe(5);
  expect(wf.getMaxConcurrency(10, 1)).toBe(10);
});

test("repeated workflow has null generation state", () => {
  expect(wf.buildInitialBatchState().generation).toBeNull();
});

test("repeated workflow uses config.prompt for title", () => {
  const batch = buildMockBatch({ mode: "repeated", prompt: "Fix bugs", taskPrompt: "Gen tasks" });
  expect(wf.getTitleSourcePrompt(batch)).toBe("Fix bugs");
});

test("repeated workflow createTasks returns one task per runCount with prompt", async () => {
  const batch = buildMockBatch({ mode: "repeated", prompt: "Do work.", runCount: 3 });
  const store = buildMockStore(batch);
  const tasks = await wf.createTasks(store, batch.id, {
    projectPath: "/repo/project",
    repoRoot: "/repo",
    relativeProjectPath: "project",
    headSha: "abc123",
    branchName: "main",
  });
  expect(tasks).toHaveLength(3);
  for (const task of tasks) {
    expect(task.prompt).toBe("Do work.");
  }
  expect(tasks[0].title).toBe("Run 1");
  expect(tasks[1].title).toBe("Run 2");
  expect(tasks[2].title).toBe("Run 3");
});

test("repeated workflow hooks are no-ops and do not throw", () => {
  const store = buildMockStore();
  expect(() => wf.onScoreSubmitted(store, "b1")).not.toThrow();
  expect(() => wf.onBatchSettled(store, "b1")).not.toThrow();
});

test("repeated workflow has no preCreateCheck", () => {
  expect(wf.preCreateCheck).toBeUndefined();
});
