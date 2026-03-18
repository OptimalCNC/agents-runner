import type { Batch, BatchStore, GenerationTask, ProjectContext, Run } from "../../types";
import { finalizeQueuedRun, runWithConcurrency } from "../runner";
import type { ExecuteRunFn, WorkflowDefinition } from "./types";

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

  async executeBatchRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
    executeRunFn: ExecuteRunFn,
  ): Promise<void> {
    const batch = store.getBatch(batchId)!;

    await runWithConcurrency(candidateRuns, batch.config.concurrency, async (run) => {
      const mutableBatch = store.getMutableBatch(batchId);
      if (!mutableBatch || mutableBatch.cancelRequested) {
        finalizeQueuedRun(store, batchId, run.id, "cancelled", "Batch cancelled before start.");
        return;
      }

      await executeRunFn(store, batchId, run.id, projectContext, { autoCreateBranch: false });
    });
  },

  onScoreSubmitted() {},
  onBatchSettled() {},
};
