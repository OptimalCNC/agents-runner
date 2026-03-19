import { getBundledMcpStatus } from "../codexMcp";
import type { Batch, BatchStore, GenerationTask, ProjectContext, Run } from "../../types";
import { buildRunRecord } from "../runner";
import type { WorkflowDefinition } from "./types";
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

  async createAdditionalRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
  ): Promise<Run[]> {
    const batch = store.getBatch(batchId)!;
    return [buildRunRecord(buildValidatorTask(batch), candidateRuns.length, "validator")];
  },

  reconcileLifecycle(store, batchId) {
    const batch = store.getBatch(batchId);
    if (!batch || batch.mode !== "validated") {
      return;
    }

    for (const workerRun of listWorkerRuns(batch)) {
      enforceWorkerSubmission(store, batchId, workerRun.id);
    }
  },

  isRunReady(batch, run) {
    if (run.kind !== "validator") {
      return true;
    }

    const workerRuns = listWorkerRuns(batch);
    return workerRuns.length > 0
      && workerRuns.every((entry) => entry.status === "completed" || entry.status === "cancelled");
  },

  getRunExecutionOptions(batch, run, projectContext) {
    if (run.kind !== "validator") {
      return {
        autoCreateBranch: false,
        developerInstructions: buildWorkerDeveloperInstructions(),
      };
    }

    const workerRuns = listWorkerRuns(batch);
    return {
      promptOverride: buildValidatorPrompt(batch, workerRuns),
      sandboxModeOverride: "read-only",
      workingDirectoryOverride: projectContext.projectPath,
      additionalDirectoriesOverride: collectValidatorDirectories(workerRuns),
    };
  },

  getBlockingRunIds(batch) {
    return batch.runs
      .filter((run) => run.status === "failed")
      .map((run) => run.id);
  },

  getRerunResetRunIds(batch, runId) {
    const run = batch.runs.find((entry) => entry.id === runId);
    if (!run) {
      return [];
    }

    if (run.kind === "validator") {
      return [runId];
    }

    const validatorRun = batch.runs.find((entry) => entry.kind === "validator");
    return validatorRun ? [runId, validatorRun.id] : [runId];
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
