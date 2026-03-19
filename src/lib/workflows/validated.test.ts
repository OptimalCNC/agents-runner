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

test("validated workflow creates a validator run after workers", async () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 2,
  });
  const workerA = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "queued" });
  const workerB = buildMockRun({ id: "run-2", index: 1, kind: "candidate", status: "queued" });
  const store = buildMockStore(batch);

  const [validatorRun] = await wf.createAdditionalRuns(store, batch.id, batch.projectContext!, [workerA, workerB]);

  expect(validatorRun?.kind).toBe("validator");
  expect(validatorRun?.title).toBe("Validator");
  expect(validatorRun?.prompt).toBe("Validate everything.");
});

test("validated workflow builds validator execution options from worker outputs", () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 2,
  });
  const workerA = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "completed" });
  workerA.title = "Worker 1";
  workerA.worktreePath = "/repo/worktrees/run-1";
  workerA.workingDirectory = "/repo/worktrees/run-1/project";
  workerA.finalResponse = "response for run-1";
  workerA.turns[0].status = "completed";
  workerA.turns[0].items = [{
    id: "item-run-1",
    type: "mcp_tool_call",
    server: "agents-runner-workflow",
    tool: "submit_result",
    status: "completed",
    result: {
      structured_content: {
        workingFolder: "/repo/worktrees/run-1",
        runId: "run-1",
        files: [{ path: "project/src/run-1.ts", explanation: "Final implementation for run-1." }],
      },
    },
  }];
  const workerB = buildMockRun({ id: "run-2", index: 1, kind: "candidate", status: "completed" });
  workerB.title = "Worker 2";
  workerB.worktreePath = "/repo/worktrees/run-2";
  workerB.workingDirectory = "/repo/worktrees/run-2/project";
  workerB.finalResponse = "response for run-2";
  workerB.turns[0].status = "completed";
  workerB.turns[0].items = [{
    id: "item-run-2",
    type: "mcp_tool_call",
    server: "agents-runner-workflow",
    tool: "submit_result",
    status: "completed",
    result: {
      structured_content: {
        workingFolder: "/repo/worktrees/run-2",
        runId: "run-2",
        files: [{ path: "project/src/run-2.ts", explanation: "Final implementation for run-2." }],
      },
    },
  }];
  const validator = buildMockRun({ id: "run-3", index: 2, kind: "validator", status: "queued" });
  batch.runs = [workerA, workerB, validator];

  const options = wf.getRunExecutionOptions(batch, validator, batch.projectContext!);

  expect(options.sandboxModeOverride).toBe("read-only");
  expect(options.workingDirectoryOverride).toBe("/repo/project");
  expect(options.additionalDirectoriesOverride).toEqual([
    "/repo/worktrees/run-1",
    "/repo/worktrees/run-2",
  ]);
  expect(options.promptOverride).toContain("```xml");
  expect(options.promptOverride).toContain("<workers>");
  expect(options.promptOverride).toContain(`<worker id="run-1" title="Worker 1" status="completed">`);
  expect(options.promptOverride).toContain('<submittedFiles status="submitted">');
  expect(options.promptOverride).toContain('<file path="/repo/worktrees/run-1/project/src/run-1.ts">');
  expect(options.promptOverride).toContain("response for run-1");
  expect(options.promptOverride).toContain("response for run-2");
  expect(options.promptOverride).toContain("Original Tasks:");
});

test("validated workflow fails completed workers that do not submit exactly one result", () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 1,
  });
  const worker = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "completed" });
  worker.title = "Worker 1";
  batch.runs = [worker];
  const store = buildMockStore(batch);

  wf.reconcileLifecycle(store, batch.id);

  const updatedWorker = store.getBatch(batch.id)!.runs.find((run) => run.id === "run-1");
  expect(updatedWorker?.status).toBe("failed");
  expect(updatedWorker?.error).toContain("submit_result");
});

test("validated workflow blocks validator until workers are resolved", () => {
  const batch = buildMockBatch({
    mode: "validated",
    prompt: "Implement the task.",
    reviewPrompt: "Validate everything.",
    runCount: 1,
  });
  const worker = buildMockRun({ id: "run-1", index: 0, kind: "candidate", status: "failed" });
  const validator = buildMockRun({ id: "run-2", index: 1, kind: "validator", status: "queued" });
  batch.runs = [worker, validator];

  expect(wf.isRunReady(batch, validator)).toBe(false);
  expect(wf.getBlockingRunIds(batch)).toEqual(["run-1"]);
  expect(wf.getRerunResetRunIds(batch, "run-1")).toEqual(["run-1", "run-2"]);
});
