import { getBundledMcpStatus } from "../codexMcp";
import type { Batch, BatchStore, GenerationTask, ProjectContext, Run } from "../../types";
import { buildRunRecord, finalizeQueuedRun, runWithConcurrency } from "../runner";
import type { ExecuteRunFn, WorkflowDefinition } from "./types";
import { listWorkerResultSubmissionsFromMcp } from "./shared";
import {
  buildValidatorPrompt,
  collectValidatorDirectories,
} from "./validatedPrompt";

function listWorkerRuns(batch: Batch): Run[] {
  return batch.runs
    .filter((run) => run.kind === "candidate")
    .sort((left, right) => left.index - right.index);
}

function buildValidatorTask(batch: Batch): GenerationTask {
  return {
    title: "Validator",
    prompt: batch.config.reviewPrompt,
  };
}

function buildWorkerDeveloperInstructions(): string {
  return [
    "Submit your final results exactly once with `agents-runner-workflow.submit_result`.",
    "These submitted results will be validated by a validator, which validates the results rather than the implementation code.",
  ].join(" ");
}

function enforceWorkerSubmission(store: BatchStore, batchId: string, runId: string): void {
  const run = store.getBatch(batchId)?.runs.find((entry) => entry.id === runId);
  if (!run || run.kind !== "candidate" || run.status !== "completed") {
    return;
  }

  const submissionCount = listWorkerResultSubmissionsFromMcp(run).length;
  if (submissionCount === 1) {
    return;
  }

  const error = submissionCount === 0
    ? "Validated workers must submit exactly one result with agents-runner-workflow.submit_result."
    : `Validated workers must submit exactly one result with agents-runner-workflow.submit_result. Found ${submissionCount}.`;

  store.updateRun(batchId, runId, (mutableRun) => {
    const turn = mutableRun.turns.at(-1);
    if (turn) {
      turn.status = "failed";
      turn.completedAt ||= mutableRun.completedAt;
      turn.error = error;
    }
    mutableRun.status = "failed";
    mutableRun.completedAt ||= turn?.completedAt ?? mutableRun.completedAt;
    mutableRun.error = error;
  });
}

async function executeValidatorRun(
  store: BatchStore,
  batchId: string,
  projectContext: ProjectContext,
  executeRunFn: ExecuteRunFn,
): Promise<void> {
  const batch = store.getMutableBatch(batchId);
  if (!batch) {
    return;
  }

  const validatorRun = batch.runs.find((run) => run.kind === "validator");
  if (!validatorRun || validatorRun.status !== "queued") {
    return;
  }

  if (batch.cancelRequested) {
    finalizeQueuedRun(store, batchId, validatorRun.id, "cancelled", "Batch cancelled before validation start.");
    return;
  }

  const workerRuns = listWorkerRuns(batch);
  const prompt = buildValidatorPrompt(batch, workerRuns);
  const additionalDirectories = collectValidatorDirectories(workerRuns);

  store.updateRun(batchId, validatorRun.id, (run) => {
    run.prompt = prompt;
    const turn = run.turns[0];
    if (turn && turn.status === "queued") {
      turn.prompt = prompt;
    }
  });

  await executeRunFn(store, batchId, validatorRun.id, projectContext, {
    promptOverride: prompt,
    sandboxModeOverride: "read-only",
    workingDirectoryOverride: projectContext.projectPath,
    additionalDirectoriesOverride: additionalDirectories,
  });
}

export const validatedWorkflow: WorkflowDefinition = {
  mode: "validated",
  label: "Validated",

  validatePayload({ prompt, reviewPrompt }) {
    if (!prompt) {
      throw new Error("Prompt is required for Validated mode.");
    }
    if (!reviewPrompt) {
      throw new Error("Checker prompt is required for Validated mode.");
    }
  },

  getMaxConcurrency(runCount) {
    return runCount;
  },

  buildInitialBatchState() {
    return { generation: null };
  },

  getTitleSourcePrompt(batch: Batch) {
    return batch.config.prompt;
  },

  async createTasks(store: BatchStore, batchId: string): Promise<GenerationTask[]> {
    const batch = store.getBatch(batchId)!;
    return Array.from({ length: batch.config.runCount }, (_, index) => ({
      title: `Worker ${index + 1}`,
      prompt: batch.config.prompt,
    }));
  },

  async executeBatchRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
    executeRunFn: ExecuteRunFn,
  ): Promise<void> {
    const batch = store.getBatch(batchId)!;
    const validatorRun = buildRunRecord(buildValidatorTask(batch), candidateRuns.length, "validator");
    store.appendRun(batchId, validatorRun);

    await runWithConcurrency(candidateRuns, batch.config.concurrency, async (run) => {
      const mutableBatch = store.getMutableBatch(batchId);
      if (!mutableBatch || mutableBatch.cancelRequested) {
        finalizeQueuedRun(store, batchId, run.id, "cancelled", "Batch cancelled before start.");
        return;
      }

      await executeRunFn(store, batchId, run.id, projectContext, {
        autoCreateBranch: false,
        developerInstructions: buildWorkerDeveloperInstructions(),
      });
      enforceWorkerSubmission(store, batchId, run.id);
    });

    await executeValidatorRun(store, batchId, projectContext, executeRunFn);
  },

  onScoreSubmitted() {},
  onBatchSettled() {},

  async preCreateCheck(port: number) {
    const mcpStatus = await getBundledMcpStatus(port);
    if (!mcpStatus.healthy) {
      return {
        ok: false,
        error: "Validated workflow requires bundled MCP tools. Open Settings and install/repair the Agents Runner MCP server first.",
      };
    }
    return { ok: true, error: "" };
  },
};
