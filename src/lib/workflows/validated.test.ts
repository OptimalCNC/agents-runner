import { expect, test } from "bun:test";

import {
  buildValidatorPrompt,
  collectValidatorDirectories,
} from "./validatedPrompt";
import { buildMockBatch, buildMockRun, buildMockStore } from "./test-helpers";
import { getWorkflow } from "./registry";

const wf = getWorkflow("validated");

test("validated workflow requires prompt", () => {
  expect(() => wf.validatePayload({ prompt: "", taskPrompt: "", reviewPrompt: "Check it." })).toThrow();
});

test("validated workflow requires checker prompt", () => {
  expect(() => wf.validatePayload({ prompt: "Do work", taskPrompt: "", reviewPrompt: "" })).toThrow();
});

test("validated workflow max concurrency matches worker count", () => {
  expect(wf.getMaxConcurrency(4, 9)).toBe(4);
});

test("validated workflow uses prompt for title generation", () => {
  const batch = buildMockBatch({ mode: "validated", prompt: "Fix bugs" });
  expect(wf.getTitleSourcePrompt(batch)).toBe("Fix bugs");
});

test("validated workflow has preCreateCheck", () => {
  expect(typeof wf.preCreateCheck).toBe("function");
});

test("validated workflow creates worker tasks", async () => {
  const batch = buildMockBatch({ mode: "validated", runCount: 3, prompt: "Do work" });
  const store = buildMockStore(batch);

  const tasks = await wf.createTasks(store, batch.id, batch.projectContext!);

  expect(tasks.map((task) => task.title)).toEqual(["Worker 1", "Worker 2", "Worker 3"]);
  expect(tasks.every((task) => task.prompt === "Do work")).toBe(true);
});

test("buildValidatorPrompt composes checker prompt, worker XML, and original task in order", () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the feature.",
    reviewPrompt: "Validate the workers carefully.",
  });
  const worker = buildMockRun({
    id: "run-1",
    index: 0,
    kind: "candidate",
    status: "completed",
  });
  worker.title = "Worker 1";
  worker.worktreePath = "/repo/worktrees/run-1";
  worker.workingDirectory = "/repo/worktrees/run-1/project";
  worker.finalResponse = "Implemented the <feature> & wrote tests.";
  worker.error = `saw "warning"`;
  worker.turns[0]!.items = [{
    id: "item-1",
    type: "mcp_tool_call",
    server: "agents-runner-workflow",
    tool: "submit_result",
    status: "completed",
    result: {
      structured_content: {
        workingFolder: "/repo/worktrees/run-1",
        runId: "run-1",
        files: [
          {
            path: "project/src/index.ts",
            explanation: "Primary implementation entry point.",
          },
        ],
      },
    },
  }];

  const prompt = buildValidatorPrompt(batch, [worker]);
  const checkerPromptIndex = prompt.indexOf("Validate the workers carefully.");
  const workersIndex = prompt.indexOf("```xml");
  const originalTaskIndex = prompt.indexOf("Original Tasks:");

  expect(prompt).toContain("Validate the workers carefully.");
  expect(prompt).toContain("```xml");
  expect(prompt).toContain("<workers>");
  expect(prompt).toContain(`<worker id="run-1" title="Worker 1" status="completed">`);
  expect(prompt).toContain("<workingDirectory>/repo/worktrees/run-1/project</workingDirectory>");
  expect(prompt).toContain('<submittedFiles status="submitted">');
  expect(prompt).toContain('<file path="/repo/worktrees/run-1/project/src/index.ts">');
  expect(prompt).toContain("<explanation>Primary implementation entry point.</explanation>");
  expect(prompt).toContain("<error>saw &quot;warning&quot;</error>");
  expect(prompt).toContain("<finalResponse>Implemented the &lt;feature&gt; &amp; wrote tests.</finalResponse>");
  expect(prompt).toContain("</workers>");
  expect(prompt).toContain("```");
  expect(prompt).toContain("Original Tasks:");
  expect(prompt).toContain("Implement the feature.");
  expect(prompt).not.toContain("<worktreePath>");
  expect(checkerPromptIndex).toBeLessThan(workersIndex);
  expect(workersIndex).toBeLessThan(originalTaskIndex);
});

test("collectValidatorDirectories dedupes worker worktree roots", () => {
  const first = buildMockRun({ id: "run-1", kind: "candidate" });
  first.worktreePath = "/repo/worktrees/shared";
  const second = buildMockRun({ id: "run-2", index: 1, kind: "candidate" });
  second.worktreePath = "/repo/worktrees/shared";
  const third = buildMockRun({ id: "run-3", index: 2, kind: "candidate" });
  third.worktreePath = "/repo/worktrees/unique";

  expect(collectValidatorDirectories([first, second, third])).toEqual([
    "/repo/worktrees/shared",
    "/repo/worktrees/unique",
  ]);
});

test("validated workflow launches validator after workers finish with expected overrides", async () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 2,
  });
  const workerA = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "queued" });
  workerA.title = "Worker 1";
  const workerB = buildMockRun({ id: "run-2", index: 1, kind: "candidate", status: "queued" });
  workerB.title = "Worker 2";
  batch.runs = [workerA, workerB];
  const store = buildMockStore(batch);
  const calls: Array<{
    runId: string;
    options?: {
      promptOverride?: string;
      sandboxModeOverride?: string;
      workingDirectoryOverride?: string;
      additionalDirectoriesOverride?: string[];
      autoCreateBranch?: boolean;
      developerInstructions?: string;
    };
  }> = [];

  await wf.executeBatchRuns(store, batch.id, batch.projectContext!, [workerA, workerB], async (_store, currentBatchId, runId, _projectContext, options) => {
    calls.push({ runId, options });
    store.updateRun(currentBatchId, runId, (run) => {
      run.status = "completed";
      run.worktreePath = `/repo/worktrees/${runId}`;
      run.workingDirectory = `/repo/worktrees/${runId}/project`;
      run.finalResponse = `response for ${runId}`;
      run.error = null;
      run.turns[0].status = "completed";
      run.turns[0].completedAt = "2026-01-01T00:00:05.000Z";
      run.turns[0].finalResponse = run.finalResponse;
      run.turns[0].items = [{
        id: `item-${runId}`,
        type: "mcp_tool_call",
        server: "agents-runner-workflow",
        tool: "submit_result",
        status: "completed",
        result: {
          structured_content: {
            workingFolder: `/repo/worktrees/${runId}`,
            runId,
            files: [
              {
                path: `project/src/${runId}.ts`,
                explanation: `Final implementation for ${runId}.`,
              },
            ],
          },
        },
      }];
    });
  });

  expect(calls).toHaveLength(3);
  expect(calls[0]?.runId).toBe("run-1");
  expect(calls[1]?.runId).toBe("run-2");
  expect(calls[0]?.options?.developerInstructions).toBe(
    "Submit your final results exactly once with `agents-runner-workflow.submit_result`.",
  );
  expect(calls[1]?.options?.developerInstructions).toBe(
    "Submit your final results exactly once with `agents-runner-workflow.submit_result`.",
  );
  expect(calls[2]?.options?.sandboxModeOverride).toBe("read-only");
  expect(calls[2]?.options?.workingDirectoryOverride).toBe("/repo/project");
  expect(calls[2]?.options?.developerInstructions).toBeUndefined();
  expect(calls[2]?.options?.additionalDirectoriesOverride).toEqual([
    "/repo/worktrees/run-1",
    "/repo/worktrees/run-2",
  ]);
  expect(calls[2]?.options?.promptOverride).toContain("```xml");
  expect(calls[2]?.options?.promptOverride).toContain("<workers>");
  expect(calls[2]?.options?.promptOverride).toContain(`<worker id="run-1" title="Worker 1" status="completed">`);
  expect(calls[2]?.options?.promptOverride).toContain('<submittedFiles status="submitted">');
  expect(calls[2]?.options?.promptOverride).toContain('<file path="/repo/worktrees/run-1/project/src/run-1.ts">');
  expect(calls[2]?.options?.promptOverride).toContain("response for run-1");
  expect(calls[2]?.options?.promptOverride).toContain("response for run-2");
  expect(calls[2]?.options?.promptOverride).toContain("Original Tasks:");

  const updatedBatch = store.getBatch(batch.id)!;
  expect(updatedBatch.runs.find((run) => run.kind === "validator")?.title).toBe("Validator");
});

test("validated workflow fails completed workers that do not submit exactly one result", async () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 1,
  });
  const worker = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "queued" });
  worker.title = "Worker 1";
  batch.runs = [worker];
  const store = buildMockStore(batch);

  await wf.executeBatchRuns(store, batch.id, batch.projectContext!, [worker], async (_store, currentBatchId, runId) => {
    store.updateRun(currentBatchId, runId, (run) => {
      run.status = "completed";
      run.worktreePath = `/repo/worktrees/${runId}`;
      run.workingDirectory = `/repo/worktrees/${runId}/project`;
      run.finalResponse = "done";
      run.turns[0].status = "completed";
      run.turns[0].completedAt = "2026-01-01T00:00:05.000Z";
      run.turns[0].finalResponse = "done";
      run.turns[0].items = [];
    });
  });

  const updatedWorker = store.getBatch(batch.id)!.runs.find((run) => run.id === "run-1");
  expect(updatedWorker?.status).toBe("failed");
  expect(updatedWorker?.error).toContain("submit_result");

  const validator = store.getBatch(batch.id)!.runs.find((run) => run.kind === "validator");
  expect(validator?.prompt).toContain('<submittedFiles status="missing">');
});

test("validated workflow cancels queued validator when batch is cancelled before validation", async () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 1,
  });
  const worker = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "queued" });
  worker.title = "Worker 1";
  batch.runs = [worker];
  const store = buildMockStore(batch);
  let executeCount = 0;

  await wf.executeBatchRuns(store, batch.id, batch.projectContext!, [worker], async (_store, currentBatchId, runId) => {
    executeCount += 1;
    store.updateRun(currentBatchId, runId, (run) => {
      run.status = "completed";
      run.worktreePath = `/repo/worktrees/${runId}`;
      run.workingDirectory = `/repo/worktrees/${runId}/project`;
      run.turns[0].status = "completed";
    });
    store.updateBatch(currentBatchId, (mutableBatch) => {
      mutableBatch.cancelRequested = true;
    });
  });

  expect(executeCount).toBe(1);
  const validator = store.getBatch(batch.id)!.runs.find((run) => run.kind === "validator");
  expect(validator?.status).toBe("cancelled");
  expect(validator?.error).toBe("Batch cancelled before validation start.");
});
