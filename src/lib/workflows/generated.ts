import { isAbortError } from "../process";
import { finalizeQueuedRun, getCodexClient, getExecutionState, maybeClearExecutionState, runWithConcurrency } from "../runner";
import type { Batch, BatchStore, GenerationTask, ProjectContext, Run } from "../../types";
import type { ExecuteRunFn, WorkflowDefinition } from "./types";

const NON_INTERACTIVE_APPROVAL_POLICY = "never" as const;

function nowIso(): string {
  return new Date().toISOString();
}

export function buildTaskSchema(count: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "prompt"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            prompt: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}

export function buildTaskGenerationPrompt(userPrompt: string, count: number): string {
  return [
    userPrompt.trim(),
    "",
    `Generate exactly ${count} coding tasks for parallel Codex execution.`,
    "Each task will run in its own git worktree cloned from the same repository state.",
    "Prefer tasks that do not overlap heavily in files or responsibilities.",
    "Each prompt must be self-contained, concrete, and directly runnable by an autonomous coding agent.",
    'Return only JSON that matches the provided schema with a top-level "tasks" array.',
  ].join("\n");
}

async function generateTasks(store: BatchStore, batchId: string, projectContext: ProjectContext): Promise<GenerationTask[]> {
  const batch = store.getBatch(batchId)!;
  const execution = getExecutionState(batchId);
  const controller = new AbortController();
  execution.generationController = controller;

  store.updateBatch(batchId, (mutableBatch) => {
    mutableBatch.generation!.status = "running";
    mutableBatch.generation!.startedAt = nowIso();
    mutableBatch.generation!.error = null;
  });

  try {
    const codex = getCodexClient();
    const thread = codex.startThread({
      model: batch.config.model || undefined,
      sandboxMode: batch.config.sandboxMode as "workspace-write" | "read-only" | "danger-full-access",
      approvalPolicy: NON_INTERACTIVE_APPROVAL_POLICY,
      workingDirectory: projectContext.projectPath,
      networkAccessEnabled: batch.config.networkAccessEnabled,
      webSearchEnabled: batch.config.webSearchMode !== "disabled",
      webSearchMode: batch.config.webSearchMode as "disabled" | "live",
      modelReasoningEffort: (batch.config.reasoningEffort || undefined) as "low" | "medium" | "high" | undefined,
    });

    const result = await thread.run(buildTaskGenerationPrompt(batch.config.taskPrompt, batch.config.runCount), {
      signal: controller.signal,
      outputSchema: buildTaskSchema(batch.config.runCount),
    });

    const parsed = JSON.parse(result.finalResponse) as { tasks: Array<{ title?: string; prompt: string }> };
    const tasks: GenerationTask[] = parsed.tasks.map((task, index) => ({
      title: task.title || `Task ${index + 1}`,
      prompt: task.prompt,
    }));

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation!.status = "completed";
      mutableBatch.generation!.completedAt = nowIso();
      mutableBatch.generation!.tasks = tasks;
    });

    return tasks;
  } catch (error) {
    const message = isAbortError(error) ? "Task generation cancelled." : (error as Error).message;

    store.updateBatch(batchId, (mutableBatch) => {
      mutableBatch.generation!.status = isAbortError(error) ? "cancelled" : "failed";
      mutableBatch.generation!.completedAt = nowIso();
      mutableBatch.generation!.error = message;
      mutableBatch.error = message;
    });

    throw error;
  } finally {
    execution.generationController = null;
    maybeClearExecutionState(batchId, execution);
  }
}

export const generatedWorkflow: WorkflowDefinition = {
  mode: "generated",
  label: "Generated",

  validatePayload({ taskPrompt }) {
    if (!taskPrompt) {
      throw new Error("Task generation prompt is required for Generated mode.");
    }
  },

  getMaxConcurrency(runCount) {
    return runCount;
  },

  buildInitialBatchState() {
    return {
      generation: {
        status: "pending",
        startedAt: null,
        completedAt: null,
        error: null,
        tasks: [],
      },
    };
  },

  getTitleSourcePrompt(batch: Batch) {
    return batch.config.taskPrompt;
  },

  async createTasks(store: BatchStore, batchId: string, projectContext: ProjectContext): Promise<GenerationTask[]> {
    return generateTasks(store, batchId, projectContext);
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
