import type { Batch, BatchMode, BatchStore, GenerationState, GenerationTask, ProjectContext, Run } from "../../types";

export type ExecuteRunFn = (
  store: BatchStore,
  batchId: string,
  runId: string,
  projectContext: ProjectContext,
  options?: {
    promptOverride?: string;
    sandboxModeOverride?: "workspace-write" | "read-only" | "danger-full-access";
    workingDirectoryOverride?: string;
    autoCreateBranch?: boolean;
    developerInstructions?: string;
  },
) => Promise<void>;

export interface WorkflowDefinition {
  mode: BatchMode;
  label: string;

  validatePayload(p: { prompt: string; taskPrompt: string; reviewPrompt: string }): void;
  getMaxConcurrency(runCount: number, reviewCount: number): number;
  buildInitialBatchState(): { generation: GenerationState | null };
  getTitleSourcePrompt(batch: Batch): string;

  createTasks(store: BatchStore, batchId: string, projectContext: ProjectContext): Promise<GenerationTask[]>;
  executeBatchRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
    executeRunFn: ExecuteRunFn,
  ): Promise<void>;

  onScoreSubmitted(store: BatchStore, batchId: string): void;
  onBatchSettled(store: BatchStore, batchId: string): void;

  preCreateCheck?(port: number): Promise<{ ok: boolean; error: string }>;
}
