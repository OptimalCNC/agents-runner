import type { Batch, BatchStore, GenerationTask, Run } from "../../types";
import type { WorkflowDefinition } from "./types";

export const repeatedWorkflow: WorkflowDefinition = {
  mode: "repeated",
  label: "Repeated",

  validatePayload({ prompt }) {
    if (!prompt) {
      throw new Error("Prompt is required for Repeated mode.");
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
      title: `Run ${index + 1}`,
      prompt: batch.config.prompt,
    }));
  },

  async createAdditionalRuns(): Promise<Run[]> {
    return [];
  },

  reconcileLifecycle() {},

  isRunReady(_batch, run) {
    return run.kind !== "reviewer" && run.kind !== "validator";
  },

  getRunExecutionOptions() {
    return { autoCreateBranch: false };
  },

  getBlockingRunIds() {
    return [];
  },

  getRerunResetRunIds(_batch, runId) {
    return [runId];
  },

  onScoreSubmitted() {},
  onBatchSettled() {},
};
